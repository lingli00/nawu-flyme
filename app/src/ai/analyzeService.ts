import { chatComplete } from '../net/aiClient';
import { round } from '../lib/money';
import { aiConfigOf, isAiConfigured } from './parseService';
import type { AiConfig } from '../types/ai';
import type { Settings } from '../types/entities';

/**
 * ★v1.1.3 · AI 分析（报表页「AI 分析」卡片）。
 *
 * 解决的老问题：设置页明明能配 API，配完却没有任何地方消费它——
 * 用户原话「如何调用使用呢？那他在干什么呢？」。
 * 现在 AI 有两个明确用途：
 *   ① AI 记一笔（ai/parseService，一句话/识图解析）；
 *   ② 本服务：报表页按当前粒度聚合数据 → 本地规则洞察 + AI 点评。
 *
 * 设计约束：
 * - 本地规则洞察**始终产出**（AI 未配置/调用失败都有内容看），AI 只做增强；
 * - service 不自己扫集合，页面聚合好 payload 再传进来（保持纯函数可测）；
 * - 未配置时不发任何网络请求（parseService 同款短路）。
 */

/** 分析输入：页面按当前粒度聚合好的数据。 */
export interface AnalyzeInput {
  /** 窗口标签，如 '2026-10' / '2026-10-06' / '2026' */
  windowLabel: string;
  currency: string;
  income: number;
  expense: number;
  /** 支出 Top 分类（含占比 0~1） */
  topCategories: Array<{ name: string; amount: number; ratio: number }>;
  /** 归/需/否（含占比 0~1） */
  judgement: Array<{ label: string; amount: number; ratio: number }>;
  /** 趋势序列（近 7 天 / 近 6 月 / 全年 12 月） */
  trend: Array<{ label: string; expense: number; income: number }>;
  /** 转卖净赚合计（v1.1.3：src='goods-sale' 的生活流收入） */
  saleProfit: number;
  /** 窗口内记账条数 */
  recordCount: number;
}

/** 分析输出。 */
export interface AnalyzeOutcome {
  /** 本地规则洞察（始终有，除非完全没有数据） */
  local: string[];
  /** AI 点评（未配置 / 调用失败为 null） */
  ai: string | null;
  source: 'ai' | 'local';
  /** 降级原因（未配置 / 调用失败），供 UI 提示 */
  reason?: string;
}

const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/**
 * 本地规则洞察（纯函数，无网络）。
 *
 * 口径与报表页展示完全一致（同一份 windowRows 聚合结果），
 * 避免「图上一个数、分析里另一个数」。
 */
export function localInsights(input: AnalyzeInput): string[] {
  const out: string[] = [];
  const { income, expense, topCategories, judgement, trend, saleProfit, recordCount } = input;
  const net = round(income - expense);

  if (recordCount === 0) {
    return ['本期还没有记账记录，先记几笔，再来看看分析。'];
  }

  // 1) 收支全景
  if (income === 0 && expense > 0) {
    out.push(`本期只有支出、没有收入记录：花出 ${expense.toFixed(2)}，结余显示为负是口径使然，不代表负债。`);
  } else if (net < 0) {
    out.push(`本期花得比收得多，净流出 ${Math.abs(net).toFixed(2)}。`);
  } else if (net > 0) {
    out.push(`本期收大于支，结余 ${net.toFixed(2)}。`);
  } else {
    out.push('本期收支正好相抵。');
  }

  // 2) 支出结构
  const top = topCategories[0];
  if (top && expense > 0) {
    if (top.ratio >= 0.4) {
      out.push(`「${top.name}」是支出大头，占 ${pct(top.ratio)}（${top.amount.toFixed(2)}）——想省钱先看这一类。`);
    } else if (top.ratio < 0.25 && topCategories.length >= 3) {
      out.push(`支出比较分散：最大的「${top.name}」也只占 ${pct(top.ratio)}，没有单一巨头。`);
    }
  }

  // 3) 归 / 需 / 否
  const fou = judgement.find((j) => j.label === '否');
  if (fou && fou.amount > 0 && expense > 0) {
    if (fou.ratio >= 0.2) {
      out.push(`「本可避免」的花销占 ${pct(fou.ratio)}（${fou.amount.toFixed(2)}）——下单前可以先丢进冷却期冷静一下。`);
    } else {
      out.push(`「本可避免」只占 ${pct(fou.ratio)}，消费自律保持得不错。`);
    }
  } else if (expense > 0) {
    out.push('本期没有「否」类花销，每一笔都花得有理。');
  }

  // 4) 趋势（最近一期 vs 此前均值）
  if (trend.length >= 2) {
    const last = trend[trend.length - 1]!;
    const prev = trend.slice(0, -1);
    const avg = round(prev.reduce((s, p) => s + p.expense, 0) / prev.length);
    if (avg > 0) {
      const diff = last.expense - avg;
      const ratio = Math.abs(diff) / avg;
      if (ratio >= 0.2) {
        out.push(
          diff > 0
            ? `最近一期（${last.label}）支出 ${last.expense.toFixed(2)}，比此前均值高 ${pct(ratio)}。`
            : `最近一期（${last.label}）支出 ${last.expense.toFixed(2)}，比此前均值低 ${pct(ratio)}。`,
        );
      }
    }
  }

  // 5) 转卖净赚（v1.1.3）
  if (saleProfit > 0) {
    out.push(`转卖净赚 ${saleProfit.toFixed(2)} 已计入本期收入——物品回血也是真金白银。`);
  }

  return out;
}

