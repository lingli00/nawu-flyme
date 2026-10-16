import { addDays, today as todayStr } from '../lib/date';
import { emojiForName } from '../lib/emoji';
import { toJudgement } from '../lib/emoji';
import type { AiResultItem, GoodsDraft, LedgerDraft, SubDraft, TimeDraft } from '../types/ai';
import type { Category, Judgement } from '../types/entities';
import { cnToNumber, isAmountLike, toNumber, CN_NUM_CHARS } from './cnNumber';
import {
  CATEGORY_KEYWORDS,
  CHANNEL_WORDS,
  GOODS_KEYWORDS,
  MEAL_MAP,
  MOOD_EMOJI,
  QUANTIFIER_RE,
  RE_BUY_GOODS,
  RE_CONSUMABLE,
  RE_DURATION,
  RE_EAT,
  RE_GROWTH,
  RE_IMPULSE,
  RE_INCOME,
  RE_MEAL,
  RE_MOOD,
  RE_SELL,
  RE_SUBSCRIPTION,
  RE_TIME_BAD,
  RE_TIME_GOOD,
  RE_TRAFFIC,
  RELATIVE_DAYS,
  SUB_KEYWORDS,
  TIME_TO_MEAL,
} from './keywords';

/**
 * 本地规则解析器（**未配置 AI / AI 调用失败时的兜底**，行为与 Web 版等价）。
 *
 * 流程：金额提取 → 动作判定 → 餐次/分类/日期 → judgement → note 清洗。
 */

/** 金额候选字符：阿拉伯数字或中文数字。 */
const NUM = `(?:\\d+(?:\\.\\d+)?|[${CN_NUM_CHARS}]+)`;

/** ① 动词 + 金额：`花了30` / `一共两千`。 */
const RE_VERB = new RegExp(`(?:花了|花费|用了|支付了?|付款|实付|付了|一共|总共|价格是?|掏了|砸了|充值)\\s*(${NUM})`, 'g');
/** ② 金额 + 单位：`30块` / `¥88` / `两千元`。 */
const RE_UNIT = new RegExp(`(${NUM})\\s*(?:块钱|块|元|￥|¥)`, 'g');
/** ③ 卖出：`卖了1200`。 */
const RE_SELL_AMOUNT = new RegExp(`(?:卖了|卖掉|出掉|出售|回血|转让)\\s*(${NUM})`, 'g');
/** ④ 周期卡：`月卡25` / `包年198`。 */
const RE_CARD = new RegExp(`(?:月卡|年卡|季卡|周卡|包月|包年)\\s*(${NUM})`, 'g');

/** 命中结果。 */
export interface AmountHit {
  value: number;
  raw: string;
  index: number;
}

/** 判断是否有明确的「钱」线索（用于区分时间记录与记账）。 */
function hasMoneyCue(text: string): boolean {
  return (
    RE_VERB.test(text) ||
    RE_UNIT.test(text) ||
    RE_SELL_AMOUNT.test(text) ||
    RE_CARD.test(text) ||
    /[元块¥￥]/.test(text)
  );
}

/**
 * 金额提取：按 动词 → 单位 → 卖出 → 周期卡 的顺序取**最先命中**，
 * 都没有时兜底取最后一个「不像日期」的数字（0 < v < 1e8）。
 */
export function extractAmount(text: string): AmountHit | null {
  const groups: RegExp[] = [RE_VERB, RE_UNIT, RE_SELL_AMOUNT, RE_CARD];
  for (const re of groups) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(text);
    while (m) {
      const v = toNumber(m[1] as string);
      if (isAmountLike(v)) return { value: v, raw: m[0], index: m.index };
      m = re.exec(text);
    }
  }
  return fallbackAmount(text);
}

/** 兜底数字（跳过年/月/日/号 等日期后缀，跳过单个中文数字）。 */
function fallbackAmount(text: string): AmountHit | null {
  const re = new RegExp(`(${NUM})`, 'g');
  const hits: AmountHit[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    const token = m[0];
    const next = text.slice(m.index + token.length, m.index + token.length + 1);
    const isChineseOnly = !/\d/.test(token);
    if (!/^[年月日号点岁度层楼]/.test(next) && !(isChineseOnly && token.length === 1)) {
      const v = toNumber(token);
      if (isAmountLike(v)) hits.push({ value: v, raw: token, index: m.index });
    }
    m = re.exec(text);
  }
  return hits.length ? (hits[hits.length - 1] as AmountHit) : null;
}

