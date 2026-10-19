import { today as todayStr } from '../lib/date';
import { emojiForName, toJudgement } from '../lib/emoji';
import logger from '../lib/log';
import { chatJsonArray } from '../net/aiClient';
import { chatComplete } from '../net/aiClient';
import { SYSTEM_PROMPT } from './prompt';
import { convertItem, switchableKindOf } from './convert';
import { matchLearnedRule, type LearnedRule } from './ruleBank';
import type { ChatContentPart, ChatMessage } from '../types/ai';
import type { AiConfig } from '../types/ai';
import type { AiResultItem, ParseOutcome } from '../types/ai';
import type { Category, Judgement, Settings } from '../types/entities';
import { splitSentences } from './split';
import { buildMessages } from './prompt';
import { categoryIdByName, defaultCategoryId, parseLocal } from './localParser';
import { orderNote, orderSentence, parseOrderShot } from './orderShot';

/**
 * 解析编排（架构 §5.2）：
 * 分句 → AI（OpenAI 兼容直连）→ 失败/未配置时回落 `localParser` → 归一化成 `AiDraft[]`。
 */

/** 解析上下文。 */
export interface ParseContext {
  categories: Category[];
  settings?: Settings | null;
  /** 参考「今天」，默认真实今天 */
  today?: string;
  /** ★v1.2.0 本地自学习规则（用户人工纠正样本，优先级高于静态规则）。 */
  learned?: LearnedRule[] | null;
}

/** 从 settings 里取 AI 配置。 */
export function aiConfigOf(settings: Settings | null | undefined): AiConfig {
  return {
    endpoint: settings?.aiEndpoint ?? '',
    key: settings?.aiKey ?? '',
    model: settings?.aiModel ?? 'gpt-4o-mini',
  };
}

/** AI 是否已配置（未配置直接走本地规则，不再浪费一次网络往返）。 */
export function isAiConfigured(cfg: AiConfig): boolean {
  return Boolean(cfg.endpoint && cfg.endpoint.trim()) && Boolean(cfg.key && cfg.key.trim());
}

/** 把 AI 返回的原始对象归一化成 AiResultItem（脏数据容错）。 */
export function fromAiRaw(
  raw: Record<string, unknown>,
  categories: Category[],
  ctx: { today: string; currency: string },
): AiResultItem | null {
  const action = String(raw.action ?? 'unknown');
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
    return Number.isFinite(n) ? n : 0;
  };
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

  switch (action) {
    case 'create_goods': {
      const name = str(raw.name, '物品');
      return {
        action: 'create_goods',
        goodsDraft: {
          name,
          price: num(raw.price),
          currency: str(raw.currency, ctx.currency),
          buyDate: str(raw.buyDate, ctx.today),
          categoryId:
            categoryIdByName(str(raw.category), categories, 'goods') ||
            defaultCategoryId(categories, 'goods'),
          icon: str(raw.icon) || emojiForName(name),
          tags: Array.isArray(raw.tags) ? (raw.tags as string[]).map((t) => String(t)) : [],
          note: str(raw.note),
          channel: str(raw.channel),
        },
        explanation: 'AI 解析：买入物品',
        source: 'ai',
      };
    }
    case 'create_subscription': {
      const name = str(raw.name, '订阅');
      const periodRaw = str(raw.period, 'month');
      return {
        action: 'create_subscription',
        subDraft: {
          name,
          amount: num(raw.amount),
          currency: str(raw.currency, ctx.currency),
          period: periodRaw === 'year' || periodRaw === 'week' ? periodRaw : 'month',
          every: Math.max(Math.round(num(raw.every)) || 1, 1),
          categoryId:
            categoryIdByName(str(raw.subCategory) || str(raw.category), categories, 'sub') ||
            defaultCategoryId(categories, 'sub'),
          icon: str(raw.icon) || emojiForName(name),
        },
        explanation: 'AI 解析：订阅',
        source: 'ai',
      };
    }
    case 'create_ledger': {
      const categoryId =
        categoryIdByName(str(raw.category), categories, 'ledger') ||
        defaultCategoryId(categories, 'ledger');
      const type = raw.type === 'income' ? 'income' : 'expense';
      const judgement: Judgement = toJudgement(raw.judgement, type === 'income' ? 'gui' : 'xu');
      return {
        action: 'create_ledger',
        ledgerDraft: {
          type,
          amount: num(raw.amount),
          categoryId,
          judgement,
          date: str(raw.date, ctx.today),
          note: str(raw.note),
        },
        explanation: 'AI 解析：生活流',
        source: 'ai',
      };
    }
    case 'create_mood':
      return {
        action: 'create_mood',
        moodDraft: { feeling: str(raw.feeling, '🙂'), text: str(raw.text) },
        explanation: 'AI 解析：情绪',
        source: 'ai',
      };
    case 'create_time': {
      const meaning: Judgement = toJudgement(raw.meaning, 'xu');
      return {
        action: 'create_time',
        timeDraft: {
          durationMin: num(raw.durationMin),
          tags: Array.isArray(raw.tags) ? (raw.tags as string[]).map((t) => String(t)) : [],
          meaning,
          note: str(raw.note),
        },
        explanation: 'AI 解析：时间记录',
        source: 'ai',
      };
    }
    case 'retire_sell':
      return {
        action: 'retire_sell',
        retireDraft: { match: str(raw.match), sellPrice: num(raw.sellPrice) },
        explanation: 'AI 解析：退役转卖',
        source: 'ai',
      };
    default:
      return null;
  }
}

