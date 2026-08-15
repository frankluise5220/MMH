# Android APK Release（与 v0.1.x 同步发布）

这个 Android 客户端是 MMH 服务端的配套客户端。**从 0.1.33 起，Android APK 与服务端、飞牛包同步发布**：每次创建 `v0.1.x` GitHub Release，`.github/workflows/android-release.yml` 会自动构建签名 APK 并挂到同一个 Release 页面，不再单独发布 `android-v*` 版本。

## 1. 发布形态

每个 `v0.1.x` Release 包含：

- `mmh-fnos-v0.1.x-x86_64.fpk` / `mmh-fnos-v0.1.x-arm64.fpk`（飞牛）
- `mmh-nas-v0.1.x.zip`（NAS Docker 源码包）
- `mmh-android-v0.1.x.apk`（Android，签名 APK）

Android 版本号与服务端同号：`versionName = 0.1.x`，`versionCode = major*100000 + minor*1000 + patch`（0.1.33 → 1033，保证只增不减）。本地不带参数构建时回退到 `1.0.1`（versionCode 2）。

## 2. CI 签名配置（GitHub Secrets，一次性）

工作流需要仓库 Secrets 提供签名钥匙和密码（只进 Secrets，绝不进仓库）：

| Secret 名 | 值 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `mmh-release.jks` 的 base64（`certutil -encode` / `base64` 均可） |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 存储密码（`storePassword`） |
| `ANDROID_KEY_ALIAS` | 钥匙别名（`mmh-release`） |
| `ANDROID_KEY_PASSWORD` | 钥匙密码（`keyPassword`） |

设置位置：GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret。

钥匙本身（`mmh-release.jks`）必须永久备份；丢失后用户无法覆盖升级，只能卸载重装。

## 3. 日常流程

- 正常发布：`npm run release:version` 升 `0.1.x` → 提交推送 → 创建 GitHub Release `v0.1.x`。APK 随工作流自动构建上传，无需手工操作。
- 手动触发：Actions → Release Android APK → Run workflow（`mmh_version` 留空则用 `package.json` 版本）。
- 本地验证（不发布）：`android` 目录下 `gradlew :app:assembleRelease`（默认 1.0.1），或 `gradlew :app:assembleRelease -PmmhVersion=0.1.33` 模拟发布版本。

## 4. 本机签名钥匙

`android/keystore.properties` 与 `android/release/mmh-release.jks` 只保存在本机，不提交（`.gitignore` 已排除）。主备份放在工作区外的安全位置（如 `E:\fs\mmh-release.jks`）。

## 5. 手机安装和升级

手机第一次安装需要允许"安装未知来源应用"。升级时直接安装新版 APK 即可覆盖旧版，前提是新旧 APK 使用同一个 release keystore 签名（CI 一直用同一把钥匙）。
