import type { ApiError } from '../lib/error';
import type { AiResultItem } from './ai';

/* ============================================================================
 * 纳物 · 本地数据模型
 *
 * ⚠️ 字段与键名必须与 Web 版字节级一致，否则 App 与 Web 的备份无法互通。
 *    12 个集合键名：`flyme.<collection>`；KV 前缀：`flyme.kv.`。
 * ==========================================================================*/

/** 归 / 需 / 否 —— 每一笔支出的价值判断。 */
export type Judgement = 'gui' | 'xu' | 'fou';

/** 分类归属：物品 / 订阅 / 生活流。 */
export type CategoryKind = 'goods' | 'sub' | 'ledger';

/** 分类。id 固定 `cg0..cg12` / `cs0..cs5` / `cl0..cl7`。 */
export interface Category {
  id: string;
  name: string;
  icon: string;
  kind: CategoryKind;
  order: number;
}

/** ★核心：生活流（记一笔）。 */
export interface ValueRecord {
  id: string;
  type: 'expense' | 'income';
  amount: number;
  currency: string;
  /** 业务日期 'YYYY-MM-DD' */
  date: string;
  /** cl0..cl7 */
  categoryId: string;
  judgement: Judgement;
  note?: string;
  /** ISO 8601 UTC */
  createdAt: string;
}

/** 物品附加费用（运费/配件/维修……）。 */
export interface ExtraFee {
  name: string;
  amount: number;
}

/** 物品图片（P0 只用系统 emoji：`{ source:'system', ref:'🎧' }`）。 */
export interface GoodsImage {
  source: string;
  ref: string;
}

/** 保修提醒。 */
export interface WarrantyRemind {
  on: boolean;
  leadDays: number;
  /** 'HH:mm' */
  time: string;
}

/** 物品。 */
export interface Goods {
  id: string;
  name: string;
  /** cg0..cg12 */
  categoryId: string;
  tags: string[];
  price: number;
  currency: string;
  /** 'YYYY-MM-DD' */
  buyDate: string;
  status: 'active' | 'retired' | 'favorite';
  image?: GoodsImage;
  note?: string;
  extraFees: ExtraFee[];
  incomes: unknown[];
  sellPrice?: number;
  targetDailyCost?: number;
  countEnabled?: boolean;
  totalCount?: number;
  usedCount?: number;
  warrantyDate?: string;
  warrantyRemind?: WarrantyRemind;
  createdAt: string;
  updatedAt: string;
}

/** 订阅。status 恒为 'active'（主理人拍板：不加 paused，停用语义用「退役」近似）。 */
export interface Subscription {
  id: string;
  name: string;
  /** cs0..cs5 */
  categoryId: string;
  icon: string;
  currency: string;
  type: 'recurring' | 'lifetime';
  period: 'month' | 'year' | 'week';
  every: number;
  amount: number;
  /** 'YYYY-MM-DD' */
  startDate: string;
  nextRenewDate: string;
  autoRenew: boolean;
  initSpent?: number;
  status: string;
  remind: { renewLead: number };
  createdAt: string;
  updatedAt: string;
}

/** 订阅扣款流水。
 *  ★v1.0.21 账单四态：pending=待确认 / paid=已支付 / skipped=已跳过 / failed=失败（待补记）。 */
export interface Bill {
  id: string;
  subId: string;
  /** 'YYYY-MM-DD' */
  dueDate: string;
  amount: number;
  currency: string;
  status: 'paid' | 'pending' | 'skipped' | 'failed';
  paidDate?: string;
  refund?: number;
  createdAt: string;
}

/** 情绪记录。 */
export interface Mood {
  id: string;
  feeling: string;
  text: string;
  crushed: boolean;
  inHeart: boolean;
  date: string;
  createdAt?: string;
}

/** 时间记录。 */
export interface TimeRec {
  id: string;
  durationMin: number;
  tags: string[];
  meaning: Judgement;
  date: string;
  note?: string;
  createdAt?: string;
}

/** 使用打卡（物品「+1」）。 */
export interface UsageRecord {
  id: string;
  goodsId: string;
  date: string;
  createdAt: string;
}

/** 心愿单（冷却期前的「想要」）。 */
export interface WishItem {
  id: string;
  name: string;
  price?: number;
  url?: string;
  note?: string;
  /** v1.0.22 对标竞品「种下一颗草」：商品图（icon 三形态值：img: / url: / brand:）。 */
  image?: string;
  /** 心动理由（多选标签，lucide 语义 key）。 */
  reasons?: string[];
  /** 渠道（淘宝/京东…，也可并入 note，独立存便于筛选）。 */
  channel?: string;
  createdAt: string;
}

