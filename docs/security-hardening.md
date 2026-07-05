# 安全加固说明

本文档记录 MMH 在多环境登录、HTTPS 访问和 NAS 部署下的基础安全边界。

## 不应公开的入口

- 不要把 Prisma Studio 暴露到局域网或公网。Prisma Studio 是数据库管理工具，会绕过 MMH 的登录、角色和账簿隔离逻辑。
- 不要把 Postgres 端口暴露到公网。默认 `docker-compose.yml` 只将数据库绑定到 `127.0.0.1:5433`，应用容器通过 Docker 内网访问数据库。
- 不要公开调试脚本、临时查询脚本或开发服务器调试端口。

## HTTPS 与 Cookie

- 正式远程访问应通过 HTTPS 反向代理，例如 Caddy、Nginx、NAS 自带反代或可信网关。
- 如果只允许固定域名或固定内网地址访问，设置 `MMH_ALLOWED_HOSTS`，例如 `MMH_ALLOWED_HOSTS="mmh.example.com,192.168.2.199,localhost,127.0.0.1"`。未列入的 Host 会被应用层直接拒绝。
- 生产环境下，登录 Cookie 默认使用 `HttpOnly`、`SameSite=Lax`、`Secure`。
- 如果只是可信内网 HTTP 测试，可以临时设置 `MMH_INSECURE_COOKIES=1`，不要用于公网。
- 确认站点永远通过 HTTPS 访问后，可以设置 `MMH_ENABLE_HSTS=1` 开启 HSTS。

## 账簿隔离

- 业务接口应从服务端 session 解析当前用户和账簿，不应信任前端提交的账簿 ID。
- 普通用户只能访问自己所属账簿；管理员跨账簿访问也必须经过应用层权限判断。
- 新增 API 时优先使用 `getHouseholdScope()` 或 `getCachedHouseholdScope()` 获取 `householdId`，所有查询、更新、删除都应带上账簿条件。

## 后续方向

- 对登录失败增加限流和冷却。
- 对邮箱密码、AI API Key、更新 token 等敏感字段做应用层加密。
- 增加关键操作审计日志：登录、切换账簿、删除、批量修改、导入、系统更新。
- 增加会话管理：查看当前登录设备、退出其他设备。