/** 相对日期解析：显式 `2026-10-06` 优先，其次 今天/昨天/前天…。 */
export function resolveDate(text: string, refToday: string = todayStr()): string {
  const explicit = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(text);
  if (explicit) {
    const mm = String(explicit[2]).padStart(2, '0');
    const dd = String(explicit[3]).padStart(2, '0');
    return `${explicit[1]}-${mm}-${dd}`;
  }
  for (const [word, offset] of Object.entries(RELATIVE_DAYS)) {
    if (text.includes(word)) return addDays(refToday, offset);
  }
  return refToday;
}

/** 餐次识别：明说优先，其次「时段 + 吃/喝」映射。 */
export function detectMeal(text: string): string {
  RE_MEAL.lastIndex = 0;
  const m = RE_MEAL.exec(text);
  if (m) return MEAL_MAP[m[1] as string] ?? (m[1] as string);
  if (RE_EAT.test(text)) {
    for (const [re, meal] of TIME_TO_MEAL) {
      if (re.test(text)) return meal;
    }
  }
  return '';
}

/** 情绪 emoji。 */
export function moodEmoji(text: string): string {
  for (const [re, emoji] of MOOD_EMOJI) {
    if (re.test(text)) return emoji;
  }
  return '🙂';
}

/**
 * 生活流分类兜底 id（categories 缺失时也能工作）。
 * ★v1.0.0：随生活流分类扩容同步补齐映射。
 */
const LEDGER_FALLBACK_ID: Record<string, string> = {
  餐饮: 'cl0', 交通: 'cl1', 居住: 'cl2', 学习: 'cl3',
  健康: 'cl4', 娱乐: 'cl5', 人情: 'cl6', 其他: 'cl7',
  服饰: 'cl8', 饰品: 'cl9', 食材: 'cl10', 日用: 'cl11', 美妆: 'cl12',
  数码: 'cl13', 通讯: 'cl14', 游戏: 'cl15', 云服务: 'cl16', 宠物: 'cl17',
  旅行: 'cl18', 健身: 'cl19', 母婴: 'cl20', 办公: 'cl21', 保险: 'cl22', 维修: 'cl23',
};

/** 按名称查分类 id。 */
export function categoryIdByName(name: string, categories: Category[], kind: 'goods' | 'sub' | 'ledger'): string {
  if (!name) return '';
  const hit = categories.find((c) => c.kind === kind && c.name === name);
  if (hit) return hit.id;
  if (kind === 'ledger' && LEDGER_FALLBACK_ID[name]) return LEDGER_FALLBACK_ID[name] as string;
  return '';
}

/** 某 kind 的默认 id（查不到就取该 kind 第一条，ledger 兜底 cl7）。 */
export function defaultCategoryId(categories: Category[], kind: 'goods' | 'sub' | 'ledger'): string {
  const first = categories.find((c) => c.kind === kind);
  if (first) return first.id;
  return kind === 'ledger' ? 'cl7' : kind === 'goods' ? 'cg0' : 'cs0';
}

/**
 * ★v1.0.27 消耗型生活流分类：命中这些分类的「买了」不建物品档，走生活流记账。
 * （服饰/饰品/数码是耐用品档除外；美妆耐用品由 GOODS_KEYWORDS 先接住）
 */
const CONSUMABLE_LEDGER_NAMES = new Set(
  Object.keys(LEDGER_FALLBACK_ID).filter(
    (n) => n !== '服饰' && n !== '饰品' && n !== '数码' && n !== '其他',
  ),
);

/**
 * 判断这句话是不是「日常消耗品/服务」消费（烟酒槟榔、吃喝、日用品、话费、药…）。
 * 规则：显式消耗词命中 → 是；否则生活流分类命中且不在耐用品三类 → 是。
 * 匹配前先剥掉量词（「买包纸巾」的「包」不再是服饰关键词的误命中）。
 */
