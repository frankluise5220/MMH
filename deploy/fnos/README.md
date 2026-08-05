# MMH 飞牛 fnOS 应用包

这个目录用于准备飞牛 fnOS 应用包。目标不是让用户手工导入 Compose，而是让用户安装一个 `mmh.fpk` 后得到完整 MMH 运行环境。

`mmh.fpk` 是安装器和运行编排，不是源码包。完整功能由包内 Docker Compose 拉起的三个服务共同提供：

- `app`：MMH Web 应用，镜像内包含 Next.js standalone、Prisma Client、Prisma schema、Prisma CLI/runtime 依赖和启动脚本。
- `postgres`：MMH 数据库，数据写入持久卷。
- `updater`：系统更新助手，用于网页内拉取新镜像并重启服务。

安装 `mmh.fpk` 后，用户不需要理解 Node、Prisma、Next.js 或数据库构建流程；首次启动由应用镜像等待 PostgreSQL 就绪并执行 `prisma db push` 初始化数据库结构。

## 文件

- `docker-compose.yml`：飞牛 Docker 应用编排。
- `env.example`：普通 NAS 手工安装时使用的配置模板；正式 `fpk` 安装不要求用户手工复制 `.env`。
- `manifest.example.json`：应用源元数据草案，正式包内 manifest 由 `scripts/build-fnos-package.cjs` 生成。

## 安装步骤

1. 下载 Release 资产中的 `mmh.fpk`。
2. 在飞牛应用中心或第三方应用入口安装该 `fpk`。
3. 启动后访问：

   ```text
   http://飞牛IP:7777/
   ```

首次启动需要拉取 MMH、MMH updater 和 PostgreSQL 镜像；这一步需要飞牛可以访问所配置的镜像源。当前包不把 Docker 镜像层离线塞进 `fpk`，否则包会变得很大，且更新也会变慢。

## 安全默认值

- 飞牛版默认只暴露 MMH Web 端口 `7777`。
- PostgreSQL 不映射到宿主机端口，只允许 MMH 容器通过 Docker 内网访问。
- 正式远程访问建议使用 HTTPS 反向代理，不建议直接把 `7777` 暴露到公网。

## 更新

优先在 MMH 网页中使用：

```text
系统设置 -> 系统更新 -> 刷新远端版本 -> 更新
```

如果飞牛环境不允许挂载 Docker socket，更新器可能无法自动更新。此时在飞牛 Docker 图形界面拉取新镜像并重启 `mmh-app` 和 `mmh-updater`。

## 打包说明

本仓库提供正式飞牛包打包脚本：

```bash
npm run build:fnos
```

该命令必须在安装了 `fnpack` 的飞牛打包环境中运行，成功后生成单文件 `release-artifacts/fnos/mmh.fpk`。如果当前机器没有 `fnpack`，命令会失败；不要把调试归档当成正式飞牛包。

仅调试 FPK 工程结构时，可以运行：

```bash
npm run stage:fnos
```

它会生成：

```text
release-artifacts/fnos/mmh-版本-fnos-fpk-source.tgz
```

这个归档只用于在飞牛上解压后排查 `manifest`、`cmd`、Compose 和图标结构，不是用户安装包。正式安装应使用 Release 资产中的：

```text
mmh.fpk
```

## 持续更新

飞牛专属包的持续更新依赖两个东西：

- GitHub Release 或第三方源提供新的 `.fpk` 单文件下载地址；发布 Release 时会通过 `.github/workflows/fnos-release.yml` 构建并上传 `.fpk`。
- 应用源索引更新 `version` 和 `download_url`。

本目录下的 `repository/apps.example.json` 是更新源字段草案。正式字段以后按飞牛应用源规范调整，但原则不变：用户看到的飞牛包下载目标必须是 `.fpk` 文件。

飞牛包升级只更新包元数据、Compose、图标和安装脚本；MMH 应用本体继续使用预构建 Docker 镜像更新，不在 NAS 上编译源码。

如果 Release runner 没有安装 `fnpack`，发布 workflow 会失败并提示先补打包环境；此时不能上传 `fnos-fpk-source.tgz` 作为替代。
