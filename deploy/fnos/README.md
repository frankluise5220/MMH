# MMH 飞牛 fnOS 应用包

这个目录用于准备同一个飞牛 fnOS 应用在不同 CPU 架构下的安装包，`appname` 固定为：

```text
mmh
```

现有 MMH 普通 NAS 安装与更新主线仍然是 Docker，继续参考 `docs/nas-install-manual.md` 和 `deploy/nas/`。飞牛版只是额外的 `.fpk` 分发形式，不把普通 NAS 安装改成 SQLite。

飞牛专用 `.fpk` 使用 SQLite 原生运行方式：包内包含 Next standalone、Linux Node runtime、Prisma runtime、SQLite 初始化脚本和应用入口，不依赖 Docker/PostgreSQL。它不是源码包，也不是调试归档。由于包含原生二进制，正式 Release 资产按架构分为 `mmh.fpk` / `mmh-x86_64.fpk` 和 `mmh-arm64.fpk`，但应用 ID 仍然是同一个 `mmh`。

## 安装

1. 下载 Release 资产中适合当前飞牛设备架构的 `.fpk`。x86 设备可使用 `mmh.fpk` 或 `mmh-x86_64.fpk`，ARM64 设备使用 `mmh-arm64.fpk`。
2. 在飞牛应用中心或第三方应用入口安装该 `.fpk`。
3. 安装向导中填写服务端口和系统密码。系统密码用于系统初始化、删除账簿等敏感操作；留空会在首次启动时随机生成，并保存到飞牛应用数据目录的 `mmh-system-password.txt`。
4. 启动后访问：

```text
http://飞牛IP:7777/
```

首次启动会在飞牛应用数据目录创建并初始化 SQLite 数据库：

```text
mmh.db
```

## 打包

正式包必须在 Linux/fnOS 打包环境中生成，因为 `better-sqlite3` 等原生依赖必须匹配目标平台。x86 包要在 Linux x64 runner 构建，ARM64 包要在 Linux arm64 runner 构建。fnOS 5.149 使用 GLIBC 2.36；打包环境也必须使用 GLIBC 2.36 或更低，推荐在 fnOS 机器或 Debian 12/bookworm builder 中执行，不要用 Ubuntu 24+/`ubuntu-latest` 直接发布包。

打包脚本会在生成 `.fpk` 前检查 GLIBC 版本，并从源码重编 `better-sqlite3`，避免把高版本 GLIBC 编译出的原生 `.node` 文件放进 `mmh.fpk`。
如果在 fnOS 真机上复用已验证可加载的 Linux 原生依赖、且系统没有 `gcc/cc`，可以设置 `FNOS_SKIP_NATIVE_REBUILD=1`；脚本会先用包内 Node 实际加载 `better-sqlite3` 并执行内存库查询，验证失败时仍会中止打包。

```bash
npm run build:fnos:app
FNOS_NODE_TARBALL=/path/to/node-v20.x-linux-x64.tar.gz npm run build:fnos
FNOS_TARGET_ARCH=arm64 FNOS_NODE_TARBALL=/path/to/node-v20.x-linux-arm64.tar.gz npm run build:fnos
```

成功后生成：

```text
release-artifacts/fnos/mmh.fpk
release-artifacts/fnos/mmh-x86_64.fpk
release-artifacts/fnos/mmh-arm64.fpk
```

仅调试 FPK 工程结构时，可以运行：

```bash
npm run stage:fnos
```

它会生成：

```text
release-artifacts/fnos/mmh-x86_64-版本-fpk-source.tgz
release-artifacts/fnos/mmh-arm64-版本-fpk-source.tgz
```

这个归档只用于排查 `manifest`、`cmd`、应用文件和图标结构，不是用户安装包。正式安装和应用源下载目标只能是 `.fpk`：

```text
mmh.fpk
mmh-x86_64.fpk
mmh-arm64.fpk
```

## 发布

- GitHub Release 通过 `.github/workflows/fnos-release.yml` 构建并上传 `release-artifacts/fnos/*.fpk`。
- Release workflow 每次发布都必须重新构建并覆盖既有 `.fpk` 资产，不能因为 Release 已存在某个 `.fpk` 就跳过构建。
- 飞牛包版本直接使用 `package.json` 的 `0.1.x`，与 GitHub Release tag `v0.1.x` 和 GHCR 镜像 tag 一致；不要再发布 `v0.1.x-fnos` 或包内 `-fnos` 版本。
- 上传前必须运行 `FNOS_VERIFY_BUILT_FPK=1 npm run check:fnos`，确认包内 `cmd/main`、manifest 和数据目录逻辑来自当前源码。
- Release workflow 会按 x86 / arm64 安装对应架构的官方 `fnpack`；如果安装或验证失败，workflow 必须失败，不能上传 `*-fpk-source.tgz` 作为替代。
- `repository/apps.example.json` 的 `download_url` 保留指向 Release 中的 x86 兼容包 `mmh.fpk`，`download_urls` 必须同时提供 `mmh-x86_64.fpk` 和 `mmh-arm64.fpk`。

## 升级边界

- FN 软仓测试源只能验证“源里有新版本、下载地址可用、版本号能比较”这条测试链路。它不能替代飞牛官方应用中心的升级发布。
- 手动安装的 `.fpk` 在飞牛应用中心里会标记为 `manualInstall`。这类包不一定能通过第三方软仓完成覆盖升级，不能把“软仓按钮安装完成”当作真正升级成功。
- FN 软仓会通过 `appcenter-cli uninstall` 再 `install-fpk` 模拟更新；`appcenter-cli` 在卸载/安装失败时可能仍返回退出码 0，因此必须在升级后验证 `/var/apps/mmh/manifest`、`/vol1/@appcenter/mmh/server/package.json` 和关键 API。
- 包内不得包含 `wizard/uninstall`。卸载向导会要求 Web UI 输入，导致 FN 软仓非交互更新无法真正卸载旧包。
- 面向普通用户的正式升级必须走飞牛官方应用中心上架/审核后的版本发布链路。只有官方应用中心记录了同一个 `appname` 的新版本，后续用户才应在飞牛自身应用中心里看到并执行升级。

## 安全边界

- 飞牛包默认只暴露 MMH Web 端口 `7777`。
- 飞牛包使用 SQLite，没有 PostgreSQL 连接密码。页面中要求输入“数据库密码”的敏感操作，在飞牛版中验证的是安装向导设置或首次启动生成的 MMH 系统密码。
- 数据保存在飞牛应用数据目录中的 SQLite 文件，升级包不得删除用户数据目录。
- 系统密码保存在飞牛应用数据目录 `mmh-system-password.txt` 和运行环境文件 `mmh.env` 中，文件权限会尽量收紧为仅应用用户可读写。
- 包内不得包含本机 `.env`、私有 token、SSH 信息、邮箱授权码、AI key 或数据库备份。
