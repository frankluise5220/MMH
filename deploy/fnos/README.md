# MMH 飞牛 fnOS 应用包

这个目录用于准备唯一的飞牛 fnOS 专用安装包：

```text
mmh.fpk
```

现有 MMH 普通 NAS 安装与更新主线仍然是 Docker，继续参考 `docs/nas-install-manual.md` 和 `deploy/nas/`。飞牛版只是额外的 `.fpk` 分发形式，不把普通 NAS 安装改成 SQLite。

飞牛专用 `mmh.fpk` 使用 SQLite 原生运行方式：包内包含 Next standalone、Linux Node runtime、Prisma runtime、SQLite 初始化脚本和应用入口，不依赖 Docker/PostgreSQL。它不是源码包，也不是调试归档。

## 安装

1. 下载 Release 资产中的 `mmh.fpk`。
2. 在飞牛应用中心或第三方应用入口安装该 `.fpk`。
3. 启动后访问：

```text
http://飞牛IP:7777/
```

首次启动会在飞牛应用数据目录创建并初始化 SQLite 数据库：

```text
mmh.db
```

## 打包

正式包必须在 Linux/fnOS 打包环境中生成，因为 `better-sqlite3` 等原生依赖必须匹配目标平台。

```bash
npm run build:fnos:app
FNOS_NODE_TARBALL=/path/to/node-v20.x-linux-x64.tar.gz npm run build:fnos
```

成功后生成：

```text
release-artifacts/fnos/mmh.fpk
```

仅调试 FPK 工程结构时，可以运行：

```bash
npm run stage:fnos
```

它会生成：

```text
release-artifacts/fnos/mmh-版本-fpk-source.tgz
```

这个归档只用于排查 `manifest`、`cmd`、应用文件和图标结构，不是用户安装包。正式安装和应用源下载目标只能是：

```text
mmh.fpk
```

## 发布

- GitHub Release 通过 `.github/workflows/fnos-release.yml` 构建并上传 `release-artifacts/fnos/*.fpk`。
- 如果 Release runner 没有安装 `fnpack`，workflow 必须失败，不能上传 `*-fpk-source.tgz` 作为替代。
- `repository/apps.example.json` 的 `download_url` 必须指向 Release 中的 `mmh.fpk`。

## 安全边界

- 飞牛包默认只暴露 MMH Web 端口 `7777`。
- 数据保存在飞牛应用数据目录中的 SQLite 文件，升级包不得删除用户数据目录。
- 包内不得包含本机 `.env`、私有 token、SSH 信息、邮箱授权码、AI key 或数据库备份。
