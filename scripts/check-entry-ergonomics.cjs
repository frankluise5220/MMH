#!/usr/bin/env node
/**
 * 记账便捷度基线守卫。
 *
 * 为什么要有它：记账弹窗的「快不快」过去只能靠手感描述，改一次字段顺序、
 * 加一个必填项、把 SmartSelect 换成普通下拉，肉眼很难发现负担变重了。
 * 这里把「结构复杂度」变成可比的数字，和基线 JSON 逐项对照。
 *
 * 四个指标（对每个弹窗静态统计，粒度为源码计数，不是运行时点击链）：
 *   required    界面上打红星的字段数（REQUIRED_FIELD_CLASS）—— 增加即变慢，按 error 处理。
 *               注意它只代表「看得见的必填提示」，业务必填仍在提交校验里，两者不等价。
 *   controls    输入控件数（CalcInput/input/textarea/select）
 *   smartSelect 搜索式选择器数 —— 减少说明退化成翻长列表
 *   effects     自动回填 effect 数 —— 减少说明要手填的字段变多
 *
 * 判定：required 增加 → error（退出码 1）；其余指标恶化 → warn（只提示）。
 * 减少一律放行，那是在变好。
 *
 * 用法：
 *   node scripts/check-entry-ergonomics.cjs           对照基线
 *   node scripts/check-entry-ergonomics.cjs --update  重写基线（改完 UI 后确认无回退再执行）
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BASELINE = path.join(__dirname, "entry-ergonomics.baseline.json");

/** 参与度量的记账/业务弹窗。新增弹窗时在这里补一行，再跑 --update。 */
const FORMS = [
  { name: "支出/收入/转账", file: "src/components/TransactionFormModal.tsx" },
  { name: "投资买入卖出", file: "src/components/InvestmentFormModal.tsx" },
  { name: "银行理财", file: "src/components/WealthFormModal.tsx" },
  { name: "债券/逆回购", file: "src/components/BondFormModal.tsx" },
  { name: "存款", file: "src/components/DepositFormModal.tsx" },
  { name: "股票交易", file: "src/components/StockTransactionFormModal.tsx" },
  { name: "往来款", file: "src/components/LiabilityTransactionModal.tsx" },
];

function count(source, re) {
  return (source.match(re) || []).length;
}

/**
 * 必填标记的行数统计。
 *
 * 三个坑（都踩过）：
 *  1. 裸 /required/ 会命中 import、注释、requiredXxx 变量名 —— 数字是假的；
 *  2. 项目不用原生 required 属性，必填只在 REQUIRED_FIELD_CLASS 上；
 *  3. className 有四种写法，只认 `className={REQUIRED_FIELD_CLASS}` 会漏掉
 *     `className={cond ? undefined : REQUIRED_FIELD_CLASS}`（条件必填）和
 *     `className={`form-input ${REQUIRED_FIELD_CLASS}`}`（模板串拼接）。
 * 所以按行统计：出现该常量、且不是 import 行，就算一处。
 */
function countRequiredMarkers(source) {
  return source
    .split("\n")
    .filter((line) => /REQUIRED_FIELD_CLASS/.test(line) && !/^\s*import\b/.test(line)).length;
}

function measure(file) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) return null;
  const source = fs.readFileSync(abs, "utf8");
  return {
    controls: count(source, /<(CalcInput|input|textarea|select)[\s>]/g),
    smartSelect: count(source, /<SmartSelect[\s>]/g),
    required: countRequiredMarkers(source),
    effects: count(source, /useEffect\(/g),
    lines: source.split("\n").length,
  };
}

function collect() {
  const result = {};
  for (const form of FORMS) {
    const metrics = measure(form.file);
    if (!metrics) {
      result[form.file] = { name: form.name, missing: true };
      continue;
    }
    result[form.file] = { name: form.name, ...metrics };
  }
  return result;
}

const update = process.argv.includes("--update");
const current = collect();

if (update) {
  fs.writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`[check:entry-ergonomics] baseline written: ${path.relative(ROOT, BASELINE)}`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error("[check:entry-ergonomics] 缺少基线文件，先执行：node scripts/check-entry-ergonomics.cjs --update");
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const errors = [];
const warnings = [];

for (const [file, metrics] of Object.entries(current)) {
  const base = baseline[file];
  const label = metrics.name || base?.name || file;
  if (metrics.missing) {
    warnings.push({ label, message: "文件不存在（已删除或改名？）" });
    continue;
  }
  if (!base || base.missing) {
    warnings.push({ label, message: "基线里没有这一项（新增弹窗请跑 --update）" });
    continue;
  }
  if (metrics.required > base.required) {
    errors.push({ label, message: `必填项 ${base.required} → ${metrics.required}，多一个必填就是多一次决策` });
  }
  if (metrics.controls > base.controls) {
    warnings.push({ label, message: `输入控件 ${base.controls} → ${metrics.controls}` });
  }
  if (metrics.smartSelect < base.smartSelect) {
    warnings.push({ label, message: `搜索式选择器 ${base.smartSelect} → ${metrics.smartSelect}，检查是否退化成翻列表` });
  }
  if (metrics.effects < base.effects) {
    warnings.push({ label, message: `自动回填 ${base.effects} → ${metrics.effects}，检查是否要用户手填` });
  }
}

for (const item of warnings) {
  console.warn(`  [warn] ${item.label}：${item.message}`);
}
for (const item of errors) {
  console.error(`  [error] ${item.label}：${item.message}`);
}

if (errors.length > 0) {
  console.error(`[check:entry-ergonomics] ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}

console.log(`[check:entry-ergonomics] ok（${warnings.length} 处警告）`);
