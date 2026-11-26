/**
 * 备注批量修改的公式（2026-11-26 用户裁定）：
 *
 * - `{备注}` 代表该行当前备注，写在文本里就是「原备注原样插入」；
 * - `{备注}+XXX` 在末尾追加 XXX（`前缀{备注}+XXX` 亦可）；
 * - `{备注}-XXX` 从原备注里删掉 XXX（多余空白会收成一个空格）。
 *
 * 不含 `{备注}` 时保持批量修改的老语义：整体覆盖（空串 = 清空）。
 * 备注是文本，加减只在占位符紧邻的位置生效，正文里的连字符、加号
 * （如「定投-2024」「A+B」）不会被当成算式。
 */

/** 允许的自身引用写法：中文界面写 `{备注}`，英文/日文用户可以用 `{remark}` / `{note}`。 */
const REMARK_SELF_TOKENS = ["备注", "remark", "note"];

const PLACEHOLDER_PATTERN = /\{\s*([^{}]*?)\s*\}/g;

function normalizeRemarkExpression(raw: string) {
  return String(raw ?? "").replace(/[｛｝]/g, (ch) => (ch === "｛" ? "{" : "}"));
}

function isSelfToken(name: string) {
  const normalized = name.trim().toLowerCase();
  return REMARK_SELF_TOKENS.includes(normalized);
}

function removeRemarkFragment(base: string, fragment: string) {
  const needle = fragment.trim();
  if (!needle || !base.includes(needle)) return base;
  return base
    .split(needle)
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 是否引用了当前备注（只有引用时才做追加 / 删除，否则按整体覆盖）。 */
export function isRemarkExpression(raw: string) {
  const text = normalizeRemarkExpression(raw);
  PLACEHOLDER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_PATTERN.exec(text)) !== null) {
    if (isSelfToken(match[1])) return true;
  }
  return false;
}

/**
 * 按公式算出这一行的新备注。`current` 是该行现有备注（可为 null）。
 * 调用点必须在服务端逐行求值：批量面板里填的是公式，每行的原备注不同。
 */
export function evaluateRemarkExpression(raw: string, current: string | null | undefined) {
  const text = normalizeRemarkExpression(raw);
  const base = String(current ?? "");
  PLACEHOLDER_PATTERN.lastIndex = 0;

  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_PATTERN.exec(text)) !== null) {
    // 不是自身引用的 `{...}` 当普通文本，继续往后扫。
    if (!isSelfToken(match[1])) continue;
    result += text.slice(cursor, match.index);
    const rest = text.slice(match.index + match[0].length);
    const operator = rest.charAt(0);
    if (operator === "+" || operator === "-") {
      const operand = rest.slice(1);
      result += operator === "+" ? base + operand : removeRemarkFragment(base, operand);
      cursor = text.length;
      break;
    }
    result += base;
    cursor = match.index + match[0].length;
  }
  result += text.slice(cursor);
  return result;
}
