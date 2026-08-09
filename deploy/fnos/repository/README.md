# 飞牛包发布源说明

正式飞牛包只有一个：

```text
mmh.fpk
```

不要发布 `mmh-native.fpk`，也不要把 `*-fpk-source.tgz` 当成用户安装包。

发布 GitHub Release 时，`.github/workflows/fnos-release.yml` 会构建并上传 `release-artifacts/fnos/*.fpk`。如果打包环境缺少 `fnpack`，workflow 必须失败，避免发布不可安装的替代归档。

发布时建议同时维护应用源索引。FN 软仓这类源会访问：

```text
源地址/api/apps
```

本目录下的 `api/apps` 是可直接通过 GitHub raw 访问的静态源文件。FN 软仓源地址可以填写：

```text
https://raw.githubusercontent.com/frankluise5220/MMH/main/deploy/fnos/repository
```

这个源返回的 `download_url` 再指向 GitHub Release 中的 `mmh.fpk`。

源文件字段包括：

- `id`：稳定应用 ID，使用 `mmh`。
- `version`：飞牛包版本，与 Release tag 对齐。
- `platform`：包平台，例如 `x86`。
- `download_url`：指向 GitHub Release 中的 `mmh.fpk`。
- `changelog`：面向用户的更新说明。

`apps.example.json` 是字段草案。正式字段以飞牛应用源规范为准；但原则保持不变：源索引必须指向 `mmh.fpk` 单文件，并能随版本更新。
