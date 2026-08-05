# MMH 飞牛 fnOS 安装素材

这个目录用于准备飞牛 fnOS 应用包。当前版本是 Docker 应用骨架，目标是让飞牛通过图形界面导入 Compose 并运行 MMH。

## 文件

- `docker-compose.yml`：飞牛 Docker 应用编排。
- `env.example`：安装配置模板，复制为 `.env` 后使用。
- `manifest.example.json`：飞牛应用包元数据草案，等待实际 fpk 规范确认。

## 安装步骤

1. 在飞牛文件管理中新建应用目录，例如：

   ```text
   docker/mmh
   ```

2. 将本目录中的 `docker-compose.yml`、`env.example` 复制到该目录。

3. 将 `env.example` 重命名为 `.env`。

4. 修改 `.env` 中的数据库密码：

   ```env
   POSTGRES_PASSWORD="CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD"
   ```

5. 在飞牛 Docker / Compose 图形界面创建应用，选择 `docker-compose.yml`。

6. 启动后访问：

   ```text
   http://飞牛IP:7777/
   ```

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

当前目录还不是最终 `.fpk` 成品。正式打包前需要确认飞牛的应用包 manifest、签名、图标和架构字段。

本仓库提供正式飞牛包打包脚本：

```bash
npm run build:fnos
```

该命令必须在安装了 `fnpack` 的飞牛打包环境中运行，成功后生成单文件 `.fpk`。如果当前机器没有 `fnpack`，命令会失败；不要把调试归档当成正式飞牛包。

仅调试 FPK 工程结构时，可以运行：

```bash
npm run stage:fnos
```

它会生成：

```text
release-artifacts/fnos/mmh-版本-fnos-fpk-source.tgz
```

这个归档只用于在飞牛上解压后排查 `manifest`、`cmd`、Compose 和图标结构，不是用户安装包。正式安装应使用：

```bash
sudo appcenter-cli install-fpk mmh.fpk
```

## 持续更新

飞牛专属包的持续更新依赖两个东西：

- GitHub Release 或第三方源提供新的 `.fpk` 单文件下载地址；发布 Release 时会通过 `.github/workflows/fnos-release.yml` 构建并上传 `.fpk`。
- 应用源索引更新 `version` 和 `download_url`。

本目录下的 `repository/apps.example.json` 是更新源字段草案。正式字段以后按飞牛应用源规范调整，但原则不变：用户看到的飞牛包下载目标必须是 `.fpk` 文件。

飞牛包升级只更新包元数据、Compose、图标和安装脚本；MMH 应用本体继续使用预构建 Docker 镜像更新，不在 NAS 上编译源码。

如果 Release runner 没有安装 `fnpack`，发布 workflow 会失败并提示先补打包环境；此时不能上传 `fnos-fpk-source.tgz` 作为替代。