/** 归一化：补全 currency/date/categoryId，过滤 unknown 与空金额的无意义结果。 */
export function normalizeItems(
  items: AiResultItem[],
  categories: Category[],
  ctx: { today: string; currency: string },
): AiResultItem[] {
  const out: AiResultItem[] = [];
  for (const item of items) {
    if (!item || item.action === 'unknown') continue;

    if (item.ledgerDraft) {
      item.ledgerDraft.amount = Number.isFinite(item.ledgerDraft.amount) ? item.ledgerDraft.amount : 0;
      if (!item.ledgerDraft.date) item.ledgerDraft.date = ctx.today;
      if (!item.ledgerDraft.categoryId) item.ledgerDraft.categoryId = defaultCategoryId(categories, 'ledger');
      // 收入默认判「归」，支出默认「需」
      if (!item.ledgerDraft.judgement) {
        item.ledgerDraft.judgement = item.ledgerDraft.type === 'income' ? 'gui' : 'xu';
      }
    }
    if (item.goodsDraft) {
      if (!item.goodsDraft.buyDate) item.goodsDraft.buyDate = ctx.today;
      if (!item.goodsDraft.currency) item.goodsDraft.currency = ctx.currency;
      if (!item.goodsDraft.categoryId) item.goodsDraft.categoryId = defaultCategoryId(categories, 'goods');
      if (!item.goodsDraft.icon) item.goodsDraft.icon = emojiForName(item.goodsDraft.name);
    }
    if (item.subDraft) {
      if (!item.subDraft.currency) item.subDraft.currency = ctx.currency;
      if (!item.subDraft.categoryId) item.subDraft.categoryId = defaultCategoryId(categories, 'sub');
      if (!item.subDraft.every) item.subDraft.every = 1;
      if (!item.subDraft.icon) item.subDraft.icon = emojiForName(item.subDraft.name);
    }
    out.push(item);
  }
  return out;
}

/** 只跑本地规则（AI 未配置 / 调用失败时的兜底路径）。 */
export function parseLocalOnly(text: string, ctx: ParseContext): ParseOutcome {
  const today = ctx.today ?? todayStr();
  const currency = ctx.settings?.currency || 'CNY';
  const sentences = splitSentences(text);
  const items = sentences
    .map((s) => parseLocal(s, ctx.categories, { today, currency, learned: ctx.learned }))
    .filter((i) => i.action !== 'unknown');
  return { items: normalizeItems(items, ctx.categories, { today, currency }), source: 'local' };
}

/**
 * ★v1.2.0 学习规则后处理：AI 路径同样受「用户人工纠正样本」约束。
 *
 * 仅当「结果条数与分句数一致」时按序号对齐（多句合并等场景不猜，直接放过）。
 * 情绪 / 时间 / 退役等动作没有分类字段，不参与覆盖。
 */
