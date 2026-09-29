#!/usr/bin/python3
"""MMH 边缘 SNI 分流器（443 端口独占者）。

为什么需要它
    这台 VPS 的 :443 只有一个进程能占。而 :443 上要同时服务：
      - synology.floatingice.win  群晖套件源（nginx，需真实客户端 IP）
      - admin.floatingice.win     MMH 后台管理（nginx，需真实客户端 IP）
      - 其它一切 SNI              xray（vmess/vless 等）
    所以在 TLS 握手之前，按 ClientHello 里的 SNI 把裸 TCP 连接分给不同后端。

路由表
    ROUTES 里列出的域名 -> 对应后端，并在转发前发 PROXY protocol v1 头；
    没命中的一律给 DEFAULT_BACKEND（xray）。

PROXY protocol 的必要性
    这是纯 TCP 转发，nginx 只跟 127.0.0.1 说话，$remote_addr 恒为 127.0.0.1。
    转发前先发一行
        PROXY TCP4 <真实源IP> <本机IP> <源端口> <本机端口>\r\n
    nginx 侧用 `listen ... proxy_protocol` + `real_ip_header proxy_protocol` 接收，
    就能拿到真实客户端 IP。没有它，群晖渠道的下载会被记成 127.0.0.1、
    后台管理的审计日志也会全是本机地址。

    注意：只有 nginx 后端能收这个头；xray 不认，发了会直接握手失败，
    所以 PROXY 头是按后端发的，不是无脑全发。

改动这个文件必须同时改 nginx 侧
    ROUTES 里某个域名的后端若改成"不发 PROXY 头"，对应的 nginx
    server 块必须去掉 `proxy_protocol`，否则 nginx 会等不到那一行而握手超时。
"""

import selectors
import socket
import struct
import threading

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 443

# 域名 -> 后端 (host, port)
ROUTES = {
    "synology.floatingice.win": ("127.0.0.1", 9443),   # nginx: 群晖套件源
    "admin.floatingice.win":    ("127.0.0.1", 9444),   # nginx: MMH 后台管理
}

# 这些后端是 nginx，能收 PROXY protocol v1 头
PROXY_PROTOCOL_HOSTS = set(ROUTES)

# 没命中 ROUTES 的 SNI 全部转给 xray
DEFAULT_BACKEND = ("127.0.0.1", 8444)


def parse_sni(data):
    if len(data) < 5 or data[0] != 22:
        return None
    record_length = struct.unpack("!H", data[3:5])[0]
    if len(data) < 5 + record_length:
        return None
    handshake = data[5:5 + record_length]
    if len(handshake) < 4 or handshake[0] != 1:
        return ""
    hello_length = (handshake[1] << 16) | (handshake[2] << 8) | handshake[3]
    if len(handshake) < 4 + hello_length:
        return None
    body = handshake[4:4 + hello_length]
    if len(body) < 34:
        return ""
    offset = 34
    if offset >= len(body):
        return ""
    session_length = body[offset]
    offset += 1 + session_length
    if offset + 2 > len(body):
        return ""
    cipher_length = struct.unpack("!H", body[offset:offset + 2])[0]
    offset += 2 + cipher_length
    if offset >= len(body):
        return ""
    compression_length = body[offset]
    offset += 1 + compression_length
    if offset + 2 > len(body):
        return ""
    extensions_length = struct.unpack("!H", body[offset:offset + 2])[0]
    offset += 2
    end = min(len(body), offset + extensions_length)
    while offset + 4 <= end:
        extension_type, extension_length = struct.unpack("!HH", body[offset:offset + 4])
        offset += 4
        extension_end = offset + extension_length
        if extension_end > end:
            return ""
        if extension_type == 0 and extension_length >= 5:
            names_length = struct.unpack("!H", body[offset:offset + 2])[0]
            name_offset = offset + 2
            names_end = min(extension_end, name_offset + names_length)
            while name_offset + 3 <= names_end:
                name_type = body[name_offset]
                name_length = struct.unpack("!H", body[name_offset + 1:name_offset + 3])[0]
                name_offset += 3
                if name_offset + name_length > names_end:
                    break
                if name_type == 0:
                    return body[name_offset:name_offset + name_length].decode("idna").lower()
                name_offset += name_length
        offset = extension_end
    return ""


def read_client_hello(client):
    client.settimeout(5)
    data = b""
    while len(data) < 65536:
        chunk = client.recv(4096)
        if not chunk:
            return data, ""
        data += chunk
        sni = parse_sni(data)
        if sni is not None:
            return data, sni
    return data, ""


def relay(left, right):
    selector = selectors.DefaultSelector()
    selector.register(left, selectors.EVENT_READ, right)
    selector.register(right, selectors.EVENT_READ, left)
    try:
        while True:
            events = selector.select(3600)
            if not events:
                return
            for key, _ in events:
                data = key.fileobj.recv(65536)
                if not data:
                    return
                key.data.sendall(data)
    except (OSError, socket.error):
        return
    finally:
        selector.close()


def proxy_v1_header(peer, local):
    """构造 PROXY protocol v1 头。

    没有它，nginx 看到的 $remote_addr 永远是 127.0.0.1（因为它只跟本机代理说话），
    于是群晖渠道的下载全部被记成 127.0.0.1、后台管理的审计日志也拿不到真实 IP。
    加了之后 nginx 侧配 `listen ... proxy_protocol` + `real_ip_header proxy_protocol`
    就能拿到真实客户端 IP。
    """
    src_ip, src_port = peer[0], peer[1]
    dst_ip, dst_port = local[0], local[1]
    fam = "TCP6" if ":" in src_ip else "TCP4"
    return ("PROXY %s %s %s %d %d\r\n" % (fam, src_ip, dst_ip, src_port, dst_port)).encode()


def handle(client, peer):
    backend = None
    try:
        initial, sni = read_client_hello(client)
        target = ROUTES.get(sni or "", DEFAULT_BACKEND)
        send_proxy = (sni or "") in PROXY_PROTOCOL_HOSTS
        backend = socket.create_connection(target, 10)
        # 只给 nginx 后端发 PROXY 头；xray 不认这个协议，发了会直接握手失败
        if send_proxy:
            backend.sendall(proxy_v1_header(peer, client.getsockname()))
        backend.sendall(initial)
        relay(client, backend)
    except (OSError, socket.error):
        pass
    finally:
        try:
            client.close()
        except OSError:
            pass
        if backend is not None:
            try:
                backend.close()
            except OSError:
                pass


def main():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((LISTEN_HOST, LISTEN_PORT))
    listener.listen(256)
    while True:
        client, addr = listener.accept()
        thread = threading.Thread(target=handle, args=(client, addr))
        thread.daemon = True
        thread.start()


if __name__ == "__main__":
    main()
