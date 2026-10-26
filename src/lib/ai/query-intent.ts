// 查询意图判定：区分「在问已有数据」和「在描述一笔新交易」。
//
// 背景（issue #22）：/api/v1/ai/chat 只有「回收站查询」和「统计」两个关键词分支，
// 其余输入一律落到「解析成流水」分支，于是「这个月支出多少」会被记成一笔流水。
// 这里把判定逻辑抽成纯函数，既能被路由复用，也能被探针直接验证。
import { TransactionType } from "@prisma/client";
import { normalizeOperationText } from "@/lib/commandParser";
import { extractBankKeywordFromBill } from "@/lib/ai/parser";

type StatsPlan = {
  metric: "count" | "sum";
  type: TransactionType;
  year?: number;
  month?: number;
  accountKeyword?: string;
};

/**
 * 判断一句话是不是「在问已有数据」。
 * 宁可提示用户没有记账，也不要把问句静默落成流水。
 */
export function looksLikeDataQuestion(text: string): boolean {
  const t = normalizeOperationText(text);
  if (!t || t.length > 80) return false;
  const asksAboutExistingData =
    /(多少|吗|呢)[？?]?$/.test(t) ||
    /(统计|查询|查看|看看|列出|显示|合计|总额|几笔|占比|排行|平均)/.test(t);
  if (!asksAboutExistingData) return false;
  // 带金额单位的句子更像一笔记账（"今天买菜花了50元"），不拦。
  if (/\d+(\.\d+)?\s*(元|块|万元|千元|万|¥|￥)/.test(t)) return false;
  return true;
}

/**
 * 识别统计诉求。「这个月支出多少」「10月支出合计是多少」这类问句也算，
 * 不能因为没有「统计」二字就放行到记账分支。
 */
export function parseStatsCommand(text: string, now: Date = new Date()): StatsPlan | null {
  const t = normalizeOperationText(text);
  if (!t) return null;
  const hasExplicitStatsWord = /(统计|算一下|统计一下|汇总)/.test(t);
  const hasQuestionWord = /(多少|几笔|几号|合计|总额|占比|排行|平均)/.test(t);
  if (!hasExplicitStatsWord && !hasQuestionWord) return null;
  // 「买了统计软件50元」这类记账描述里的「统计」不是指令，也不是统计诉求。
  const hasTransactionVerb = /(买|卖|付|支付|收到|转入|转出|充值|还款|消费|退款|报销|缴)/.test(t);
  const hasAmountWithUnit = /\d+(\.\d+)?\s*(元|块|万元|千元|万|¥|￥)/.test(t);
  if (hasTransactionVerb && hasAmountWithUnit) return null;
  // 带金额单位的记账描述（"今天买菜一共50元"）不算统计。
  if (!hasExplicitStatsWord && hasAmountWithUnit) return null;

  const metric = /(多少钱|金额|总额|合计|多少)/.test(t) && !/(几笔|多少笔|笔数)/.test(t) ? "sum" : "count";
  const type = /收入/.test(t) ? TransactionType.income : /转账/.test(t) ? TransactionType.transfer : TransactionType.expense;

  let year: number | undefined = undefined;
  const yearMatch = t.match(/(\d{4})年/);
  if (yearMatch) year = Number(yearMatch[1]);

  let month: number | undefined = undefined;
  const monthMatch = t.match(/(\d{1,2})月/);
  if (monthMatch) month = Number(monthMatch[1]);

  if (month === undefined && year === undefined) {
    if (/(这个月|本月|当月)/.test(t)) {
      year = now.getFullYear();
      month = now.getMonth() + 1;
    } else if (/(上个月|上月)/.test(t)) {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      year = prev.getFullYear();
      month = prev.getMonth() + 1;
    } else if (/(今年|本年)/.test(t)) {
      year = now.getFullYear();
    }
  }
  // 只说了月份没说年份时按当前年份理解；否则 executeStatsPlan 会因为 year 缺失而整段忽略时间条件。
  if (month !== undefined && year === undefined) year = now.getFullYear();

  let accountKeyword: string | undefined = undefined;
  const bankKey = extractBankKeywordFromBill(t);
  if (bankKey) accountKeyword = bankKey;

  return { metric: metric as "count" | "sum", type, year, month, accountKeyword };
}

const QUERY_NOT_RECORDED_HINT =
  "这句话看起来是在查询已有数据，已按查询处理，没有记成流水。目前支持的说法例如：「统计本月支出总额」「统计10月收入」「这个月支出多少」「查看回收站最近5条」。";

export function buildQueryNotRecordedResponse(text: string) {
  return {
    ok: true as const,
    operation: "chat" as const,
    reply: QUERY_NOT_RECORDED_HINT,
    trace: [`识别为数据查询（不记账）：${text.slice(0, 60)}`, "未生成任何流水"],
  };
}