function isConsumablePurchase(text: string): boolean {
  if (RE_CONSUMABLE.test(text)) return true;
  const goodsName = hitCategoryName(text, GOODS_KEYWORDS);
  if (goodsName) return false; // 明确命中耐用品词 → 物品
  const stripped = text.replace(/[个双只包盒瓶袋罐条支箱斤]+(?=[一-龥])/g, ' ');
  const ledgerName = hitCategoryName(stripped, CATEGORY_KEYWORDS);
  return Boolean(ledgerName) && CONSUMABLE_LEDGER_NAMES.has(ledgerName);
}

/** 构造生活流记账草稿（买入消耗品路径复用）。 */
function buildLedgerDraft(
  text: string,
  cats: Category[],
  amount: number,
  date: string,
  meal: string,
): LedgerDraft {
  const isIncome = RE_INCOME.test(text);
  // 分类匹配用剥量词文本：「买包纸巾」的「包」不再误归服饰
  const matchText = text.replace(/[个双只包盒瓶袋罐条支箱斤]+(?=[一-龥])/g, ' ');
  const categoryId = matchCategoryId(matchText, cats, 'ledger');
  const isFood = Boolean(meal) || RE_EAT.test(text) || categoryId === 'cl0';
  const isTraffic = RE_TRAFFIC.test(text) || categoryId === 'cl1';
  return {
    type: isIncome ? 'income' : 'expense',
    amount,
    categoryId,
    judgement: guessJudgement(text, { isIncome, isTraffic, isFood }),
    date,
    note: cleanNote(text, meal),
  };
}

/** 关键词命中（大小写不敏感）。 */
function hitCategoryName(
  text: string,
  table: Array<{ name: string; words: string[] }>,
): string {
  const lower = text.toLowerCase();
  for (const entry of table) {
    for (const w of entry.words) {
      if (lower.includes(w.toLowerCase())) return entry.name;
    }
  }
  return '';
}

/** 分类匹配（顺序敏感，先命中先得）。 */
export function matchCategoryId(
  text: string,
  categories: Category[],
  kind: 'goods' | 'sub' | 'ledger',
): string {
  const table =
    kind === 'goods' ? GOODS_KEYWORDS : kind === 'sub' ? SUB_KEYWORDS : CATEGORY_KEYWORDS;
  const name = hitCategoryName(text, table);
  return categoryIdByName(name, categories, kind) || defaultCategoryId(categories, kind);
}

/** judgement 判定顺序（架构 §10.6 ⑦）。 */
export function guessJudgement(
  text: string,
  opts: { isIncome?: boolean; isTraffic?: boolean; isFood?: boolean } = {},
): Judgement {
  if (opts.isIncome) return 'gui';
  if (opts.isTraffic) return 'xu';
  if (opts.isFood) return 'xu';
  if (RE_TIME_GOOD.test(text)) return 'gui';
  if (RE_TIME_BAD.test(text)) return 'fou';
  if (RE_IMPULSE.test(text)) return 'fou';
  if (RE_GROWTH.test(text)) return 'gui';
  return 'xu';
}

