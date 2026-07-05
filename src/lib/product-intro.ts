import type { DisplayLanguage } from "@/lib/client/appPreferences";

type ProductIntro = {
  languageLabel: string;
  title: string;
  mantra: string;
  lead: string;
  paragraphs: string[];
  highlights: string[];
};

export const PRODUCT_INTROS: Record<DisplayLanguage, ProductIntro> = {
  "zh-CN": {
    languageLabel: "中文",
    title: "MoneyMoneyHome",
    mantra: "哦嘛呢嘛呢吽",
    lead: "一个把家庭财务安放好的本地化智能系统。",
    paragraphs: [
      "MoneyMoneyHome 是面向家庭和个人的本地化智能财务管理系统，以本地数据安全存储为基础，把日常记账、资产负债、房贷还款、基金定投、保险保单和邮箱账单识别串成一套可以长期维护的家庭财务工作台。",
      "它不只是记录一笔账，而是尽量把复杂流程自动化：房贷自动计算本金、利息、余额和利率调整后的还款计划；基金定投按周期自动执行并关联持仓；保险产品和保单可生成缴费计划与相关记录；邮箱账单可通过 AI 识别导入为标准记账数据。",
      "系统支持 Web、移动端、自动任务、AI 识别流程和开放 API 等多种界面接入，让同一套家庭财务数据在不同入口之间保持统一、准确、可追溯。",
    ],
    highlights: ["房贷自动计算还款", "定投基金自动执行", "保险产品自动购入与缴费", "邮箱账单 AI 识别导入", "本地数据安全存储", "多界面统一接入"],
  },
  "en-US": {
    languageLabel: "English",
    title: "MoneyMoneyHome",
    mantra: "Om Mani Money Home",
    lead: "A local-first intelligent finance system for the whole household.",
    paragraphs: [
      "MoneyMoneyHome is a local-first personal and family finance system. It brings daily bookkeeping, assets and liabilities, mortgage repayment, fund investment plans, insurance policies, and email bill recognition into one durable financial workspace.",
      "It is designed to do more than record transactions. Mortgage schedules can be calculated automatically with principal, interest, balances, rate changes, and early repayments. Fund investment plans can run on schedule and update holdings. Insurance products and policies can create payment plans and related records. Email bills can be recognized by AI and imported as structured bookkeeping data.",
      "The same financial data can be accessed through the Web workspace, mobile apps, scheduled tasks, AI workflows, and open APIs, keeping every interface consistent, accurate, and traceable.",
    ],
    highlights: ["Automatic mortgage repayment calculation", "Scheduled fund investment execution", "Insurance purchase and payment automation", "AI email bill recognition and import", "Secure local data storage", "Unified multi-interface access"],
  },
  "ja-JP": {
    languageLabel: "日本語",
    title: "MoneyMoneyHome",
    mantra: "オム・マニ・マネー・ホーム",
    lead: "家庭のお金を整える、ローカルファーストのスマート家計システム。",
    paragraphs: [
      "MoneyMoneyHome は、個人と家庭のためのローカルファーストな財務管理システムです。日々の記帳、資産と負債、住宅ローン返済、投資信託の積立、保険契約、メール明細の認識を、長く使える家庭向けワークスペースにまとめます。",
      "単に取引を記録するだけではありません。住宅ローンは元金、利息、残高、金利変更、繰上返済を反映して返済計画を自動計算できます。投資信託の積立は周期に沿って自動実行し、保有残高と連動します。保険商品と契約は支払計画や関連記録を生成でき、メール明細は AI で認識して標準的な記帳データとして取り込めます。",
      "Web、モバイルアプリ、自動タスク、AI ワークフロー、オープン API など複数の入口から同じ財務データに接続し、表示と計算を一貫して正確に保ちます。",
    ],
    highlights: ["住宅ローン返済の自動計算", "投資信託積立の自動実行", "保険購入と保険料支払いの自動化", "メール明細の AI 認識と取込", "安全なローカルデータ保存", "複数画面からの統一アクセス"],
  },
};

export function getProductIntro(language: DisplayLanguage) {
  return PRODUCT_INTROS[language] ?? PRODUCT_INTROS["zh-CN"];
}
