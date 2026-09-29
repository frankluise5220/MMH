#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面板三：邮件盯盘。

数据源：Postfix virtual_mailbox_base（VMAIL_ROOT/<account>/Maildir/）。
    Maildir/new/  未读（文件名无 :2, 后缀）
    Maildir/cur/  已读/已处理（文件名带 :2,<flags>）
    Maildir/.Trash/cur/  回收站

写操作
    标记已读/未读   改文件名里的 flags（S 位），new <-> cur 之间搬文件
    移入回收站      rename 到 .Trash/cur/ 并加 T 位
    彻底删除        仅允许对已在 .Trash 里的邮件执行
    回复/发信       走本机 Postfix（127.0.0.1:25），由 opendkim milter 签名

安全边界
    - 文件名只允许 [A-Za-z0-9._:+-]，且必须落在 VMAIL_ROOT 内；
      消息 key 用 base64url(JSON([account,folder,name])) 编码，
      前端拿不到裸路径，杜绝 ../ 穿越。
    - 附件下载同样走 key，不直接暴露文件系统路径。
    - 单封邮件解析上限 8MB，避免一封巨型邮件把服务拖住。
"""

import base64
import email
import email.policy
import email.utils
import json
import os
import re
import smtplib
from email.message import EmailMessage
from email.parser import BytesParser
from html.parser import HTMLParser

import audit
import config
import tzutil
from api import ApiError, route

MAX_MAIL_BYTES = 8 * 1024 * 1024

# Maildir 文件名白名单。
# 必须允许 ','：Maildir 的信息后缀是 `:2,<flags>`（如 `1759...M1P1.mx:2,RS`），
# 逗号是规格的一部分。Dovecot 还会加 `,S=<size>` / `,W=<size>`，所以 '=' 也要留。
# 不含 '/'、'\\'，再加 ".." 检查，路径穿越就无从谈起。
_NAME_RE = re.compile(r"^[A-Za-z0-9._:@+=,-]+$")
# 信箱名（VMAIL_ROOT 下的一级目录）用更严的一套
_ACCOUNT_RE = re.compile(r"^[A-Za-z0-9._-]+$")

FOLDERS = {
    "new": ("new", False),
    "cur": ("cur", False),
    "trash": (os.path.join(".Trash", "cur"), True),
}


# ---------------------------------------------------------------- 路径与 key
def _account_dir(account):
    """返回 Maildir 目录；只允许 VMAIL_ROOT 下的直接子目录。"""
    if not account or not _ACCOUNT_RE.match(account) or account.startswith("."):
        raise ApiError(400, "非法信箱名：%s" % account)
    root = os.path.realpath(config.VMAIL_ROOT)
    path = os.path.realpath(os.path.join(root, account, "Maildir"))
    if not path.startswith(root + os.sep) or not os.path.isdir(path):
        raise ApiError(404, "信箱不存在：%s" % account)
    return path


def _folder_dir(account, folder):
    if folder not in FOLDERS:
        raise ApiError(400, "未知目录：%s" % folder)
    sub, _ = FOLDERS[folder]
    d = os.path.join(_account_dir(account), sub)
    if not os.path.isdir(d):
        return None
    return d


def _msg_path(account, folder, name):
    if not name or not _NAME_RE.match(name) or ".." in name:
        raise ApiError(400, "非法文件名")
    d = _folder_dir(account, folder)
    if d is None:
        raise ApiError(404, "目录不存在：%s" % folder)
    path = os.path.realpath(os.path.join(d, name))
    if not path.startswith(os.path.realpath(d) + os.sep):
        raise ApiError(400, "路径越界")
    if not os.path.isfile(path):
        raise ApiError(404, "邮件不存在")
    return path


def _key(account, folder, name):
    raw = json.dumps([account, folder, name], ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unkey(key):
    try:
        pad = "=" * (-len(key) % 4)
        raw = base64.urlsafe_b64decode(key + pad)
        parts = json.loads(raw.decode("utf-8"))
        if not isinstance(parts, list) or len(parts) != 3:
            raise ValueError
        return parts[0], parts[1], parts[2]
    except Exception:
        raise ApiError(400, "非法的邮件标识")


def accounts():
    """要盯的信箱列表。配置为空则自动发现 VMAIL_ROOT 下的信箱。"""
    if config.MAIL_ACCOUNTS:
        return [a for a in config.MAIL_ACCOUNTS if os.path.isdir(
            os.path.join(config.VMAIL_ROOT, a, "Maildir"))]
    root = config.VMAIL_ROOT
    if not os.path.isdir(root):
        return []
    return sorted(n for n in os.listdir(root)
                  if not n.startswith(".") and
                  os.path.isdir(os.path.join(root, n, "Maildir")))


# ---------------------------------------------------------------- 解析
class _Stripper(HTMLParser):
    """极简 HTML -> 文本，仅用于"只有 HTML 正文"时给出可读文本。"""

    def __init__(self):
        super().__init__()
        self.parts = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1
        elif tag in ("br", "p", "div", "tr", "li"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)

    def text(self):
        s = "".join(self.parts)
        s = re.sub(r"[ \t]+", " ", s)
        s = re.sub(r"\n{3,}", "\n\n", s)
        return s.strip()


def _decode_header(value):
    if not value:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(value)))
    except Exception:
        return str(value)


def _addr_list(value):
    out = []
    for name, addr in email.utils.getaddresses([value or ""]):
        out.append({"name": _decode_header(name), "email": addr})
    return out


def _flags(name):
    """从 Maildir 文件名取 flags 集合。"""
    if ":2," in name:
        return set(name.split(":2,", 1)[1])
    return set()


def _with_flags(name, flags):
    base = name.split(":2,", 1)[0]
    return "%s:2,%s" % (base, "".join(sorted(flags)))


def _parse_file(path, with_body=False, max_bytes=MAX_MAIL_BYTES):
    size = os.path.getsize(path)
    if size > max_bytes:
        raise ApiError(413, "邮件超过 %d 字节，本面板不解析" % max_bytes)
    with open(path, "rb") as f:
        raw = f.read()
    msg = BytesParser(policy=email.policy.default).parsebytes(raw)

    meta = {
        "from": _addr_list(msg.get("From")),
        "to": _addr_list(msg.get("To")),
        "cc": _addr_list(msg.get("Cc")),
        "subject": _decode_header(msg.get("Subject")) or "(无主题)",
        "date": msg.get("Date") or "",
        "date_ts": None,
        "message_id": (msg.get("Message-ID") or "").strip(),
        "in_reply_to": (msg.get("In-Reply-To") or "").strip(),
        "references": (msg.get("References") or "").strip(),
        "return_path": (msg.get("Return-Path") or "").strip(),
        "list_unsubscribe": msg.get("List-Unsubscribe") or "",
        "size": size,
        "attachments": [],
    }
    try:
        dt = email.utils.parsedate_to_datetime(meta["date"])
        if dt is not None:
            meta["date_ts"] = int(dt.timestamp())
    except Exception:
        pass

    if not with_body:
        # 列表页只需要判断"正文预览"，取第一个 text/plain 的前 200 字
        preview = ""
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and not part.is_multipart():
                try:
                    preview = (part.get_content() or "").strip()
                except Exception:
                    preview = ""
                break
        meta["preview"] = re.sub(r"\s+", " ", preview)[:200]
        return meta

    text_parts, html_parts = [], []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        disp = (part.get_content_disposition() or "")
        filename = part.get_filename()
        if disp == "attachment" or (filename and ctype not in ("text/plain", "text/html")):
            try:
                payload = part.get_payload(decode=True) or b""
            except Exception:
                payload = b""
            meta["attachments"].append({
                "filename": _decode_header(filename) or "(未命名)",
                "content_type": ctype,
                "size": len(payload),
            })
            continue
        try:
            content = part.get_content()
        except Exception:
            content = ""
        if not isinstance(content, str):
            continue
        if ctype == "text/plain":
            text_parts.append(content)
        elif ctype == "text/html":
            html_parts.append(content)

    if text_parts:
        meta["text"] = "\n\n".join(text_parts)
        meta["html"] = ""
    elif html_parts:
        html = "\n\n".join(html_parts)
        meta["html"] = html
        p = _Stripper()
        try:
            p.feed(html)
        except Exception:
            pass
        meta["text"] = p.text()
    else:
        meta["text"] = ""
        meta["html"] = ""
    return meta


# ---------------------------------------------------------------- 概览辅助
def mail_stats():
    """给 /api/overview 用的轻量汇总：只数文件 + 解析每个信箱最新的一封。"""
    out = {"root": config.VMAIL_ROOT, "accounts": [], "new": 0, "cur": 0, "trash": 0,
           "latest_ts": 0, "latest_subject": "", "latest_from": "", "latest_account": ""}
    for acc in accounts():
        entry = {"account": acc, "new": 0, "cur": 0, "trash": 0,
                 "latest_ts": 0, "latest_subject": "", "latest_from": ""}
        newest = None
        for folder in FOLDERS:
            d = _folder_dir(acc, folder)
            if d is None:
                continue
            try:
                names = [n for n in os.listdir(d) if os.path.isfile(os.path.join(d, n))]
            except OSError:
                continue
            entry[folder] = len(names)
            for n in names:
                p = os.path.join(d, n)
                try:
                    mt = os.path.getmtime(p)
                except OSError:
                    continue
                if newest is None or mt > newest[0]:
                    newest = (mt, folder, n, p)
        if newest:
            entry["latest_ts"] = int(newest[0])
            try:
                m = _parse_file(newest[3], with_body=False)
                entry["latest_subject"] = m["subject"]
                entry["latest_from"] = (m["from"][0]["email"] if m["from"] else "")
            except Exception:
                pass
            if entry["latest_ts"] > out["latest_ts"]:
                out["latest_ts"] = entry["latest_ts"]
                out["latest_subject"] = entry["latest_subject"]
                out["latest_from"] = entry["latest_from"]
                out["latest_account"] = acc
        for k in ("new", "cur", "trash"):
            out[k] += entry[k]
        out["accounts"].append(entry)
    return out


# ---------------------------------------------------------------- 列表
@route("GET", "/api/mail/accounts")
def mail_accounts(ctx):
    out = []
    for acc in accounts():
        entry = {"account": acc, "counts": {}}
        for folder in FOLDERS:
            d = _folder_dir(acc, folder)
            n = 0
            if d:
                try:
                    n = sum(1 for f in os.listdir(d)
                            if os.path.isfile(os.path.join(d, f)))
                except OSError:
                    n = 0
            entry["counts"][folder] = n
        out.append(entry)
    return {"root": config.VMAIL_ROOT, "accounts": out}


@route("GET", "/api/mail/messages")
def mail_messages(ctx):
    account = ctx.q("account")
    folder = ctx.q("folder", "cur")
    limit = max(1, min(ctx.q_int("limit", 100), 500))
    if not account:
        accs = accounts()
        if not accs:
            return {"items": [], "accounts": []}
        account = accs[0]
    # 先做名称合法性检查（400），再查是否在监控列表（404）——
    # 否则 `../../etc` 这种畸形输入会拿到 404，把"参数非法"和"信箱不存在"混在一起。
    if not _ACCOUNT_RE.match(account) or account.startswith("."):
        raise ApiError(400, "非法信箱名：%s" % account)
    if account not in accounts():
        raise ApiError(404, "信箱不在监控列表：%s" % account)

    d = _folder_dir(account, folder)
    if d is None:
        return {"items": [], "account": account, "folder": folder}

    files = []
    for name in os.listdir(d):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            try:
                files.append((os.path.getmtime(p), name, p))
            except OSError:
                continue
    files.sort(reverse=True)
    files = files[:limit]

    items = []
    for _mtime, name, p in files:
        try:
            m = _parse_file(p, with_body=False)
        except ApiError:
            continue
        except Exception:
            continue
        m.update({
            "key": _key(account, folder, name),
            "account": account,
            "folder": folder,
            "name": name,
            "seen": "S" in _flags(name) or folder == "cur",
            "flags": "".join(sorted(_flags(name))),
        })
        items.append(m)

    return {"account": account, "folder": folder, "items": items,
            "accounts": accounts()}


@route("GET", "/api/mail/message/<key>")
def mail_message(ctx):
    account, folder, name = _unkey(ctx.params["key"])
    path = _msg_path(account, folder, name)
    m = _parse_file(path, with_body=True)
    m.update({
        "key": ctx.params["key"],
        "account": account,
        "folder": folder,
        "name": name,
        "flags": "".join(sorted(_flags(name))),
        "seen": "S" in _flags(name) or folder == "cur",
    })
    # 回复时前端需要这些
    m["reply_to"] = (m["from"][0]["email"] if m["from"] else "")
    subj = m["subject"]
    m["reply_subject"] = subj if subj.lower().startswith("re:") else "Re: " + subj
    m["reply_references"] = (m["references"] + " " + m["message_id"]).strip()
    return m


@route("GET", "/api/mail/attachment/<key>/<idx>")
def mail_attachment(ctx):
    account, folder, name = _unkey(ctx.params["key"])
    try:
        idx = int(ctx.params["idx"])
    except ValueError:
        raise ApiError(400, "附件序号非法")
    path = _msg_path(account, folder, name)
    with open(path, "rb") as f:
        raw = f.read()
    msg = BytesParser(policy=email.policy.default).parsebytes(raw)
    n = 0
    for part in msg.walk():
        if part.is_multipart():
            continue
        filename = part.get_filename()
        ctype = part.get_content_type()
        if not (part.get_content_disposition() == "attachment" or
                (filename and ctype not in ("text/plain", "text/html"))):
            continue
        if n == idx:
            payload = part.get_payload(decode=True) or b""
            # 前端用 atob -> Blob 自己拼下载链接，服务端不必特殊处理二进制响应
            return {"filename": _decode_header(filename) or "attachment",
                    "content_type": ctype,
                    "size": len(payload),
                    "data_b64": base64.b64encode(payload).decode("ascii")}
        n += 1
    raise ApiError(404, "附件不存在")


# ---------------------------------------------------------------- 写操作
def _rename_with_flags(account, folder, name, add=(), remove=()):
    """就地改 flags（只对 cur/ 有效）。返回新文件名。"""
    path = _msg_path(account, folder, name)
    flags = _flags(name)
    flags |= set(add)
    flags -= set(remove)
    new_name = _with_flags(name, flags)
    if new_name != name:
        os.rename(path, os.path.join(os.path.dirname(path), new_name))
    return new_name


@route("POST", "/api/mail/flag")
def mail_flag(ctx):
    """标记已读/未读。new/ 里的未读邮件会被搬到 cur/。"""
    account, folder, name = _unkey(ctx.need("key"))
    seen = bool(ctx.body.get("seen", True))
    src = _msg_path(account, folder, name)
    mdir = _account_dir(account)

    if seen:
        flags = _flags(name) | {"S"}
        new_name = _with_flags(name, flags)
        dst = os.path.join(mdir, "cur", new_name)
        if os.path.abspath(src) != os.path.abspath(dst):
            os.rename(src, dst)
        new_folder = "cur"
    else:
        if folder == "cur":
            # cur -> new：Maildir 规范里 new/ 的文件不带 :2,flags
            base = name.split(":2,", 1)[0]
            dst = os.path.join(mdir, "new", base)
            os.rename(src, dst)
            new_folder, new_name = "new", base
        else:
            # 已经在 new/：本来就没有 flags，去掉可能存在的 :2, 后缀即可
            base = name.split(":2,", 1)[0]
            dst = os.path.join(os.path.dirname(src), base)
            if os.path.abspath(src) != os.path.abspath(dst):
                os.rename(src, dst)
            new_folder, new_name = folder, base

    audit.write("mail.flag", {"account": account, "name": name,
                              "seen": seen, "new_folder": new_folder},
                ip=ctx.client_ip)
    return {"seen": seen, "folder": new_folder,
            "key": _key(account, new_folder, new_name)}


@route("POST", "/api/mail/move")
def mail_move(ctx):
    """移入回收站 / 还原。"""
    account, folder, name = _unkey(ctx.need("key"))
    target = str(ctx.need("target")).strip()
    if target not in ("trash", "cur"):
        raise ApiError(400, "target 只能是 trash 或 cur")
    src = _msg_path(account, folder, name)
    mdir = _account_dir(account)

    if target == "trash":
        dst_dir = os.path.join(mdir, ".Trash", "cur")
        os.makedirs(dst_dir, exist_ok=True)
        flags = _flags(name) | {"T", "S"}
        new_name = _with_flags(name, flags)
        os.rename(src, os.path.join(dst_dir, new_name))
        new_folder = "trash"
    else:
        dst_dir = os.path.join(mdir, "cur")
        os.makedirs(dst_dir, exist_ok=True)
        flags = _flags(name) - {"T"}
        new_name = _with_flags(name, flags)
        os.rename(src, os.path.join(dst_dir, new_name))
        new_folder = "cur"

    audit.write("mail.move", {"account": account, "name": name,
                              "from": folder, "to": new_folder}, ip=ctx.client_ip)
    return {"folder": new_folder, "key": _key(account, new_folder, new_name)}


@route("DELETE", "/api/mail/message")
def mail_delete(ctx):
    """彻底删除。只允许删已在回收站里的邮件——直接删收件箱太容易误操作。"""
    account, folder, name = _unkey(ctx.need("key"))
    if folder != "trash":
        raise ApiError(400, "只能彻底删除回收站里的邮件，请先移入回收站")
    path = _msg_path(account, folder, name)
    os.unlink(path)
    audit.write("mail.delete", {"account": account, "name": name}, ip=ctx.client_ip)
    return {"deleted": name}


# ---------------------------------------------------------------- 发信
def _send(to_addrs, subject, body, in_reply_to="", references="", cc=None,
          reply_to_msg=None):
    if not to_addrs:
        raise ApiError(400, "收件人为空")
    msg = EmailMessage()
    msg["From"] = "%s <%s>" % (config.MAIL_FROM_NAME, config.MAIL_FROM)
    msg["To"] = ", ".join(to_addrs)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = subject
    msg["Date"] = tzutil.rfc2822()
    msg["Message-ID"] = email.utils.make_msgid(domain=config.MAIL_FROM.split("@")[-1])
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = references
    if reply_to_msg:
        msg["X-MMH-Reply-To-Message"] = reply_to_msg
    msg.set_content(body or "")

    try:
        with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=25) as s:
            s.ehlo()
            s.send_message(msg)
    except Exception as e:
        raise ApiError(502, "投递失败：%s" % e)
    return msg


@route("POST", "/api/mail/reply")
def mail_reply(ctx):
    """回复某封邮件：自动带 In-Reply-To / References，收件人默认取原 From。"""
    account, folder, name = _unkey(ctx.need("key"))
    path = _msg_path(account, folder, name)
    orig = _parse_file(path, with_body=False)

    to = ctx.body.get("to")
    if isinstance(to, list):
        to = [str(x).strip() for x in to if str(x).strip()]
    elif to:
        to = [str(to).strip()]
    else:
        to = [a["email"] for a in orig["from"] if a["email"]]
    if not to:
        raise ApiError(400, "无法确定收件人，请手动填写")

    subject = str(ctx.body.get("subject") or "").strip()
    if not subject:
        s = orig["subject"]
        subject = s if s.lower().startswith("re:") else "Re: " + s
    references = (orig["references"] + " " + orig["message_id"]).strip()

    msg = _send(to, subject, str(ctx.body.get("body") or ""),
                in_reply_to=orig["message_id"], references=references,
                reply_to_msg=orig["message_id"])

    # 回复后按惯例打 R + S 标记
    try:
        _rename_with_flags(account, folder, name, add=("R", "S"))
    except Exception:
        pass

    audit.write("mail.reply",
                {"account": account, "in_reply_to": orig["message_id"],
                 "to": to, "subject": subject, "message_id": msg["Message-ID"]},
                ip=ctx.client_ip)
    return {"sent": True, "to": to, "subject": subject,
            "message_id": msg["Message-ID"]}


@route("POST", "/api/mail/send")
def mail_send(ctx):
    """写一封新邮件。"""
    to = ctx.need("to")
    to = [str(x).strip() for x in (to if isinstance(to, list) else [to]) if str(x).strip()]
    subject = str(ctx.body.get("subject") or "(无主题)").strip()
    body = str(ctx.body.get("body") or "")
    cc = ctx.body.get("cc") or []
    if isinstance(cc, str):
        cc = [x.strip() for x in cc.split(",") if x.strip()]
    cc = [str(x).strip() for x in cc if str(x).strip()]

    msg = _send(to, subject, body, cc=cc)
    audit.write("mail.send", {"to": to, "cc": cc, "subject": subject,
                              "message_id": msg["Message-ID"]}, ip=ctx.client_ip)
    return {"sent": True, "to": to, "cc": cc, "subject": subject,
            "message_id": msg["Message-ID"]}


# ---------------------------------------------------------------- 审计
@route("GET", "/api/audit")
def get_audit(ctx):
    return {"items": audit.tail(ctx.q_int("limit", 200))}


@route("GET", "/api/mail/whoami")
def mail_whoami(ctx):
    """连通性自检：SMTP 是否可达 + 当前发件人。"""
    ok, detail = True, ""
    try:
        with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=8) as s:
            s.ehlo()
            detail = s.esmtp_features.get("size", "")
    except Exception as e:
        ok, detail = False, str(e)
    return {"smtp_host": config.SMTP_HOST, "smtp_port": config.SMTP_PORT,
            "smtp_ok": ok, "smtp_detail": detail,
            "from": config.MAIL_FROM, "vmail_root": config.VMAIL_ROOT,
            "now": tzutil.fmt()}