export function applyLearnedRules(
  items: AiResultItem[],
  sentences: string[],
  learned: LearnedRule[] | null | undefined,
  categories: Category[],
  today: string,
): AiResultItem[] {
  if (!learned || learned.length === 0 || items.length === 0) return items;
  if (items.length !== sentences.length) return items;
  return items.map((it, i) => {
    const rule = matchLearnedRule(sentences[i] ?? '', learned);
    if (!rule) return it;
    const cur = switchableKindOf(it);
    if (!cur) return it;
    const catId = categoryIdByName(rule.categoryName, categories, rule.kind);
    let next = cur === rule.kind ? it : convertItem(it, rule.kind, categories, today);
    if (catId) {
      if (next.goodsDraft) next = { ...next, goodsDraft: { ...next.goodsDraft, categoryId: catId } };
      else if (next.subDraft) next = { ...next, subDraft: { ...next.subDraft, categoryId: catId } };
      else if (next.ledgerDraft) next = { ...next, ledgerDraft: { ...next.ledgerDraft, categoryId: catId } };
    }
    return next;
  });
}

/**
 * 一句话记账主入口。
 *
 * - 已配置 AI：先试 AI，失败（网络/超时/非法 JSON）自动回落本地规则
 * - 未配置 AI：直接用本地规则（**不会抛错**，保证离线可用）
 *
 * @returns `{ items, source, reason }`，UI 依 source 提示「由本地规则解析」
 */
export async function parse(text: string, ctx: ParseContext): Promise<ParseOutcome> {
  const today = ctx.today ?? todayStr();
  const currency = ctx.settings?.currency || 'CNY';
  const sentences = splitSentences(text);
  if (sentences.length === 0) return { items: [], source: 'local', reason: '没有可解析的内容' };

  const cfg = aiConfigOf(ctx.settings);
  if (!isAiConfigured(cfg)) {
    return { ...parseLocalOnly(text, ctx), reason: '未配置 AI，已使用本地规则解析' };
  }

  try {
    const messages = buildMessages(sentences, ctx.categories);
    const rawList = await chatJsonArray(cfg, messages);
    const items = (rawList as Record<string, unknown>[])
      .map((raw) => (raw && typeof raw === 'object' ? fromAiRaw(raw, ctx.categories, { today, currency }) : null))
      .filter((i): i is AiResultItem => i !== null);

    const normalized = normalizeItems(items, ctx.categories, { today, currency });
    if (normalized.length === 0) {
      return { ...parseLocalOnly(text, ctx), reason: 'AI 未识别出有效条目，已使用本地规则解析' };
    }
    // 条数与分句数一致时补齐来源原文（供学习样本溯源），并套用本地学习规则
    const withRaw =
      normalized.length === sentences.length
        ? normalized.map((it, i) => ({ ...it, rawText: sentences[i] }))
        : normalized;
    return { items: applyLearnedRules(withRaw, sentences, ctx.learned, ctx.categories, today), source: 'ai' };
  } catch (e) {
    logger.warn('parse', 'AI 解析失败，回落本地规则', e);
    return { ...parseLocalOnly(text, ctx), reason: 'AI 调用失败，已使用本地规则解析' };
  }
}

/**
 * 识图添加（v1.0.10/v1.0.11）：把账单/票据/物品照片解析成记账条目。
 *
 * - 已配置 AI：vision 多模态（复用 SYSTEM_PROMPT 的 JSON schema 与归一化链路）；
 *   AI 调用失败自动回落本地 OCR；
 * - 未配置 AI：本地算力识别（Tesseract.js OCR 出文字 → 本地规则解析），
 *   **离线可用**，不再直接报错；
 * - 返回与 parse 一致的 ParseOutcome，AiPage 复用同一套确认落库 UI。
 */
