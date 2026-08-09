# MMH 飞牛官方上架提交材料

本文记录 MMH 提交飞牛官方应用中心前的包信息、测试结论和提交文案。

## 当前状态

`v0.1.2-fnos` 与 `v0.1.3-fnos` Release 中的既有 `mmh.fpk` 不再作为官方上架提交包使用。现场验证发现这些包存在发布级问题：

- `cmd/main` 仍把 SQLite 数据放到应用安装目录，未使用飞牛应用数据目录。
- `better-sqlite3.node` 来自不兼容目标系统的构建环境，可能要求高于 fnOS 1.2 / Debian 12 的 GLIBC 版本。
- `wizard/uninstall` 会让 FN 软仓的非交互式“先卸载再安装”更新链路失败；飞牛 CLI 输出错误但退出码仍为 0，软仓会误报安装成功。

下一次官方提交必须重新生成新版本 `.fpk`，并通过 `FNOS_VERIFY_BUILT_FPK=1 npm run check:fnos` 验证后再上传 Release。

## 历史作废包

- 作废应用包：`release-artifacts/fnos/mmh-0.1.2-fnpack.fpk`
- GitHub Release 下载：`https://github.com/frankluise5220/MMH/releases/download/v0.1.2-fnos/mmh.fpk`
- 版本：`0.1.2`
- 平台：`x86_64` / `x86`
- SHA256：`21130206794C3D09074FEC323A333F2EBC394423C08CA3F7801750644E9B55E1`
- 大小：`139,661,052` bytes
- 生成方式：在 fnOS 测试机使用 `/usr/local/bin/fnpack build` 生成。

## 下一次提交包要求

- 版本必须高于 `0.1.3`。
- Release 中的 `mmh.fpk` 与版本化资产必须由 `.github/workflows/fnos-release.yml` 重新构建并覆盖上传。
- 包内 `manifest` 版本、仓库源 `version`、GitHub Release tag 和文件名必须一致。
- 包内 `cmd/main` 必须使用飞牛应用数据目录保存 SQLite，不能回退到应用安装目录。
- 包内 `better-sqlite3.node` 必须在 fnOS 目标 GLIBC 版本可加载。
- 包内不能包含 `wizard/uninstall`；卸载默认保留应用数据目录，避免阻塞第三方软仓更新链路。

## Manifest 摘要

```text
appname               = mmh
version               = 0.1.4
display_name          = MMH
arch                  = x86_64
platform              = x86
source                = thirdparty
service_port          = 7777
checkport             = true
os_min_version        = 0.9.0
changelog             = 修复 FN 软仓更新链路：移除阻塞非交互升级的卸载向导，并继续包含首次使用向导、当前图标和 SQLite 数据目录修复。
```

## 应用信息

- 应用名称：MMH
- 应用分类：财务 / 记账 / 家庭资产管理
- 开发者：frankluise5220
- 项目主页：`https://github.com/frankluise5220/MMH`
- 默认端口：`7777`
- 数据存储：飞牛应用数据目录中的 SQLite 数据库 `mmh.db`
- 权限说明：默认以应用用户运行，只读写自身应用数据目录，不需要 Docker、不暴露数据库端口。

## 应用简介

MMH 是一套本地部署的家庭记账与资产管理工具，支持账户流水、信用卡账单、基金持仓、统计报表和数据导入。飞牛版会把数据保存在自己的 NAS 上，安装后可直接通过浏览器访问 `http://飞牛IP:7777/` 使用。

## 提交说明

请帮忙审核 MMH 飞牛应用包：

```text
应用名：MMH
版本：0.1.4
平台：x86_64 / x86
端口：7777
包 SHA256：0DE1C837D1E8866A7E91DCE3295865C4B75FEF499D6B9FB9012F037FFE297A22
下载地址：https://github.com/frankluise5220/MMH/releases/download/v0.1.4-fnos/mmh.fpk
项目主页：https://github.com/frankluise5220/MMH
说明：本包为飞牛 SQLite 原生包，不依赖 Docker/PostgreSQL。数据保存在应用数据目录，升级不删除用户账本数据。
```

## 已验证

- `npm run check:fnos` 通过。
- Release 包 manifest 版本为 `0.1.4`。
- 正式提交包由 fnOS 测试机上的 `fnpack build` 生成。
- GitHub Release 的 `mmh.fpk` 与 `mmh_0.1.4_x86.fpk` 应覆盖为同一份 fnpack 包。
- FN 软仓源应识别已安装旧版本到源版本 `0.1.4` 的更新；升级完成后不应继续提示更新。

## 待人工补充

- 官方要求的应用截图。
- 官方要求的测试视频或操作录屏。
- 提交人联系方式和飞牛开发者先锋交流群内的审核沟通记录。