/** 冷却期（想买但先等等）。 */
export interface Cooldown {
  id: string;
  name: string;
  /** ISO 日期（天数冷静期）；小时级冷静期用 untilAt 精确到时刻。 */
  until: string;
  /** v1.0.22「冲动冷冻」：小时级冷静（3h/24h/3d/7d/30d），untilAt = 精确到期时刻（ISO）。 */
  hours?: number;
  untilAt?: string;
  /** 冲动金额（选填）。 */
  amount?: number;
  /** 冲动来源（限时打折/压力发泄…）。 */
  reason?: string;
  /** 商品链接 / 商品图（选填）。 */
  url?: string;
  image?: string;
  createdAt: string;
}

/** 提醒（保修 / 续费）。 */
export interface Reminder {
  id: string;
  kind: 'goods_warranty' | 'sub_renew';
  refId: string;
  at: string;
  done: boolean;
  createdAt: string;
}

/** 心墙（一句话）。 */
export interface Wall {
  id: string;
  text: string;
  color?: string;
  createdAt: string;
}

/** 12 个集合名的有序常量（快照与恢复都按此顺序）。 */
export const COLLECTIONS = [
  'goods',
  'subscriptions',
  'bills',
  'valueRecords',
  'moods',
  'times',
  'wishlist',
  'cooldowns',
  'categories',
  'usageRecords',
  'reminders',
  'walls',
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

/** 集合名 → 元素类型映射（12 项齐全，供泛型仓库使用）。 */
export interface CollectionTypeMap {
  goods: Goods;
  subscriptions: Subscription;
  bills: Bill;
  valueRecords: ValueRecord;
  moods: Mood;
  times: TimeRec;
  wishlist: WishItem;
  cooldowns: Cooldown;
  categories: Category;
  usageRecords: UsageRecord;
  reminders: Reminder;
  walls: Wall;
}

/* ============================================================================
 * 设置（与 Web 版默认值逐字段一致）
 * ==========================================================================*/

export type ThemeMode = 'system' | 'light' | 'dark';

export interface Settings {
  baseCurrency: string;
  currency: string;
  rates: Record<string, number>;
  ratesUpdatedAt: string;
  includeRetired: boolean;
  useDepreciation: boolean;
  theme: ThemeMode;
  palette: string;
  showIcon: boolean;
  showBuyDate: boolean;
  showWarrantyCountdown: boolean;
  formatDaysAsYmd: boolean;
  vibrate: boolean;
  /** v1.0.17：品牌开屏动画开关（参考竞品「显示偏好 → 开屏」）。 */
  splash: boolean;
  reminderMaster: boolean;
  homeTab: string;
  viewMode: 'list' | 'grid';
  sortBy: string;
  /** ISO；空串表示从未备份 */
  lastBackupAt: string;
  autoSync: boolean;
  aiEndpoint: string;
  aiKey: string;
  aiModel: string;
  /**
   * ★App 端扩展键：已停用/归档的订阅 id 列表。
   * 归档状态**必须**存这里而不是写在 Subscription 记录上 ——
   * 快照恢复时 collections 会被整体替换（记录上的自定义字段必丢），
   * 而 settings 是合并展开（未知键保留），见 storage/snapshot.ts 的说明。
   * 这是唯一允许新增到 Settings 的 App 自定义键（可选键），勿再散落其他键。
   */
  archivedSubIds?: string[];
}

/* ============================================================================
 * 服务器 / 会话 / 连接
 * ==========================================================================*/

export interface ServerConfig {
  /** 'srv_' + newId() */
  id: string;
  alias: string;
  /** 归一化后：'http://192.168.1.100:3030'（无尾斜杠、无 path） */
  url: string;
  note?: string;
  createdAt: string;
  lastConnectedAt?: string;
  lastOk?: boolean;
}

export type SessionState = 'unknown' | 'valid' | 'expired' | 'offline';

export interface UserInfo {
  id: string;
  email: string;
  display_name: string | null;
  verified: boolean;
}

export interface Session {
  token: string;
  user: UserInfo;
  savedAt: string;
}

export type ProbeState =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'online'; dbOk: boolean; serverTime: string }
  | { kind: 'error'; error: ApiError };

/** `flyme.ui` 内容。 */
export interface UiState {
  offlineMode: boolean;
  homeTab: string;
  lastRoute: string;
}

/** `flyme.kv.backupMeta` 内容（自动备份节流用）。 */
export interface BackupMeta {
  lastBackupAt: string;
  lastCount: number;
  changedSinceBackup: number;
}

/** 撤销栈条目。 */
export interface UndoEntry {
  label: string;
  collection: CollectionName;
  rows: unknown[];
  at: string;
}

/** P11 确认页用的可编辑草稿行（AI 结果 + 用户勾选 + 用户改写）。 */
export interface DraftItem {
  /** 行内唯一 key */
  key: string;
  checked: boolean;
  item: AiResultItem;
  /** 用户编辑后的字段 */
  edit?: Partial<NonNullable<AiResultItem['ledgerDraft']>>;
}