export async function parseImage(dataUrl: string, ctx: ParseContext): Promise<ParseOutcome> {
  const cfg = aiConfigOf(ctx.settings);
  if (isAiConfigured(cfg)) {
    try {
      return await parseImageAi(dataUrl, ctx, cfg);
    } catch (e) {
      logger.warn('parseImage', 'AI 识图失败，回落本地 OCR', e);
      return await parseImageLocal(dataUrl, ctx, 'AI 识图失败，已用本地识别');
    }
  }
  return await parseImageLocal(dataUrl, ctx, '未配置 AI，已用本地识别');
}

/** vision 识别路径（须已配置 AI；失败抛错由调用方回落）。 */
async function parseImageAi(dataUrl: string, ctx: ParseContext, cfg: AiConfig): Promise<ParseOutcome> {
  const today = ctx.today ?? todayStr();
  const currency = ctx.settings?.currency || 'CNY';

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `这是一张电商订单截图/账单/小票照片。请识别图中**所有**订单并逐条输出（一张图可能有多笔订单）：` +
            `\n1. 金额优先取「实付/实付款/实付价」，不要取商品总价、原价、划线价、优惠前金额；` +
            `\n2. name 只保留商品本身名称（如「大米」「磁轴键盘」），去掉「包邮」「顺丰」「专享」「限时抢购」等营销词和规格描述（如「30斤」「80g×3袋」），规格和数量放 note；` +
            `\n3. note 里写清购买平台/店铺和数量（如「拼多多 · 1件」）；` +
            `\n4. 每笔订单输出一条 JSON 对象，按系统提示词的数组格式输出；识别不到任何可记账内容时输出 []。今天的日期：${today}。`,
        },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] as ChatContentPart[],
    },
  ];

  const rawList = await chatComplete(cfg, messages, 30000).then((c) => {
    // 复用 JSON 数组抽取（容错围栏/前后杂质）
    const start = c.indexOf('[');
    const end = c.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    return JSON.parse(c.slice(start, end + 1)) as Record<string, unknown>[];
  });

  const items = rawList
    .map((raw) => (raw && typeof raw === 'object' ? fromAiRaw(raw, ctx.categories, { today, currency }) : null))
    .filter((i): i is AiResultItem => i !== null);
  const normalized = normalizeItems(items, ctx.categories, { today, currency });
  if (normalized.length === 0) {
    return { items: [], source: 'ai', reason: '图中没有识别出可记账的内容' };
  }
  return { items: normalized, source: 'ai' };
}

/** 本地 OCR 路径：Tesseract.js 出文字 → 本地规则解析（离线可用）。 */
async function parseImageLocal(dataUrl: string, ctx: ParseContext, reason: string): Promise<ParseOutcome> {
  const { ocrLines } = await import('../lib/localOcr');
  const lines = await ocrLines(dataUrl);
  const text = lines.join(' ');
  if (!text) {
    return { items: [], source: 'local', reason: `${reason}，但图中没有识别出文字` };
  }
  // ★v1.2.2 电商订单截图结构化：锚点行切分订单 → 合成句「买了X 1件 花了Y」
  // 复用 parseLocal 的全部分类/自学习/口头语逻辑，再覆写备注（店铺/数量/原文行）。
  // 注意：parseOrderShot 依赖**行边界**，必须用换行还原 OCR 版面（不能空格连接）。
  const hits = parseOrderShot(lines.join('\n'));
  if (hits.length > 0) {
    const today = ctx.today ?? todayStr();
    const currency = ctx.settings?.currency || 'CNY';
    const items = hits
      .map((h) => {
        const base = parseLocal(orderSentence(h), ctx.categories, { today, currency, learned: ctx.learned });
        const note = orderNote(h);
        if (base.ledgerDraft) base.ledgerDraft.note = note;
        if (base.goodsDraft) base.goodsDraft.note = note;
        return base;
      })
      .filter((i) => i.action !== 'unknown');
    const normalized = normalizeItems(items, ctx.categories, { today, currency });
    if (normalized.length > 0) {
      return { items: normalized, source: 'local', reason: `${reason}，识别出 ${normalized.length} 笔订单` };
    }
  }
  const outcome = parseLocalOnly(text, ctx);
  if (outcome.items.length === 0) {
    return { items: [], source: 'local', reason: `${reason}，但文字里没有解析出可记账内容` };
  }
  return { ...outcome, reason };
}
