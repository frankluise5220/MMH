#!/usr/bin/env node
/**
 * 兼容入口：`npm run test:win:upload` 等价于
 * `node scripts/upload-win-feed.cjs --target test`。
 *
 * 真正实现已经合进 `upload-win-feed.cjs` —— 测试通道（群晖）和公开源
 * （dl.floatingice.win）之间唯一的变化就是下载地址，两份清单分开维护必然漏一处：
 * 0.1.81 回滚时 latest.yml 回到了 0.1.80，同批的 mmh-app-latest.json 被改成 .bak
 * 就没人恢复，线上 404 了一整轮。
 */
process.argv.push("--target", "test");
require("./upload-win-feed.cjs");
