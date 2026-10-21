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
  /** ★v1.3.6 二手买卖一体：买入入库 + 卖出退役，一次确认跑完。 */
  | 'trade_goods'
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
  /** ★v1.2.1 口头语/识图提取的干净名称（「在斤大米」→「大米」）；缺省时由 note 派生。 */
  name?: string;
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

/**
 * ★v1.3.6 二手买卖一体草稿（「买入 A 360，卖出 560，手续费千分之6、快递20、杂费10」）。
 *
 * 落库形状刻意复用既有字段：
 * - 物品：`price = buyPrice`、`extraFees = [手续费, 快递费, 杂费]`、`sellPrice`、`status = retired`；
 * - 生活流：由 `syncSaleIncome` 按 `sellPrice − (price + extraFees)` 自动生成，
 *   不新增表、不新增口径，净赚/日均/报表全部自动对齐。
 */
export interface TradeDraft {
  name: string;
  buyPrice: number;
  sellPrice: number;
  buyDate: string;
  currency: string;
  categoryId: string;
  /** 手续费费率，**千分比**（千分之 6 → 6，0.6% → 6）。0 表示用户没提。 */
  feeRatePermille: number;
  /** 手续费绝对值（用户直接说了「手续费 3.4 元」时用）。 */
  feeAmount: number;
  shippingFee: number;
  extraFee: number;
  note?: string;
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
  /** ★v1.2.0 来源分句原文（本地解析必定带上；AI 路径在条数与分句数一致时补齐）。
   *  供「用户手动纠正分类 → 沉淀学习样本」溯源，不参与落库。 */
  rawText?: string;
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
