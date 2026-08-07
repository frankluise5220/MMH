# 飞牛包发布源说明

正式飞牛包只有一个：

```text
mmh.fpk
```

不要发布 `mmh-native.fpk`，也不要把 `*-fpk-source.tgz` 当成用户安装包。

发布 GitHub Release 时，`.github/workflows/fnos-release.yml` 会构建并上传 `release-artifacts/fnos/*.fpk`。如果打包环境缺少 `fnpack`，workflow 必须失败，避免发布不可安装的替代归档。

发布时建议同时维护应用源索引，例如 `apps.json`：

- `id`：稳定应用 ID，使用 `mmh`。
- `version`：飞牛包版本，与 Release tag 对齐。
- `platform`：包平台，例如 `x86`。
- `download_url`：指向 GitHub Release 中的 `mmh.fpk`。
- `changelog`：面向用户的更新说明。

`apps.example.json` 是字段草案。正式字段以飞牛应用源规范为准；但原则保持不变：源索引必须指向 `mmh.fpk` 单文件，并能随版本更新。
