import { evaluateArithmeticExpression } from "@/lib/arithmetic-expression";

export type AmountFieldReferenceValues = {
  inflow: number;
  outflow: number;
};

const HALF_WIDTH_MAP: Record<string, string> = {
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
  "．": ".", "。": ".",
  "＋": "+", "－": "-", "＊": "*", "／": "/",
  "（": "(", "）": ")", "｛": "{", "｝": "}", "　": " ",
};

function normalizeAmountExpression(raw: string) {
  return raw
    .replace(/[０-９．。＋－＊／（）｛｝　]/g, (ch) => HALF_WIDTH_MAP[ch] ?? ch)
    .replace(/[,，￥¥%％\s]/g, "");
}

function readReferenceValue(name: string, values: AmountFieldReferenceValues) {
  const normalized = name.trim().toLowerCase();
  if (normalized === "流入" || normalized === "inflow") return values.inflow;
  if (normalized === "流出" || normalized === "outflow") return values.outflow;
  return null;
}

export function hasAmountFieldReference(raw: string) {
  const normalized = normalizeAmountExpression(raw);
  const pattern = /\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    if (readReferenceValue(match[1], { inflow: 0, outflow: 0 }) !== null) return true;
  }
  return false;
}

export function evaluateAmountFieldExpression(
  raw: string,
  baseAmount: number,
  referenceValues?: AmountFieldReferenceValues,
) {
  let expression = normalizeAmountExpression(raw);
  if (!expression) return null;

  if (/^[+\-*/]/.test(expression)) {
    expression = `${Math.abs(Number(baseAmount) || 0)}${expression}`;
  }

  if (!referenceValues && /[{}]/.test(expression)) return null;

  let invalidReference = false;
  const resolved = expression.replace(/\{([^{}]*)\}/g, (_match, name: string) => {
    const value = referenceValues ? readReferenceValue(name, referenceValues) : null;
    if (value == null || !Number.isFinite(value)) {
      invalidReference = true;
      return "0";
    }
    return `(${Math.abs(value)})`;
  });

  if (invalidReference || /[{}]/.test(resolved) || !/^[\d.+\-*/()]+$/.test(resolved)) return null;

  const computed = evaluateArithmeticExpression(resolved);
  return typeof computed === "number" && Number.isFinite(computed) ? computed : null;
}
