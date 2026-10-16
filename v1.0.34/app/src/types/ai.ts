import type { Judgement } from './entities';

/* ============================================================================
 * 一句话记账（AI 助手）草稿结构
 * ==========================================================================*/

export type AiAction =
  | 'create_goods'
  | 'create_subscription'
  | 'create_ledger'
  | 'create_mood'
  | 'create_time'
  | 'retire_sell'
  | 'unknown';

/** 物品草稿。 */
export interface GoodsDraft {
  name: string;
  price: number;
  currency: string;
  buyDate: string;
  categoryId: string;
  icon: string;
  tags: string[];
  note?: string;
  channel?: string;
}

/** 订阅草稿。 */
export interface SubDraft {
  name: string;
  amount: number;
  currency: string;
  period: 'month' | 'year' | 'week';
  every: number;
  categoryId: string;
  icon: string;
}

/** 生活流草稿。 */
export interface LedgerDraft {
  type: 'expense' | 'income';
  amount: number;
  categoryId: string;
  judgement: Judgement;
  date: string;
  note: string;
}

/** 情绪草稿。 */
export interface MoodDraft {
  feeling: string;
  text: string;
}

/** 时间记录草稿。 */
export interface TimeDraft {
  durationMin: number;
  tags: string[];
  meaning: Judgement;
  note: string;
}

/** 退役/转卖草稿。 */
export interface RetireDraft {
  /** 用于唯一定位物品库中的物品 */
  match: string;
  sellPrice: number;
}

/** AI 解析出的单条结果。 */
export interface AiResultItem {
  action: AiAction;
  goodsDraft?: GoodsDraft;
  subDraft?: SubDraft;
  ledgerDraft?: LedgerDraft;
  moodDraft?: MoodDraft;
  timeDraft?: TimeDraft;
  retireDraft?: RetireDraft;
  explanation?: string;
  source: 'ai' | 'local';
}

/** AI 配置（App 内自填，直连第三方，不经 PHP 后端）。 */
export interface AiConfig {
  endpoint: string;
  key: string;
  model: string;
}

/** `chat/completions` 消息。 */
export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** 文本消息为 string；vision（识图）消息为 content 数组（文本 + image_url）。 */
  content: string | ChatContentPart[];
}

/** parseService 的输出（含降级来源说明）。 */
export interface ParseOutcome {
  items: AiResultItem[];
  source: 'ai' | 'local';
  /** 降级原因（AI 未配置 / 调用失败 / 返回非法），供 UI 提示 */
  reason?: string;
}