/** note 清洗（k0）：去金额、去口水词、标点归一、截 40 字。 */
export function cleanNote(text: string, meal = ''): string {
  let s = text;
  // 金额表达
  s = s.replace(new RegExp(`(?:花了|花费|用了|支付了?|付款|实付|付了|一共|总共|价格是?|掏了|砸了)\\s*(${NUM})\\s*(?:块钱|块|元|￥|¥)?`, 'g'), ' ');
  s = s.replace(new RegExp(`(${NUM})\\s*(?:块钱|块|元|￥|¥)`, 'g'), ' ');
  // 时间词
  s = s.replace(/(今天|昨天|前天|刚才|刚刚|大前天)/g, ' ');
  s = s.replace(/(早上|早晨|清晨|上午|中午|午间|晌午|下午|晚上|傍晚|夜里|半夜|深夜|凌晨)/g, ' ');
  // 代词与连词
  s = s.replace(/(我|我们|俺|咱)/g, ' ');
  s = s.replace(/(然后|接着|随后|之后|另外|还有|紧接着|接下来|顺便)/g, ' ');
  // 动作词
  s = s.replace(RE_EAT, ' ');
  s = s.replace(/(坐了|乘坐|坐|搭了|搭|打车|骑了|骑)/g, ' ');
  s = s.replace(/(买了|购入|入手|收了|下单|抢了|开了|开通|续费|订阅)/g, ' ');
  s = s.replace(CHANNEL_WORDS, ' ');
  // 标点归一 + 压缩空白
  s = s.replace(/[，,。.；;！!？?、：:~～\-—]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(new RegExp(`(${NUM})`, 'g'), ' ').replace(/\s+/g, ' ').trim();
  if (meal) return `${meal}·${s}`.slice(0, 40);
  return s.slice(0, 40);
}

/** 物品名提取：去渠道/代词/日期 → 取买入动词后 → 去金额 → 去量词。 */
export function extractName(text: string, amountRaw?: string): string {
  let s = text
    .replace(/(今天|昨天|前天|刚才|刚刚|大前天)/g, ' ')
    .replace(/(我|我们|俺|咱)/g, ' ')
    .replace(CHANNEL_WORDS, ' ');

  RE_BUY_GOODS.lastIndex = 0;
  const buy = RE_BUY_GOODS.exec(s);
  if (buy) s = s.slice(buy.index + buy[0].length);

  if (amountRaw) s = s.replace(amountRaw, ' ');

  s = s.replace(/(会员|订阅|月卡|年卡|季卡|周卡|包月|包年)/g, ' ');
  s = s.replace(/[（(][^）)]*[）)]/g, ' ');
  s = s.replace(/[，,。.；;！!？?、]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // 去掉前缀量词：双跑鞋 → 跑鞋
  s = s.replace(QUANTIFIER_RE, '').trim();
  // 去掉尾部虚词
  s = s.replace(/(了|的|个|一下)$/g, '').trim();
  return s.slice(0, 24);
}

/** 订阅周期与 every。 */
function detectPeriod(text: string): { period: 'month' | 'year' | 'week'; every: number } {
  if (/(年卡|包年|一年|每年|年费|年度)/.test(text)) return { period: 'year', every: 1 };
  if (/(周卡|每周|一周)/.test(text)) return { period: 'week', every: 1 };
  return { period: 'month', every: 1 };
}

/** 时长（分钟）。 */
export function extractDurationMin(text: string): number {
  const m = RE_DURATION.exec(text);
  if (!m) return 0;
  const value = toNumber(m[1] as string);
  if (!Number.isFinite(value)) return 0;
  const unit = m[3] ?? m[2] ?? '';
  if (unit === '小时' || unit === '时') return Math.round(value * 60);
  if (unit === '天') return Math.round(value * 60 * 24);
  return Math.round(value);
}

/** 本地解析上下文。 */
export interface LocalParseContext {
  /** 参考「今天」，默认真实今天 */
  today?: string;
  /** 货币，默认 CNY */
  currency?: string;
}

/**
 * 解析单个分句。
 *
 * @returns 一定返回 AiResultItem（无法识别时 `action:'unknown'`，`source:'local'`）
 */
export function parseLocal(
  sentence: string,
  categories: Category[],
  ctx: LocalParseContext = {},
): AiResultItem {
  const today = ctx.today ?? todayStr();
  const currency = ctx.currency ?? 'CNY';
  // 全角数字/字母 → 半角（手机中文输入法、语音转写常输出全角，不归一无法提取金额）
  const text = (sentence ?? '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim();
  if (!text) return { action: 'unknown', source: 'local', explanation: '空句' };

  const hit = extractAmount(text);
  const amount = hit ? hit.value : 0;
  const date = resolveDate(text, today);
  const meal = detectMeal(text);
  const cats = categories ?? [];

  // 1) 情绪记录：没有金额 + 命中情绪词
  if (!hit && RE_MOOD.test(text)) {
    return {
      action: 'create_mood',
      moodDraft: { feeling: moodEmoji(text), text },
      explanation: '本地规则：情绪记录',
      source: 'local',
    };
  }

  // 2) 卖出 / 退役
  if (RE_SELL.test(text)) {
    return {
      action: 'retire_sell',
      retireDraft: { match: extractName(text, hit?.raw), sellPrice: amount },
      explanation: '本地规则：退役转卖',
      source: 'local',
    };
  }

  // 3) 订阅（会员 / 月卡 / 续费 / 开通）
  if (RE_SUBSCRIPTION.test(text)) {
    const { period, every } = detectPeriod(text);
    const name = extractName(text, hit?.raw) || '订阅';
    const draft: SubDraft = {
      name,
      amount,
      currency,
      period,
      every,
      categoryId: matchCategoryId(text, cats, 'sub'),
      icon: emojiForName(name),
    };
    return {
      action: 'create_subscription',
      subDraft: draft,
      explanation: '本地规则：订阅',
      source: 'local',
    };
  }

  // 4) 时间记录（有「X小时/X分钟」但没有钱的线索）
  if (RE_DURATION.test(text) && !hasMoneyCue(text)) {
    const durationMin = extractDurationMin(text);
    const draft: TimeDraft = {
      durationMin,
      tags: [],
      meaning: RE_TIME_GOOD.test(text) ? 'gui' : RE_TIME_BAD.test(text) ? 'fou' : 'xu',
      note: cleanNote(text),
    };
    return { action: 'create_time', timeDraft: draft, explanation: '本地规则：时间记录', source: 'local' };
  }

  // 5) 买入动作（「冲动/后悔」语义除外 → 走生活流判为「否」）
  //    ★v1.0.27：日常消耗品（烟酒槟榔 / 吃喝 / 日用品 / 药…）即使说「买了」
  //    也归生活流记账（归/需/否判定），不再错建物品档；耐用品（数码/衣物/家电…）才建物品。
  if (RE_BUY_GOODS.test(text) && !RE_IMPULSE.test(text)) {
    if (isConsumablePurchase(text)) {
      return {
        action: 'create_ledger',
        ledgerDraft: buildLedgerDraft(text, cats, amount, date, meal),
        explanation: '本地规则：日常消费（消耗品不入物品库）',
        source: 'local',
      };
    }
    const name = extractName(text, hit?.raw) || '物品';
    const draft: GoodsDraft = {
      name,
      price: amount,
      currency,
      buyDate: date,
      categoryId: matchCategoryId(text, cats, 'goods'),
      icon: emojiForName(name),
      tags: [],
      note: '',
    };
    return { action: 'create_goods', goodsDraft: draft, explanation: '本地规则：买入物品', source: 'local' };
  }

  // 6) 生活流记账（有金额 / 进食 / 交通）
  if (amount > 0 || RE_EAT.test(text) || RE_TRAFFIC.test(text)) {
    return {
      action: 'create_ledger',
      ledgerDraft: buildLedgerDraft(text, cats, amount, date, meal),
      explanation: '本地规则：生活流',
      source: 'local',
    };
  }

  // 7) 兜底时长（前面被金额规则拦下的场景）
  if (RE_DURATION.test(text)) {
    return {
      action: 'create_time',
      timeDraft: {
        durationMin: extractDurationMin(text),
        tags: [],
        meaning: RE_TIME_GOOD.test(text) ? 'gui' : 'xu',
        note: cleanNote(text),
      },
      explanation: '本地规则：时间记录',
      source: 'local',
    };
  }

  return { action: 'unknown', explanation: '本地规则未能识别', source: 'local' };
}

/** 批量解析（分句后逐句跑本地规则）。 */
export function parseLocalMany(
  sentences: string[],
  categories: Category[],
  ctx: LocalParseContext = {},
): AiResultItem[] {
  return sentences.map((s) => parseLocal(s, categories, ctx));
}

/** 供外部复用：中文数字转数字（语义同 cnToNumber，保留别名便于调试）。 */
export const parseCnNumber = cnToNumber;
/** 供外部复用：judgement 安全转换。 */
export const safeJudgement = toJudgement;