/** 分析用的系统提示词（与记一笔的 SYSTEM_PROMPT 相互独立）。 */
const ANALYZE_SYSTEM_PROMPT = `你是「纳物」的消费分析助手。用户会给你一段 JSON，是他某个周期（日/月/年）的记账聚合数据。
请基于这些数据给出 3~5 条简短中文洞察或建议，要求：
1. 每条一行，直接说，不用「首先/其次/总结」这类词，不要小标题。
2. 只说数据里能看出来的事，不要编造数字，不要复述题干。
3. 可以指出现金流结构、支出集中度、归需否比例、趋势变化，并给一条最值得行动的建议。
4. 语气像朋友聊天，不说教，总长度控制在 150 字以内。`;

/** 调 AI 生成点评（裸文本，失败抛错由调用方降级）。 */
export async function aiAnalyze(cfg: AiConfig, input: AnalyzeInput): Promise<string> {
  const payload = {
    周期: input.windowLabel,
    币种: input.currency,
    收入: input.income,
    支出: input.expense,
    记账条数: input.recordCount,
    支出Top分类: input.topCategories.slice(0, 5).map((c) => ({ 分类: c.name, 金额: c.amount, 占比: pct(c.ratio) })),
    归需否: input.judgement.map((j) => ({ 判断: j.label, 金额: j.amount, 占比: pct(j.ratio) })),
    趋势: input.trend.map((t) => ({ 期: t.label, 支出: t.expense, 收入: t.income })),
    转卖净赚: input.saleProfit,
  };
  const text = await chatComplete(
    cfg,
    [
      { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    30000,
  );
  return (text ?? '').trim();
}

/**
 * 分析主入口：本地洞察 + AI 增强。
 *
 * - 未配置 AI：直接返回本地洞察（**不发请求**），reason 说明去哪配；
 * - AI 调用失败：本地洞察照常返回，reason 带上失败原因。
 */
export async function analyze(input: AnalyzeInput, settings: Settings | null | undefined): Promise<AnalyzeOutcome> {
  const local = localInsights(input);
  const cfg = aiConfigOf(settings);
  if (!isAiConfigured(cfg)) {
    return { local, ai: null, source: 'local', reason: '未配置 AI：以下为本地规则洞察。设置里填好接口即可获得 AI 点评。' };
  }
  try {
    const ai = await aiAnalyze(cfg, input);
    if (!ai) return { local, ai: null, source: 'local', reason: 'AI 返回为空，以下为本地规则洞察。' };
    return { local, ai, source: 'ai' };
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : '未知错误';
    return { local, ai: null, source: 'local', reason: `AI 调用失败（${msg}），以下为本地规则洞察。` };
  }
}
