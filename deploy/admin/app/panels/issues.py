#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面板四：GitHub issue / PR 盯盘。

凭据：GITHUB_TOKEN_FILE（默认 /etc/mmh-admin/github-token，chmod 600）。
    文件里只放一行 token（换行可有可无）。不设环境变量，避免 token 出现在
    `docker inspect` / `ps e` / systemd unit 里。

能力
    读：仓库概览、issue/PR 列表（含标签、指派人、评论数）、单条详情 + 评论
    写：发表评论、关闭/重开、增删标签

安全
    - token 永不回传给前端；只有 token_ok / token_user 两个布尔/字符串。
    - 目标仓库受 GITHUB_ALLOWED_REPOS 白名单约束，防止 token 被拿去改别的仓库。
    - 所有写操作走 audit。
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

import audit
import config
from api import ApiError, route

_UA = "mmh-admin/%s" % config.APP_VERSION
_token_cache = {"mtime": None, "value": ""}


# ---------------------------------------------------------------- token
def token():
    path = config.GITHUB_TOKEN_FILE
    if not os.path.exists(path):
        return ""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return ""
    if _token_cache["mtime"] != mtime:
        with open(path, "r", encoding="utf-8") as f:
            _token_cache["value"] = f.read().strip()
        _token_cache["mtime"] = mtime
    return _token_cache["value"]


def token_status():
    t = token()
    if not t:
        return {"present": False, "kind": "", "path": config.GITHUB_TOKEN_FILE}
    kind = "fine-grained" if t.startswith("github_pat_") else (
        "classic/oauth" if t.startswith(("ghp_", "gho_", "ghu_", "ghs_")) else "unknown")
    return {"present": True, "kind": kind, "len": len(t),
            "path": config.GITHUB_TOKEN_FILE}


# ---------------------------------------------------------------- HTTP
def _api(method, path, payload=None, repo=None):
    repo = repo or config.GITHUB_REPO
    if repo not in config.GITHUB_ALLOWED_REPOS:
        raise ApiError(403, "仓库不在白名单内：%s" % repo)

    url = "%s/repos/%s%s" % (config.GITHUB_API, repo, path)
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", _UA)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    t = token()
    if t:
        req.add_header("Authorization", "Bearer " + t)

    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            body = r.read().decode("utf-8", "replace")
            return json.loads(body) if body.strip() else {}, dict(r.headers)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:400]
        except Exception:
            pass
        if e.code == 401:
            raise ApiError(502, "GitHub 401：token 无效或已过期")
        if e.code == 403:
            remaining = e.headers.get("X-RateLimit-Remaining")
            if remaining == "0":
                raise ApiError(502, "GitHub 速率限制已用尽，请稍后重试")
            raise ApiError(502, "GitHub 403：权限不足或禁止访问（%s）" % detail)
        if e.code == 404:
            raise ApiError(404, "GitHub 404：仓库或对象不存在（%s）" % config.GITHUB_REPO)
        raise ApiError(502, "GitHub %d：%s" % (e.code, detail))
    except urllib.error.URLError as e:
        raise ApiError(502, "无法连接 GitHub：%s" % e.reason)


def _slim(issue):
    """裁掉大字段，列表页只需要这些。"""
    return {
        "number": issue.get("number"),
        "title": issue.get("title"),
        "state": issue.get("state"),
        "state_reason": issue.get("state_reason"),
        "is_pr": "pull_request" in issue,
        "draft": (issue.get("pull_request") or {}).get("draft", False),
        "user": (issue.get("user") or {}).get("login"),
        "avatar": (issue.get("user") or {}).get("avatar_url"),
        "labels": [{"name": l.get("name"), "color": l.get("color")}
                   for l in (issue.get("labels") or [])],
        "comments": issue.get("comments", 0),
        "created_at": issue.get("created_at"),
        "updated_at": issue.get("updated_at"),
        "closed_at": issue.get("closed_at"),
        "html_url": issue.get("html_url"),
        "assignees": [a.get("login") for a in (issue.get("assignees") or [])],
        "body": (issue.get("body") or "")[:600],
    }


# ---------------------------------------------------------------- 读
@route("GET", "/api/issues/status")
def issues_status(ctx):
    """不碰仓库，只报告凭据与配置状态。"""
    return {"repo": config.GITHUB_REPO, "allowed_repos": config.GITHUB_ALLOWED_REPOS,
            "token": token_status()}


@route("GET", "/api/issues/repo")
def issues_repo(ctx):
    data, headers = _api("GET", "")
    return {
        "full_name": data.get("full_name"),
        "description": data.get("description"),
        "private": data.get("private"),
        "stars": data.get("stargazers_count"),
        "forks": data.get("forks_count"),
        "open_issues": data.get("open_issues_count"),
        "default_branch": data.get("default_branch"),
        "pushed_at": data.get("pushed_at"),
        "html_url": data.get("html_url"),
        "token": token_status(),
        "rate_remaining": headers.get("X-RateLimit-Remaining"),
        "rate_limit": headers.get("X-RateLimit-Limit"),
    }


