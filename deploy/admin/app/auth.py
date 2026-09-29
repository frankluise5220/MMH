#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""登录态：口令 -> 签名 cookie，并支持在 UI 里改口令。

口令来源（后者优先）
    1. 环境变量 ADMIN_TOKEN      —— 出厂/首次部署用，写在 .env
    2. DATA_DIR/admin-token      —— UI 改过口令后以这份为准

为什么改口令要落文件而不是改 .env
    .env 没有挂进容器（只 `env_file` 注入），容器里改不了它；而且改完还得重启
    容器才生效。DATA_DIR 是 rw 挂载的，写文件 + 在进程内重建签名密钥即可，
    不用重启，也不会因为重启把没落盘的状态弄丢。

cookie 值 = `<过期时间戳>.<HMAC-SHA256 前 32 字节 hex>`，
签名密钥 = HMAC(口令, 本地随机盐)。盐存在 DATA_DIR/session.key，
所以**换口令会自动让所有旧会话失效**，不用手工清 cookie。

忘了口令怎么办
    删掉 DATA_DIR/admin-token 再重启容器，就回落到 .env 里的 ADMIN_TOKEN。
"""

import hashlib
import hmac
import os
import secrets
import time

COOKIE_NAME = "mmh_admin_session"

TOKEN_MIN = 16
TOKEN_MAX = 128

_instance = None


def set_instance(a):
    global _instance
    _instance = a


def get_instance():
    return _instance


def validate_token(t):
    """返回错误信息字符串；合法则返回 None。"""
    if not isinstance(t, str):
        return "口令必须是字符串"
    if len(t) < TOKEN_MIN:
        return "口令至少 %d 位（当前 %d 位）" % (TOKEN_MIN, len(t))
    if len(t) > TOKEN_MAX:
        return "口令最多 %d 位（当前 %d 位）" % (TOKEN_MAX, len(t))
    if t != t.strip():
        return "口令首尾不能有空白字符"
    if any(c.isspace() for c in t):
        return "口令不能包含空格/制表符/换行"
    return None


def _atomic_write(path, content, mode=0o600):
    """先写临时文件再 replace，避免写到一半被读到。"""
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


class Auth:
    def __init__(self, env_token, data_dir, ttl=7 * 24 * 3600):
        self.env_token = (env_token or "").strip()
        self.ttl = int(ttl)
        self.data_dir = data_dir
        self.token_path = os.path.join(data_dir, "admin-token")
        self._salt_path = os.path.join(data_dir, "session.key")
        os.makedirs(data_dir, exist_ok=True)
        self._salt = self._load_or_create_salt()
        self._reload()

    # -- 内部 --------------------------------------------------------
    def _load_or_create_salt(self):
        if os.path.exists(self._salt_path):
            with open(self._salt_path, "r", encoding="utf-8") as f:
                s = f.read().strip()
            if s:
                return s
        s = secrets.token_hex(32)
        # 先创建后写，避免短暂出现 0644
        fd = os.open(self._salt_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(s)
        return s

    def _read_token_file(self):
        if not os.path.exists(self.token_path):
            return ""
        try:
            with open(self.token_path, "r", encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return ""

    def _reload(self):
        """重新解析口令来源并重建签名密钥。"""
        file_token = self._read_token_file()
        if file_token:
            self.token, self.source = file_token, "file"
        elif self.env_token:
            self.token, self.source = self.env_token, "env"
        else:
            self.token, self.source = "", "none"

        if not self.token:
            raise RuntimeError(
                "既没有 %s，也没有 ADMIN_TOKEN 环境变量——无法启动。" % self.token_path)
        err = validate_token(self.token)
        if err:
            raise RuntimeError("当前口令不合法：%s" % err)

        self._secret = hmac.new(
            self._salt.encode(), self.token.encode("utf-8"), hashlib.sha256
        ).digest()

    def _sign(self, expires):
        msg = str(expires).encode()
        return hmac.new(self._secret, msg, hashlib.sha256).hexdigest()[:32]

    # -- 对外 --------------------------------------------------------
    def check_password(self, token):
        """常数时间比较，避免时序侧信道。"""
        if not token:
            return False
        return hmac.compare_digest(str(token).encode(), self.token.encode())

    def issue(self):
        """返回 (cookie_value, max_age)。"""
        expires = int(time.time()) + self.ttl
        return "%d.%s" % (expires, self._sign(expires)), self.ttl

    def verify(self, cookie_value):
        """校验 cookie；返回 True/False。"""
        if not cookie_value or "." not in cookie_value:
            return False
        exp_s, sig = cookie_value.split(".", 1)
        try:
            expires = int(exp_s)
        except ValueError:
            return False
        if expires < time.time():
            return False
        return hmac.compare_digest(sig, self._sign(expires))

    def cookie_header(self, value, max_age):
        return ("%s=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Lax"
                % (COOKIE_NAME, value, max_age))

    # -- 改口令 ------------------------------------------------------
    def set_token(self, new_token):
        """落盘并重建签名密钥（旧会话立即全部失效）。"""
        _atomic_write(self.token_path, new_token)
        self._reload()
        return self.source

    def token_changed_at(self):
        """UI 改过口令则返回那次的时间戳，否则 None。"""
        if not os.path.exists(self.token_path):
            return None
        try:
            return int(os.path.getmtime(self.token_path))
        except OSError:
            return None

    def reset_to_env(self):
        """删掉文件口令，回落到 .env。"""
        if os.path.exists(self.token_path):
            os.remove(self.token_path)
        self._reload()
        return self.source
