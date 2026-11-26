#!/usr/bin/env node
/**
 * 提示系统守卫。
 *
 * 背景：同一张表头上曾经同时出现两种提示——自定义药丸（可拖拽）与浏览器原生
 * `title`（排序/筛选），延迟、配色、位置、消失时机全都不一样。现在全站提示只走
 * `src/components/HintLayer.tsx`：深色药丸、300ms 触发、同一套收起规则。
 *
 * 本脚本拦住三类回退：
 *   1. 提示宿主没有挂到根布局（提示静默失效）；
 *   2. 表格层的组件又写回原生 `title=`（原生 tooltip 会盖在药丸上面）；
 *   3. 表头提示漏掉「可拖拽」或「排序/筛选」中的一条。
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const failures = [];

function read(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) {
    failures.push(`${relativePath}: 文件不存在`);
    return "";
  }
  return fs.readFileSync(absolute, "utf8");
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

// 1. 宿主必须挂在根布局
const layout = read("src/app/layout.tsx");
assert(layout.includes("@/components/HintLayer"), "src/app/layout.tsx 未引入 HintLayer");
assert(/<HintLayer\s*\/>/.test(layout), "src/app/layout.tsx 未渲染 <HintLayer />");

// 2. 表格层禁止原生 title（原生 tooltip 与药丸不一致）
const tableLayerFiles = [
  "src/components/AdvancedDataTable.tsx",
  "src/components/TableColumnFilter.tsx",
  "src/components/DateRangeSliderFilter.tsx",
  "src/components/DetailTablePaginationControls.tsx",
  "src/components/BatchReplacePopoverButton.tsx",
];
for (const file of tableLayerFiles) {
  const source = read(file);
  source.split(/\r?\n/).forEach((line, index) => {
    if (/\stitle=/.test(line)) {
      failures.push(`${file}:${index + 1}: 表格层不允许原生 title，请改用 HintLayer 的 useHint / useHintTrigger`);
    }
  });
}

// 3. 表头必须同时给出「拾起该列」和「排序 / 筛选」两条提示
const table = read("src/components/AdvancedDataTable.tsx");
assert(/id:\s*"drag"/.test(table), "AdvancedDataTable 表头缺少拖拽提示");
assert(/id:\s*"sort-filter"/.test(table), "AdvancedDataTable 表头缺少排序/筛选提示");
assert(/columnHintItems\.push/.test(table), "AdvancedDataTable 表头提示未按列组装");

// 4. 触发时长只允许有一个来源
const hintLayer = read("src/components/HintLayer.tsx");
assert(/export const HINT_DELAY_MS = 300/.test(hintLayer), "HintLayer 的提示延迟被改动（应为 300ms 的单一来源）");

// 5. 侧边栏：不可见手势必须自解释（双击空白处筛选账户是典型例子），且除账户名全文外不得有原生 title
const sidebar = read("src/components/layout/SidebarClient.tsx");
assert(sidebar.includes("useHintTrigger"), "SidebarClient 未接入 HintLayer");
assert(/hintProps\("sidebar:account-filter"/.test(sidebar), "侧边栏「双击空白处筛选账户」没有提示");
assert(sidebar.includes("sidebar.accountFilterHint"), "侧边栏双击筛选提示文案缺失");
sidebar.split(/\r?\n/).forEach((line, index) => {
  if (!/\stitle=/.test(line)) return;
  // 账户名全文走 account-label 契约，必须保留原生 title（hover 要带所有者/种类/卡号/币种）
  if (/title=\{(soloTitle|itemTitle|childTitle)\}/.test(line)) return;
  failures.push(`src/components/layout/SidebarClient.tsx:${index + 1}: 侧边栏只允许账户名全文用原生 title，其余改用 hintProps`);
});

// 6. 左侧栏附属组件同理
const sidebarChromeFiles = [
  "src/components/LedgerSwitcher.tsx",
  "src/components/LanguageSwitcher.tsx",
  "src/components/UndoLastOperationButton.tsx",
];
for (const file of sidebarChromeFiles) {
  read(file).split(/\r?\n/).forEach((line, index) => {
    if (/\stitle=/.test(line)) {
      failures.push(`${file}:${index + 1}: 左侧栏附属组件不允许原生 title，请改用 HintLayer`);
    }
  });
}

if (failures.length > 0) {
  console.error("提示系统守卫失败：");
  for (const failure of failures) console.error("  - " + failure);
  process.exit(1);
}
console.log("提示系统守卫通过：宿主已挂载、表格层与侧边栏无多余原生 title、表头两条提示齐全、双击空白筛选有提示、延迟单一来源。");
