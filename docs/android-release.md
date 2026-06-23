# Android APK Release

这个 Android 客户端是 MMH 服务端的配套客户端，不按通用应用上架设计。推荐发布方式是把签名后的 APK 放到同仓库的 GitHub Releases，和服务端/API 版本一起维护。

## 1. 生成发布签名

在项目的 `android` 目录下执行一次：

```powershell
New-Item -ItemType Directory -Force .\release
keytool -genkeypair -v -keystore .\release\mmh-release.jks -alias mmh-release -keyalg RSA -keysize 2048 -validity 10000
```

这个 `.jks` 是以后升级 APK 的钥匙，必须备份。以后同一个包名 `com.mmh.app` 的升级包都要用同一把钥匙签名。

## 2. 配置本机签名参数

复制示例文件：

```powershell
Copy-Item .\keystore.properties.example .\keystore.properties
```

编辑 `keystore.properties`，填入真实密码：

```properties
storeFile=release/mmh-release.jks
storePassword=你的密码
keyAlias=mmh-release
keyPassword=你的密码
```

`keystore.properties` 和 `.jks` 只保存在本机，不提交到 GitHub。

## 3. 构建 APK

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
.\gradlew.bat :app:assembleRelease
```

产物位置：

```text
android/app/build/outputs/apk/release/app-release.apk
```

如果没有配置 `keystore.properties`，Gradle 仍可构建 release，但产物会是 unsigned，不能作为正式发布包长期使用。

## 4. 发布到 GitHub Releases

建议 release 标题和 tag 使用客户端版本号，例如：

```text
android-v1.0.0
```

Release 说明里写清楚：

- 需要配套的 MMH 服务端版本或提交号。
- 是否需要重新登录或重新同步本地缓存。
- 主要变更和已知问题。

## 5. 手机安装和升级

手机第一次安装需要允许“安装未知来源应用”。升级时直接安装新版 APK 即可覆盖旧版，但前提是新旧 APK 使用同一个 release keystore 签名。