@route("GET", "/api/issues/list")
def issues_list(ctx):
    state = ctx.q("state", "open")
    if state not in ("open", "closed", "all"):
        state = "open"
    limit = max(1, min(ctx.q_int("limit", 50), 100))
    kind = ctx.q("kind", "issue")          # issue | pr | all
    label = (ctx.q("label") or "").strip()
    q = (ctx.q("q") or "").strip()

    params = {"state": state, "per_page": str(limit), "sort": "updated",
              "direction": "desc"}
    if label:
        params["labels"] = label
    if q:
        # GitHub 的 search 端点，单独走
        return _search(state, kind, q, limit)

    path = "/issues?" + urllib.parse.urlencode(params)
    data, headers = _api("GET", path)
    items = [_slim(i) for i in data]
    if kind == "issue":
        items = [i for i in items if not i["is_pr"]]
    elif kind == "pr":
        items = [i for i in items if i["is_pr"]]

    return {"state": state, "kind": kind, "label": label, "items": items,
            "rate_remaining": headers.get("X-RateLimit-Remaining")}


def _search(state, kind, q, limit):
    """按关键字搜。GitHub 搜索只认仓库 + 类型限定符。"""
    quals = ["repo:%s" % config.GITHUB_REPO, "is:%s" % state]
    if kind == "issue":
        quals.append("is:issue")
    elif kind == "pr":
        quals.append("is:pr")
    query = " ".join(quals) + " " + q
    url = "%s/search/issues?%s" % (config.GITHUB_API,
                                   urllib.parse.urlencode({"q": query, "per_page": str(limit)}))
    req = urllib.request.Request(url, method="GET")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", _UA)
    t = token()
    if t:
        req.add_header("Authorization", "Bearer " + t)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raise ApiError(502, "GitHub 搜索失败：%d" % e.code)
    except urllib.error.URLError as e:
        raise ApiError(502, "无法连接 GitHub：%s" % e.reason)
    return {"state": state, "kind": kind, "q": q,
            "total": data.get("total_count", 0),
            "items": [_slim(i) for i in (data.get("items") or [])]}


@route("GET", "/api/issues/labels")
def issues_labels(ctx):
    data, _ = _api("GET", "/labels?per_page=100")
    return {"items": [{"name": l.get("name"), "color": l.get("color"),
                       "description": l.get("description")} for l in data]}


@route("GET", "/api/issues/<num>")
def issue_detail(ctx):
    try:
        num = int(ctx.params["num"])
    except ValueError:
        raise ApiError(400, "issue 编号非法")
    data, _ = _api("GET", "/issues/%d" % num)
    comments, _ = _api("GET", "/issues/%d/comments?per_page=100" % num)
    out = _slim(data)
    out["body"] = data.get("body") or ""
    out["comments_list"] = [{
        "id": c.get("id"),
        "user": (c.get("user") or {}).get("login"),
        "avatar": (c.get("user") or {}).get("avatar_url"),
        "created_at": c.get("created_at"),
        "updated_at": c.get("updated_at"),
        "body": c.get("body") or "",
        "author_association": c.get("author_association"),
        "html_url": c.get("html_url"),
    } for c in comments]
    return out


# ---------------------------------------------------------------- 写
@route("POST", "/api/issues/<num>/comment")
def issue_comment(ctx):
    try:
        num = int(ctx.params["num"])
    except ValueError:
        raise ApiError(400, "issue 编号非法")
    body = str(ctx.need("body")).strip()
    data, _ = _api("POST", "/issues/%d/comments" % num, {"body": body})
    audit.write("issue.comment", {"issue": num, "len": len(body),
                                  "comment_id": data.get("id"),
                                  "url": data.get("html_url")}, ip=ctx.client_ip)
    return {"issue": num, "comment_id": data.get("id"), "html_url": data.get("html_url")}


@route("POST", "/api/issues/<num>/state")
def issue_state(ctx):
    try:
        num = int(ctx.params["num"])
    except ValueError:
        raise ApiError(400, "issue 编号非法")
    state = str(ctx.need("state")).strip()
    if state not in ("open", "closed"):
        raise ApiError(400, "state 只能是 open 或 closed")
    payload = {"state": state}
    reason = ctx.body.get("state_reason")
    if state == "closed" and reason in ("completed", "not_planned"):
        payload["state_reason"] = reason

    data, _ = _api("PATCH", "/issues/%d" % num, payload)
    audit.write("issue.state", {"issue": num, "state": state,
                                "title": data.get("title"),
                                "url": data.get("html_url")}, ip=ctx.client_ip)
    return {"issue": num, "state": data.get("state"),
            "state_reason": data.get("state_reason")}


@route("POST", "/api/issues/<num>/labels")
def issue_labels(ctx):
    try:
        num = int(ctx.params["num"])
    except ValueError:
        raise ApiError(400, "issue 编号非法")

    add = ctx.body.get("add") or []
    remove = ctx.body.get("remove") or []
    add = [str(x).strip() for x in add if str(x).strip()]
    remove = [str(x).strip() for x in remove if str(x).strip()]
    if not add and not remove:
        raise ApiError(400, "add / remove 至少要有一个")

    # 先删后加，避免"加已有的、删不存在的"报错
    for name in remove:
        try:
            _api("DELETE", "/issues/%d/labels/%s" % (num, urllib.parse.quote(name, safe="")))
        except ApiError as e:
            if e.status != 404:
                raise
    result = []
    if add:
        result, _ = _api("POST", "/issues/%d/labels" % num, {"labels": add})

    audit.write("issue.labels", {"issue": num, "add": add, "remove": remove,
                                 "now": [l.get("name") for l in (result or [])]},
                ip=ctx.client_ip)
    return {"issue": num, "add": add, "remove": remove,
            "labels": [l.get("name") for l in (result or [])]}
