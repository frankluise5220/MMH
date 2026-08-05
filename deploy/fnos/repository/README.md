# 飞牛包发布源说明

正式飞牛包必须以 `.fpk` 单文件发布，不能把 `fnos-fpk-source.tgz` 当成用户安装包。

发布 GitHub Release 时，`.github/workflows/fnos-release.yml` 会构建并上传 `release-artifacts/fnos/*.fpk`。如果打包环境缺少 `fnpack`，workflow 必须失败，避免发布不可安装的替代归档。

发布时建议同时维护应用源索引，例如 `apps.json`：

- `id`：稳定应用 ID，例如 `mmh`。
- `version`：飞牛包版本，与 Release tag 对齐。
- `platform`：包平台，例如 `x86`、`arm` 或 `all`；Docker 应用优先使用 `all`。
- `download_url`：指向 GitHub Release 中的 `.fpk` 文件；按飞牛包规则，正式安装文件名保持 `{appname}.fpk`，MMH 即 `mmh.fpk`。
- `changelog`：面向用户的更新说明。

`apps.example.json` 是字段草案。正式字段以飞牛应用源规范为准；但无论字段名称如何变化，原则保持不变：源索引必须指向 `.fpk` 单文件，并能随版本更新。
