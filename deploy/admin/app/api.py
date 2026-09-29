#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""路由注册表 + 请求上下文 + 通用异常。

面板模块（panels/*.py）用 @route 注册接口，server.py 启动时导入它们。
"""

ROUTES = {}
_PATTERNS = []          # [(method, [seg,...], fn, [param_name,...])]


def route(method, path):
    """把处理函数登记到路由表。处理函数返回 dict 即 200。

    路径支持 <name> 占位，例如 /api/x/<pid>/status，实参从 ctx.params 取。
    """
    def deco(fn):
        key = (method.upper(), path)
        if key in ROUTES:
            raise RuntimeError("路由重复注册：%s %s" % key)
        ROUTES[key] = fn
        segs = [s for s in path.strip("/").split("/") if s]
        params = [s[1:-1] for s in segs if s.startswith("<") and s.endswith(">")]
        _PATTERNS.append((method.upper(), segs, fn, params))
        return fn
    return deco


class ApiError(Exception):
    """带 HTTP 状态码的业务异常。"""

    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


class Response:
    """面板需要自定义状态码 / 响应头时返回它。

    普通面板直接返回 dict 就够了（server.py 会包成 {"ok":true,"data":{...}}）。
    只有极少数场景需要动响应头 —— 目前只有"改口令"要下发新的 Set-Cookie。
    """

    def __init__(self, data=None, status=200, headers=None):
        self.data = {} if data is None else data
        self.status = int(status)
        self.headers = list(headers or [])


class Ctx:
    """一次请求的上下文。"""

    def __init__(self, method, path, query, body, client_ip, user,
                 headers=None, params=None):
        self.method = method
        self.path = path
        self.query = query or {}          # dict[str, list[str]]
        self.body = body if isinstance(body, dict) else {}
        self.client_ip = client_ip
        self.user = user
        self.headers = headers or {}
        self.params = params or {}

    # -- 查询串便捷取值 ----------------------------------------------
    def q(self, name, default=None):
        v = self.query.get(name)
        if not v:
            return default
        return v[0]

    def q_int(self, name, default=0):
        try:
            return int(self.q(name, default))
        except (TypeError, ValueError):
            return default

    def q_bool(self, name, default=False):
        v = self.q(name)
        if v is None:
            return default
        return str(v).strip().lower() in ("1", "true", "yes", "on")

    # -- JSON body 便捷取值 ------------------------------------------
    def need(self, name):
        v = self.body.get(name)
        if v is None or (isinstance(v, str) and not v.strip()):
            raise ApiError(400, "缺少参数 %s" % name)
        return v

    def opt(self, name, default=None):
        v = self.body.get(name)
        return default if v is None else v


def dispatch(ctx):
    fn = ROUTES.get((ctx.method, ctx.path))
    if fn is not None:
        return fn(ctx)

    # 退回到带 <param> 的模板匹配
    segs = [s for s in ctx.path.strip("/").split("/") if s]
    for method, pat, handler, names in _PATTERNS:
        if method != ctx.method or len(pat) != len(segs):
            continue
        params = {}
        for p, s in zip(pat, segs):
            if p.startswith("<") and p.endswith(">"):
                params[p[1:-1]] = s
            elif p != s:
                break
        else:
            ctx.params = params
            return handler(ctx)

    raise ApiError(404, "无此接口：%s %s" % (ctx.method, ctx.path))
