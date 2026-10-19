import { addDays, today as todayStr } from '../lib/date';
import { emojiForName } from '../lib/emoji';
import { toJudgement } from '../lib/emoji';
import type { AiResultItem, GoodsDraft, LedgerDraft, SubDraft, TimeDraft } from '../types/ai';
import type { Category, CategoryKind, Judgement } from '../types/entities';
import { cnToNumber, isAmountLike, toNumber, CN_NUM_CHARS } from './cnNumber';
import { cleanNameText, detailsNote, extractOralDetails } from './colloquial';
import { matchLearnedRule, type LearnedRule } from './ruleBank';
import {
  AMBIGUOUS_CLUSTERS,
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
      // ★v1.3.1 显式「0元/0块」是真实金额（京东秒送券后 0 元订单的合成句
      // 「买了X 0元」）——不放行会被兜底规则抓走名称里的规格数字（「1人份」→ ¥1）
      if (isAmountLike(v) || (v === 0 && re === RE_UNIT)) return { value: v, raw: m[0], index: m.index };
      m = re.exec(text);
    }
  }
  return fallbackAmount(text);
}

/**
 * 兜底数字（跳过年/月/日/号 等日期后缀，跳过单个中文数字，跳过型号码）。
 *
 * ★v1.1.10：与字母紧邻的数字是**型号**不是金额。
 * 旧版取「最后一个数字」，于是「买了台 N95笔记本 8G+128G 4600」会取到 128，
 * 记成 ¥128 —— 这是「AI 记一笔不准」的另一个来源。
 */
