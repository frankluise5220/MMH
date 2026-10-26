/**
 * 剪贴板账单预判：把 Android 端 BillParser.kt 的纯正则逻辑移植到 web 端。
 *
 * 为什么不用 LLM：剪贴板监听是「回到前台就试读一次」的高频动作，若对任何复制内容
 * 都丢给 AI 解析，一是不必要的开销与延迟，二是会误报（复制一段地址也弹「待确认账单」）。
 * 所以这里先用纯正则本地预判——只有同时能确定「金额 + 方向」才认为是账单，再交给
 * 用户确认（确认时才走 AI 解析入账）。
 *
 * 与 Android 端保持同一套关键词/正则口径，避免两端对同一段账单给出不同结果。
 */

type BillDirection = "expense" | "income" | "transfer";

interface CapturedBill {
  amount: number;
  direction: BillDirection;
  merchant: string | null;
  accountHint: string | null;
  note: string | null;
}

const KNOWN_APPS: Record<string, string> = {
  "com.eg.android.AlipayGphone": "支付宝",
  "com.tencent.mm": "微信",
  "com.taobao.idlefish": "闲鱼",
  "com.taobao.taobao": "淘宝",
  "com.taobao.trip": "飞猪",
  "com.sankuai.meituan": "美团",
  "com.jingdong.app.mall": "京东",
  "com.xingin.xhs": "小红书",
  "com.sdu.didi.psnger": "滴滴",
  "com.ss.android.ugc.aweme": "抖音",
  "com.dianping.v1": "大众点评",
};

const AMOUNT_RE = /(?:¥|￥|RMB)?\s*([0-9]+[.,][0-9]{1,2})\s*(?:元)?/g;
const STRONG_LABELS = /(金额|实付|合计|实收|付款|支付|应还|消费|¥|￥)/;

const EXPENSE_KEYWORDS = ["支出", "消费", "付款", "已支付", "支付成功", "扣款", "扣费", "实付", "购买"];
const INCOME_KEYWORDS = ["收入", "收款", "到账", "入账", "退款", "退回", "收到"];
const TRANSFER_KEYWORDS = ["转账"];

const ACCOUNT_HINTS = [
  "花呗", "余额宝", "余额", "零钱", "银行卡", "信用卡", "储蓄卡",
  "微信支付", "支付宝", "云闪付", "白条", "翼支付",
];
const ACCOUNT_LABELS = ["支付方式", "付款方式", "付款账户", "支付账户", "账户", "银行卡"];
const MERCHANT_LABELS = ["商家", "商户", "收款方", "收款人", "店铺", "门店", "收款方式", "收款账户"];
const NOTE_LABELS = ["备注", "商品", "订单详情"];

const FULLWIDTH: Record<string, string> = {
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
  "，": ",", "．": ".",
};

function normalize(raw: string): string {
  let out = "";
  for (const ch of raw) out += FULLWIDTH[ch] ?? ch;
  return out.replace(/\s+/g, " ");
}

function extractAmount(text: string): number | null {
  const matches = [...text.matchAll(AMOUNT_RE)];
  if (matches.length === 0) return null;
  const values = matches.map((m) => (m[1] ?? "").replace(",", ""));

  // 优先取紧跟在强标签（金额/实付/¥…）之后的金额，避免抓到页面上的无关数字。
  for (const m of matches) {
    const start = Math.max(0, (m.index ?? 0) - 12);
    const ctx = text.slice(start, m.index ?? 0);
    if (STRONG_LABELS.test(ctx)) {
      const idx = matches.indexOf(m);
      const v = Number.parseFloat(values[idx] ?? "");
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  for (const raw of values) {
    const v = Number.parseFloat(raw);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function extractDirection(text: string): BillDirection | null {
  if (TRANSFER_KEYWORDS.some((k) => text.includes(k))) return "transfer";
  const income = INCOME_KEYWORDS.some((k) => text.includes(k));
  const expense = EXPENSE_KEYWORDS.some((k) => text.includes(k));
  if (income) return "income";
  if (expense) return "expense";
  return null;
}

function extractMerchant(text: string): string | null {
  for (const label of MERCHANT_LABELS) {
    const idx = text.indexOf(label);
    if (idx < 0) continue;
    const seg = text.slice(idx + label.length, idx + label.length + 40);
    const raw = seg.split(/[ 　，,。]/).find((s) => s.trim().length > 0);
    if (!raw) continue;
    const value = raw.replace(/^[:：·|—\-＝=]+/, "");
    if (value.length >= 1 && value.length <= 24) return value;
  }
  return null;
}

function extractAccountHint(text: string): string | null {
  for (const label of ACCOUNT_LABELS) {
    const idx = text.indexOf(label);
    if (idx < 0) continue;
    const seg = text.slice(idx + label.length, idx + label.length + 20);
    const hit = ACCOUNT_HINTS.find((h) => seg.includes(h));
    if (hit) return hit;
  }
  return ACCOUNT_HINTS.find((h) => text.includes(h)) ?? null;
}

function buildNote(text: string, merchant: string | null): string | null {
  const merchantPart = merchant?.trim() ? merchant : null;
  let extra: string | null = null;
  for (const label of NOTE_LABELS) {
    const idx = text.indexOf(label);
    if (idx < 0) continue;
    const seg = text.slice(idx + label.length, idx + label.length + 60);
    const raw = seg.split(/[ 　]/).find((s) => s.trim().length > 0);
    if (!raw) continue;
    const v = raw.replace(/^[:：·|—\-＝=]+/, "");
    if (v && v.length >= 1 && v.length <= 40 && v !== merchantPart) {
      extra = v;
      break;
    }
  }
  if (extra) return [merchantPart, extra].filter(Boolean).join(" ");
  return merchantPart;
}

/**
 * 从剪贴板文本解析账单。返回 null 表示「这不是一笔可识别的账单」——金额或方向
 * 无法可靠确定时宁可放弃，也不制造虚假草稿（与 Android 端同一保守策略）。
 */
export function parseClipboardBill(text: string | null | undefined): CapturedBill | null {
  if (!text || !text.trim()) return null;
  const normalized = normalize(text);
  if (normalized.length > 4000) return null;

  const amount = extractAmount(normalized);
  if (amount == null || amount <= 0) return null;
  const direction = extractDirection(normalized);
  if (direction == null) return null;

  const merchant = extractMerchant(normalized);
  const accountHint = extractAccountHint(normalized);
  const note = buildNote(normalized, merchant);

  return { amount, direction, merchant, accountHint, note };
}

export function appDisplayName(_packageName: string | null | undefined): string | null {
  // web 端拿不到包名，保留兼容签名（供未来扩展浏览器扩展时复用 KNOWN_APPS）。
  void _packageName;
  return null;
}

export { KNOWN_APPS };
