# MMH Logo 方向

当前使用用户确认的位图 Logo：源文件为 `Z:\mmh家庭记账软件LOGO设计.png`，已在此基础上轻微加宽中间 `H` 的两条竖向负形，并加入上下翻页式中线高光与阴影。所有正式文件都在 `public/branding/` 下，可直接用于 Web、favicon、README、App 图标。

## 正式文件

| 文件 | 用途 |
| --- | --- |
| `mmh-logo-pageflip.png` | 上下翻页感主图，品牌展示、较大尺寸 |
| `mmh-logo-pageflip.square.png` | 方形站内图标版，当前已接入界面（侧边栏） |
| `mmh-logo-pageflip-192.png` / `mmh-logo-pageflip-512.png` | PWA / manifest 专用尺寸，浏览器和安装图标 |
| `public/favicon.ico` / `public/apple-touch-icon.png` | 浏览器标签页与苹果设备图标 |

> 历史候选稿（v2–v26 系列、mark、final、hwide、horizontal、directions 等设计过程文件）已清理删除，不再保留在 `public/branding/`。

## 设计原则

- 不使用美元符号、硬币堆、银行大楼等陈词滥调。
- 保持几何、克制、可长期使用，同时保证小尺寸下足够醒目。
- 优先围绕字母 `M` 做识别；当前主标直接使用用户确认图的上下翻页版，避免继续偏离参考方向。
- 小尺寸优先，16px 下仍要有清楚轮廓。
- 品牌核心是：本地优先、家庭财务、安全可信、长期维护。

## 当前建议

- 主 Logo：`mmh-logo-pageflip.png`
- favicon / PWA / 站内小图标：`mmh-logo-pageflip.square.png`、`mmh-logo-pageflip-192.png`、`mmh-logo-pageflip-512.png`
- Android 应用图标：`mmh-logo-pageflip.square.png`（经 `android/app/src/main/res/` 生成各密度 mipmap 与 adaptive icon）