function fallbackAmount(text: string): AmountHit | null {
  const re = new RegExp(`(${NUM})`, 'g');
  const hits: AmountHit[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    const token = m[0];
    const next = text.slice(m.index + token.length, m.index + token.length + 1);
    const prev = text.slice(Math.max(0, m.index - 1), m.index);
    const isChineseOnly = !/\d/.test(token);
    // 型号：N95 / 8G / 128G / RTX4090（前后紧邻 ASCII 字母）
    const isModelNumber = /[A-Za-z]/.test(prev) || /[A-Za-z]/.test(next);
    if (!isModelNumber && !/^[年月日号点岁度层楼]/.test(next) && !(isChineseOnly && token.length === 1)) {
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
  if (kind === 'ledger') {
    /**
     * ★v1.1.10：认不出类别时归「其他」，不能落到数组第一条（餐饮）。
     * 旧行为让「N95 笔记本 花了 190」这种没有任何餐饮词的句子一律记成餐饮，
     * 用户对着一台笔记本却看到「餐饮」分类 —— 这就是「AI 记一笔不准」的主要感受来源。
     */
    const list = categories.filter((c) => c.kind === 'ledger');
    const other = list.find((c) => c.name === '其他') ?? list.find((c) => c.id === 'cl7');
    if (other) return other.id;
    const lastByOrder = list.slice().sort((a, b) => a.order - b.order).pop();
    return lastByOrder?.id ?? 'cl7';
  }
  const first = categories.find((c) => c.kind === kind);
  if (first) return first.id;
  return kind === 'goods' ? 'cg0' : 'cs0';
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
 * 规则：学习规则/歧义词簇判定 → 显式消耗词命中 → 生活流分类命中且不在耐用品三类 → 是。
 * 匹配前先剥掉量词（「买包纸巾」的「包」不再是服饰关键词的误命中）。
 *
 * ★v1.2.0：学习规则与歧义词簇优先于孤立关键词 ——
 * 「买了N95笔记本准系统」不再被「N95→口罩→医疗」带偏。
 */
function isConsumablePurchase(text: string, learned?: LearnedRule[] | null): boolean {
  if (learned && learned.length > 0) {
    const hit = matchLearnedRule(text, learned);
    if (hit) return hit.kind === 'ledger';
  }
  const sense = resolveAmbiguous(text);
  if (sense) return sense.kind === 'ledger';
  if (RE_CONSUMABLE.test(text)) return true;
  // ★v1.2.1 秤重/容量单位买法：「买了30斤大米/5L油」→ 消耗品；
  // 「买了苹果15」没有斤两单位，仍是耐用品（品牌词）
  // （注意：中文之间没有 \b 边界，不能加 \b）
  if (/(\d+(?:\.\d+)?|[一二三四五六七八九十半两])\s*(斤|公斤|克|千克|kg|ml|升|L)/i.test(text)) return true;
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
  learned?: LearnedRule[] | null,
): LedgerDraft {
  const isIncome = RE_INCOME.test(text);
  // 分类匹配用剥量词文本：「买包纸巾」的「包」不再误归服饰
  const matchText = text.replace(/[个双只包盒瓶袋罐条支箱斤]+(?=[一-龥])/g, ' ');
  const categoryId = matchCategoryId(matchText, cats, 'ledger', learned);
  const isFood = Boolean(meal) || RE_EAT.test(text) || categoryId === 'cl0';
  const isTraffic = RE_TRAFFIC.test(text) || categoryId === 'cl1';
  // ★v1.2.1 口头语细节：地点/数量进备注，名称只留商品名（「在斤大米」→「大米」）。
  // 备注基座沿用 cleanNote（保留「早饭·油条包子」这类既有格式），有细节时加前缀
  const details = extractOralDetails(text);
  let base = cleanNote(text, meal);
  if (details.qty && base.includes(details.qty)) {
    base = base.replace(details.qty, '').replace(/\s+/g, ' ').trim();
  }
  const parts = [details.place, details.qty].filter(Boolean);
  return {
    type: isIncome ? 'income' : 'expense',
    amount,
    categoryId,
    judgement: guessJudgement(text, { isIncome, isTraffic, isFood }),
    date,
    name: cleanNameText(text) || undefined,
    note: parts.length && base ? `${parts.join(' · ')}｜${base}` : base || text,
  };
}

/**
 * 单字关键词的「后缀黑名单」：命中后面紧跟这些字就不算命中。
 * 「米粉/凉粉」是餐饮，但「粉色/粉红/粉底」不是 —— 否则「N95 粉色笔记本」会被记成餐饮。
 */
const SINGLE_CHAR_TAIL_BLOCK = /[色红蓝紫黄金绿白黑灰嫩底饼]/;

/**
 * ★v1.2.0 歧义词簇消歧（PRD 四.2：上下文感知，而非孤立关键词）。
 *
 * 文本含歧义词（如 N95）时，按共现词选义项：
 * - 某个义项的共现词命中 → 返回该义项（{kind, name}）；
 * - 所有义项都没有共现词 → 返回 null（不瞎猜，交给静态表 / 确认卡片兜底）。
 */
export function resolveAmbiguous(text: string): { kind: CategoryKind; name: string } | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const cluster of AMBIGUOUS_CLUSTERS) {
    if (!lower.includes(cluster.word)) continue;
    for (const sense of cluster.senses) {
      if (sense.words.some((w) => w && lower.includes(w.toLowerCase()))) {
        return { kind: sense.kind, name: sense.name };
      }
    }
  }
  return null;
}

/**
 * 关键词命中（大小写不敏感）。
 *
 * ★v1.1.10：从「表内先出现者赢」改为「**命中的词最长者赢**」。
 * 旧规则下单个汉字关键词会抢在长词前面：「粉色」被「粉」（米粉/凉粉，餐饮）吃掉。
 */
function hitCategoryName(
  text: string,
  table: Array<{ name: string; words: string[] }>,
): string {
  const lower = text.toLowerCase();
  let bestName = '';
  let bestLen = 0;
  for (const entry of table) {
    for (const w of entry.words) {
      const lw = w.toLowerCase();
      if (!lw || lw.length <= bestLen) continue;
      const at = lower.indexOf(lw);
      if (at < 0) continue;
      // 单字关键词（粉/面/米…）容易撞到颜色与常用词，按后缀黑名单挡一下
      if (lw.length === 1 && SINGLE_CHAR_TAIL_BLOCK.test(lower.slice(at + 1, at + 2))) continue;
      bestName = entry.name;
      bestLen = lw.length;
    }
  }
  return bestName;
}

/**
 * 分类匹配（顺序敏感，先命中先得）。
 *
 * ★v1.2.0 匹配顺序（PRD 四.1：用户人工纠正样本优先级高于旧静态规则）：
 *   ① 本地自学习规则（用户在确认卡片上纠正过的样本）；
 *   ② 歧义词簇上下文消歧（N95 + 笔记本 → 物品-数码）；
 *   ③ 静态关键词表（命中词最长者优先）。
 */
export function matchCategoryId(
  text: string,
  categories: Category[],
  kind: 'goods' | 'sub' | 'ledger',
  learned?: LearnedRule[] | null,
): string {
  // ① 学习规则（仅义项大类一致时才采纳小类）
  if (learned && learned.length > 0) {
    const hit = matchLearnedRule(text, learned);
    if (hit && hit.kind === kind) {
      const id = categoryIdByName(hit.categoryName, categories, kind);
      if (id) return id;
    }
  }
  // ② 歧义词簇上下文消歧
  const sense = resolveAmbiguous(text);
  if (sense && sense.kind === kind) {
    const id = categoryIdByName(sense.name, categories, kind);
    if (id) return id;
  }
  // ③ 静态表（最长命中优先）
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

/**
 * 「裸数字」清理用的正则：只清掉**独立出现**的数字串（真正的金额残留）。
 *
 * ★v1.1.10 修复（名称里的型号码被吃掉）：旧版在 note 清洗末尾做了一次
 * `s.replace(/(数字)/g, ' ')` —— 把所有数字无差别删掉，于是
 *   「N95口罩」→「N 口罩」
 *   「N95笔记淮系统粉色」→「N 笔记淮系统粉色」
 *   「N95笔记本 8G+128G」→「N 笔记本 G+ G」
 * 用户看到的就是「名字只记下了 N95 后面那截」，只能去 AI 记一笔里手打补回来。
 *
 * 现在把与字母/型号连写的数字保护起来：前后紧邻字母、数字、+、#、. 的一律不动，
 * 后面跟空格再跟英文单词的（iPhone 15 Pro）也不动；只清「包子 30」「第 3 次」这类孤立数字。
 */
const RE_BARE_NUM = new RegExp(`(?<![A-Za-z0-9_+#.])${NUM}(?![A-Za-z0-9_+#%.]|\\s*[A-Za-z])`, 'g');

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
  // 只清「裸金额」，保留 N95 / 8G+128G / RTX4090 这类型号码（见 RE_BARE_NUM）
  s = s.replace(RE_BARE_NUM, ' ').replace(/\s+/g, ' ').trim();
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
  /** ★v1.2.0 本地自学习规则（用户人工纠正样本，优先级高于静态规则）。 */
  learned?: LearnedRule[] | null;
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
  const learned = ctx.learned && ctx.learned.length > 0 ? ctx.learned : null;
  /** 学习规则命中（用户纠正过的样本，PRD：优先级高于旧静态规则）。 */
  const forced = learned ? matchLearnedRule(text, learned) : null;
  const withRaw = (item: AiResultItem): AiResultItem => ({ ...item, rawText: text });

  // 1) 情绪记录：没有金额 + 命中情绪词（学习规则命中时说明这是笔记录，不再抢情绪）
  if (!forced && !hit && RE_MOOD.test(text)) {
    return withRaw({
      action: 'create_mood',
      moodDraft: { feeling: moodEmoji(text), text },
      explanation: '本地规则：情绪记录',
      source: 'local',
    });
  }

  // 2) 卖出 / 退役（动作语义优先于分类学习）
  if (RE_SELL.test(text)) {
    return withRaw({
      action: 'retire_sell',
      retireDraft: { match: cleanNameText(text, hit?.raw), sellPrice: amount },
      explanation: '本地规则：退役转卖',
      source: 'local',
    });
  }

  // 3) 订阅（会员 / 月卡 / 续费 / 开通）
  //    ★v1.2.0：学习规则指定「订阅」时，即使句中没有订阅词也按订阅建
  if (forced?.kind === 'sub' || RE_SUBSCRIPTION.test(text)) {
    const { period, every } = detectPeriod(text);
    const name = cleanNameText(text, hit?.raw) || '订阅';
    const draft: SubDraft = {
      name,
      amount,
      currency,
      period,
      every,
      categoryId: matchCategoryId(text, cats, 'sub', learned),
      icon: emojiForName(name),
    };
    return withRaw({
      action: 'create_subscription',
      subDraft: draft,
      explanation: forced?.kind === 'sub' ? '本地规则：订阅（学习规则）' : '本地规则：订阅',
      source: 'local',
    });
  }

  // 4) 时间记录（有「X小时/X分钟」但没有钱的线索）
  if (!forced && RE_DURATION.test(text) && !hasMoneyCue(text)) {
    const durationMin = extractDurationMin(text);
    const draft: TimeDraft = {
      durationMin,
      tags: [],
      meaning: RE_TIME_GOOD.test(text) ? 'gui' : RE_TIME_BAD.test(text) ? 'fou' : 'xu',
      note: cleanNote(text),
    };
    return withRaw({ action: 'create_time', timeDraft: draft, explanation: '本地规则：时间记录', source: 'local' });
  }

  // 5) 买入动作（「冲动/后悔」语义除外 → 走生活流判为「否」）
  //    ★v1.0.27：日常消耗品（烟酒槟榔 / 吃喝 / 日用品 / 药…）即使说「买了」
  //    也归生活流记账（归/需/否判定），不再错建物品档；耐用品（数码/衣物/家电…）才建物品。
  //    ★v1.2.0：学习规则指定「物品」时跳过消耗品判定（用户明确要建物品档），
  //    且句中没有买入动词时也按物品建（如「N95准系统笔记本 899」）。
  const asGoods = (explanation: string): AiResultItem => {
    const name = cleanNameText(text, hit?.raw) || '物品';
    const details = extractOralDetails(text);
    const draft: GoodsDraft = {
      name,
      price: amount,
      currency,
      buyDate: date,
      categoryId: matchCategoryId(text, cats, 'goods', learned),
      icon: emojiForName(name),
      tags: [],
      note: detailsNote(text, details),
    };
    return withRaw({ action: 'create_goods', goodsDraft: draft, explanation, source: 'local' });
  };
  if (RE_BUY_GOODS.test(text) && !RE_IMPULSE.test(text)) {
    if (forced?.kind !== 'goods' && isConsumablePurchase(text, learned)) {
      return withRaw({
        action: 'create_ledger',
        ledgerDraft: buildLedgerDraft(text, cats, amount, date, meal, learned),
        explanation: '本地规则：日常消费（消耗品不入物品库）',
        source: 'local',
      });
    }
    return asGoods(forced?.kind === 'goods' ? '本地规则：买入物品（学习规则）' : '本地规则：买入物品');
  }
  if (forced?.kind === 'goods' && !RE_IMPULSE.test(text)) {
    return asGoods('本地规则：物品（学习规则）');
  }

  // 6) 生活流记账（学习规则指定生活流 / 有金额 / 进食 / 交通）
  if (forced?.kind === 'ledger' || amount > 0 || RE_EAT.test(text) || RE_TRAFFIC.test(text)) {
    return withRaw({
      action: 'create_ledger',
      ledgerDraft: buildLedgerDraft(text, cats, amount, date, meal, learned),
      explanation: forced?.kind === 'ledger' ? '本地规则：生活流（学习规则）' : '本地规则：生活流',
      source: 'local',
    });
  }

  // 7) 兜底时长（前面被金额规则拦下的场景）
  if (RE_DURATION.test(text)) {
    return withRaw({
      action: 'create_time',
      timeDraft: {
        durationMin: extractDurationMin(text),
        tags: [],
        meaning: RE_TIME_GOOD.test(text) ? 'gui' : 'xu',
        note: cleanNote(text),
      },
      explanation: '本地规则：时间记录',
      source: 'local',
    });
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
