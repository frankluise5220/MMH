# MMH 飞牛官方上架提交材料

本文记录 MMH 提交飞牛官方应用中心前的包信息、测试结论和提交文案。

## 提交包

- 应用包：`release-artifacts/fnos/mmh-0.1.1-fnpack.fpk`
- GitHub Release 下载：`https://github.com/frankluise5220/MMH/releases/download/v0.1.1-fnos/mmh.fpk`
- 版本：`0.1.1`
- 平台：`x86_64` / `x86`
- SHA256：`DF72E99BBC131C8D1845B91C1359C91E4B41807C21F0999905E22D548EB1976D`
- 大小：`139,664,918` bytes
- 生成方式：在 fnOS 测试机使用 `/usr/local/bin/fnpack build` 生成。

## Manifest 摘要

```text
appname               = mmh
version               = 0.1.1
display_name          = MMH
arch                  = x86_64
platform              = x86
source                = thirdparty
service_port          = 7777
checkport             = true
os_min_version        = 0.9.0
changelog             = 按每周小版本节奏递增到 0.1.1，并保持飞牛包、应用源和下载资产版本一致。
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
版本：0.1.1
平台：x86_64 / x86
端口：7777
包 SHA256：DF72E99BBC131C8D1845B91C1359C91E4B41807C21F0999905E22D548EB1976D
下载地址：https://github.com/frankluise5220/MMH/releases/download/v0.1.1-fnos/mmh.fpk
项目主页：https://github.com/frankluise5220/MMH
说明：本包为飞牛 SQLite 原生包，不依赖 Docker/PostgreSQL。数据保存在应用数据目录，升级不删除用户账本数据。
```

## 已验证

- `npm run check:fnos` 通过。
- Release 包 manifest 版本为 `0.1.1`。
- 正式提交包由 fnOS 测试机上的 `fnpack build` 生成。
- GitHub Release 的 `mmh.fpk` 与 `mmh_0.1.1_x86.fpk` 应覆盖为同一份 fnpack 包。
- FN 软仓源应识别已安装 `0.1.0` 到源版本 `0.1.1` 的更新；升级完成后不应继续提示更新。

## 待人工补充

- 官方要求的应用截图。
- 官方要求的测试视频或操作录屏。
- 提交人联系方式和飞牛开发者先锋交流群内的审核沟通记录。
