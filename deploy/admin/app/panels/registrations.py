#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面板一：自动用户注册。

数据源：mmh-registration 的 sqlite（REG_DB）。
    principals(id, display_name, status, created_at, updated_at)
    identities(id, principal_id, provider, issuer, subject, display_name, created_at)
    installations(id, principal_id, platform, device_name, public_key, status,
                  created_at, updated_at, last_seen_at)

写入方式：直接改 sqlite。该库由 mmh-registration（Node）以 WAL 模式持有，
WAL 支持多进程"多读一写"，我们写之前 busy_timeout 8s，改完由 Node 侧下次
读取时看到。之所以不走它的 HTTP API，是因为它没有暴露任何管理接口，
为这个后台去改 Node 服务、重建镜像，代价和风险都更大。

状态语义：
    status ∈ {active, disabled}
    禁用 principal 会级联禁用其全部 installations——否则设备仍能继续工作，
    "禁用账号"就是假的。
"""

import contextlib
import os
import sqlite3
import time

import audit
import config
from api import ApiError, route

VALID_STATUS = ("active", "disabled")


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _conn():
    if not os.path.exists(config.REG_DB):
        raise ApiError(503, "注册数据库不存在：%s" % config.REG_DB)
    conn = sqlite3.connect(config.REG_DB, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=8000")
    return conn


@contextlib.contextmanager
def _db():
    """注意：sqlite3 连接本身不是上下文管理器（with conn 只提交事务、不关连接），
    这里显式关掉，避免每请求泄漏一个文件描述符。"""
    conn = _conn()
    try:
        yield conn
    finally:
        conn.close()


def _rows(conn, sql, args=()):
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def _principal_or_404(conn, pid):
    row = conn.execute("SELECT * FROM principals WHERE id=?", (pid,)).fetchone()
    if row is None:
        raise ApiError(404, "principal 不存在：%s" % pid)
    return dict(row)


# ---------------------------------------------------------------- 查询
@route("GET", "/api/registrations/overview")
def overview(ctx):
    with _db() as conn:
        def one(sql, args=()):
            return conn.execute(sql, args).fetchone()[0]

        by_provider = _rows(conn,
            "SELECT provider, COUNT(*) n FROM identities GROUP BY provider ORDER BY n DESC")
        by_platform = _rows(conn,
            "SELECT platform, COUNT(*) n FROM installations GROUP BY platform ORDER BY n DESC")
        recent = _rows(conn, """
            SELECT p.id, p.display_name, p.status, p.created_at,
                   (SELECT COUNT(*) FROM identities    i WHERE i.principal_id=p.id) n_identities,
                   (SELECT COUNT(*) FROM installations t WHERE t.principal_id=p.id) n_installations
            FROM principals p ORDER BY p.created_at DESC LIMIT 10""")
        daily = _rows(conn,
            "SELECT substr(created_at,1,10) d, COUNT(*) n FROM principals "
            "GROUP BY d ORDER BY d DESC LIMIT 30")
        totals = {
            "principals": one("SELECT COUNT(*) FROM principals"),
            "principals_active": one("SELECT COUNT(*) FROM principals WHERE status='active'"),
            "principals_disabled": one("SELECT COUNT(*) FROM principals WHERE status='disabled'"),
            "identities": one("SELECT COUNT(*) FROM identities"),
            "installations": one("SELECT COUNT(*) FROM installations"),
            "installations_active": one("SELECT COUNT(*) FROM installations WHERE status='active'"),
        }

    return {
        "db_path": config.REG_DB,
        "db_present": os.path.exists(config.REG_DB),
        "totals": totals,
        "by_provider": by_provider,
        "by_platform": by_platform,
        "recent": recent,
        "daily": daily,
    }


@route("GET", "/api/registrations/principals")
def list_principals(ctx):
    q = (ctx.q("q") or "").strip()
    status = (ctx.q("status") or "").strip()
    limit = max(1, min(ctx.q_int("limit", 200), 1000))

    where, args = [], []
    if status in VALID_STATUS:
        where.append("p.status=?")
        args.append(status)
    if q:
        # 用户名 / principal id / 身份 subject / 设备名 都能搜
        like = "%" + q + "%"
        where.append("""(
            p.display_name LIKE ? OR p.id LIKE ?
            OR EXISTS (SELECT 1 FROM identities i
                       WHERE i.principal_id=p.id AND (i.subject LIKE ? OR i.display_name LIKE ?))
            OR EXISTS (SELECT 1 FROM installations t
                       WHERE t.principal_id=p.id AND (t.device_name LIKE ? OR t.platform LIKE ?))
        )""")
        args += [like] * 6
    sql_where = ("WHERE " + " AND ".join(where)) if where else ""

    with _db() as conn:
        rows = _rows(conn, """
            SELECT p.id, p.display_name, p.status, p.created_at, p.updated_at,
                   p.last_login_at,
                   (SELECT COUNT(*) FROM identities    i WHERE i.principal_id=p.id) n_identities,
                   (SELECT COUNT(*) FROM installations t WHERE t.principal_id=p.id) n_installations,
                   (SELECT GROUP_CONCAT(provider) FROM identities i WHERE i.principal_id=p.id)
                       AS providers,
                   (SELECT MAX(last_seen_at) FROM installations t WHERE t.principal_id=p.id)
                       AS last_seen_at
            FROM principals p %s
            ORDER BY p.created_at DESC LIMIT ?""" % sql_where, args + [limit])
        total = conn.execute("SELECT COUNT(*) FROM principals").fetchone()[0]

    return {"total": total, "shown": len(rows), "items": rows}


@route("GET", "/api/registrations/principals/<pid>")
def principal_detail(ctx):
    pid = ctx.params["pid"]
    with _db() as conn:
        p = _principal_or_404(conn, pid)
        identities = _rows(conn,
            "SELECT * FROM identities WHERE principal_id=? ORDER BY created_at", (pid,))
        installations = _rows(conn,
            "SELECT * FROM installations WHERE principal_id=? ORDER BY created_at", (pid,))
    for t in installations:
        # public_key 可能很长，列表里只给指纹，详情才给全量
        t["public_key_short"] = (t.get("public_key") or "")[:24]
    return {"principal": p, "identities": identities, "installations": installations}


# ---------------------------------------------------------------- 写操作
@route("POST", "/api/registrations/principals/<pid>/status")
def set_principal_status(ctx):
    pid = ctx.params["pid"]
    status = str(ctx.need("status")).strip()
    if status not in VALID_STATUS:
        raise ApiError(400, "status 只能是 %s" % " 或 ".join(VALID_STATUS))
    now = _now()

    with _db() as conn:
        p = _principal_or_404(conn, pid)
        conn.execute("UPDATE principals SET status=?, updated_at=? WHERE id=?",
                     (status, now, pid))
        cascaded = 0
        if status == "disabled":
            cur = conn.execute(
                "UPDATE installations SET status='disabled', updated_at=? "
                "WHERE principal_id=? AND status<>'disabled'", (now, pid))
            cascaded = cur.rowcount
        conn.commit()
        installs = _rows(conn,
            "SELECT id, status FROM installations WHERE principal_id=?", (pid,))

    audit.write("registration.principal.status",
                {"principal": pid, "name": p.get("display_name"),
                 "from": p.get("status"), "to": status, "cascaded_installations": cascaded},
                ip=ctx.client_ip)
    return {"principal_id": pid, "status": status,
            "previous": p.get("status"), "cascaded_installations": cascaded,
            "installations": installs}


@route("DELETE", "/api/registrations/principals/<pid>")
def delete_principal(ctx):
    pid = ctx.params["pid"]
    with _db() as conn:
        p = _principal_or_404(conn, pid)
        n_id = conn.execute("SELECT COUNT(*) FROM identities WHERE principal_id=?",
                            (pid,)).fetchone()[0]
        n_in = conn.execute("SELECT COUNT(*) FROM installations WHERE principal_id=?",
                            (pid,)).fetchone()[0]
        # 依赖 ON DELETE CASCADE，但显式删一遍更保险（老库可能没开外键）
        conn.execute("DELETE FROM installations WHERE principal_id=?", (pid,))
        conn.execute("DELETE FROM identities WHERE principal_id=?", (pid,))
        conn.execute("DELETE FROM principals WHERE id=?", (pid,))
        conn.commit()

    audit.write("registration.principal.delete",
                {"principal": pid, "name": p.get("display_name"),
                 "identities": n_id, "installations": n_in}, ip=ctx.client_ip)
    return {"deleted": pid, "identities": n_id, "installations": n_in}


@route("POST", "/api/registrations/installations/<iid>/status")
def set_installation_status(ctx):
    iid = ctx.params["iid"]
    status = str(ctx.need("status")).strip()
    if status not in VALID_STATUS:
        raise ApiError(400, "status 只能是 %s" % " 或 ".join(VALID_STATUS))
    now = _now()
    with _db() as conn:
        row = conn.execute("SELECT * FROM installations WHERE id=?", (iid,)).fetchone()
        if row is None:
            raise ApiError(404, "installation 不存在：%s" % iid)
        old = dict(row)
        conn.execute("UPDATE installations SET status=?, updated_at=? WHERE id=?",
                     (status, now, iid))
        conn.commit()

    audit.write("registration.installation.status",
                {"installation": iid, "device": old.get("device_name"),
                 "platform": old.get("platform"), "from": old.get("status"), "to": status},
                ip=ctx.client_ip)
    return {"installation_id": iid, "status": status, "previous": old.get("status")}


@route("DELETE", "/api/registrations/installations/<iid>")
def delete_installation(ctx):
    iid = ctx.params["iid"]
    with _db() as conn:
        row = conn.execute("SELECT * FROM installations WHERE id=?", (iid,)).fetchone()
        if row is None:
            raise ApiError(404, "installation 不存在：%s" % iid)
        old = dict(row)
        conn.execute("DELETE FROM installations WHERE id=?", (iid,))
        conn.commit()

    audit.write("registration.installation.delete",
                {"installation": iid, "device": old.get("device_name"),
                 "platform": old.get("platform")}, ip=ctx.client_ip)
    return {"deleted": iid}


@route("DELETE", "/api/registrations/identities/<iid>")
def delete_identity(ctx):
    iid = ctx.params["iid"]
    with _db() as conn:
        row = conn.execute("SELECT * FROM identities WHERE id=?", (iid,)).fetchone()
        if row is None:
            raise ApiError(404, "identity 不存在：%s" % iid)
        old = dict(row)
        conn.execute("DELETE FROM identities WHERE id=?", (iid,))
        conn.commit()

    audit.write("registration.identity.delete",
                {"identity": iid, "provider": old.get("provider"),
                 "subject": old.get("subject"), "principal": old.get("principal_id")},
                ip=ctx.client_ip)
    return {"deleted": iid}
