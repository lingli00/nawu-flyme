import dayjs from 'dayjs';
import { addDays, monthKey } from '../lib/date';
import { dailyCost, holdDays } from '../domain/goods';
import type { Category, Goods, Mood, Subscription, TimeRec, ValueRecord } from '../types/entities';

/**
 * ★v1.2.0 对话入口的「查询」能力（纯逻辑，无副作用，可单测）。
 *
 * 用户发「昨天买了什么 / 这周花了多少 / 心情记录 / 时间记录」这类句子时，
 * 不再拿去当记录解析（否则会像 v1.2.0 初版那样把「帮我查一下昨天买了什么」
 * 误弹成一张「名称:什么 金额:0」的记录卡），而是基于本地数据生成回答。
 */

/** 查询所需数据快照（对话面板发送时从 store 现取，保证是最新）。 */
export interface QueryData {
  categories: Category[];
  goods: Goods[];
  valueRecords: ValueRecord[];
  subscriptions: Subscription[];
  moods: Mood[];
  times: TimeRec[];
  /** ★v1.3.0 已停用订阅 id（Settings.archivedSubIds）——不计入月均/累计。 */
  archivedSubIds?: string[];
}

/** 列表最多展示几条（超出提示「等 N 条」）。 */
const MAX_LIST = 8;

/* ---------------- 意图识别 ---------------- */

/** 疑问/查询标志词。 */
const QUERY_STRONG = /查|看看|咋|什么|哪些|多少|怎么样|统计|吗|？|\?/;
/** 明确的「强查询」词：出现时即使句子像记录也按查询处理。 */
const QUERY_OVERRIDE = /查|看看|咋|什么|哪些|怎么样|统计/;
/** 记录动词开头（「记一下/记一笔/记录…」）→ 默认是记录不是查询。 */
const RECORD_VERB = /^\s*(帮我)?(记一?笔|记一?下|记账|记录)/;
/** 领域提示词。 */
const DOMAIN_HINT =
  /买|吃|喝|饭|消费|花|流水|支出|收入|心情|情绪|时间|时长|订阅|会员|续费|账|物品|东西|装备|记录|情况/;
/** 日期提示词。 */
const DATE_HINT =
  /今天|今日|昨天|昨日|前天|大前天|本周|这周|这个星期|上周|上星期|这个月|本月|这月|上月|上个月|最近|这些天|以来|全部|所有|哪天|几号/;

/**
 * 是否是「查询」意图（而非「记录」意图）。
 *
 * - 含疑问词（什么/多少/咋/查/看看/吗/？…）+ 领域词或日期词 → 查询
 * - 「记一下/记一笔/记录…」开头且无强查询词 → 记录（「记一下昨天花了多少钱」也要记账）
 */
export function isQueryIntent(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (RECORD_VERB.test(t) && !QUERY_OVERRIDE.test(t)) return false;
  if (!QUERY_STRONG.test(t)) return false;
  return DOMAIN_HINT.test(t) || DATE_HINT.test(t);
}

/* ---------------- 日期范围 ---------------- */

interface Range {
  start: string;
  end: string;
  label: string;
}

/** 周一（dayjs: 0=周日）。 */
function mondayOf(d: string): string {
  const day = dayjs(d).day();
  return dayjs(d)
    .add(day === 0 ? -6 : 1 - day, 'day')
    .format('YYYY-MM-DD');
}

/** 从文本解析日期范围（解析不了 → 全部）。 */
function resolveRange(text: string, today: string): Range {
  if (/今天|今日/.test(text)) return { start: today, end: today, label: '今天' };
  if (/大前天/.test(text)) {
    const d = addDays(today, -3);
    return { start: d, end: d, label: '大前天' };
  }
  if (/前天/.test(text)) {
    const d = addDays(today, -2);
    return { start: d, end: d, label: '前天' };
  }
  if (/昨天|昨日/.test(text)) {
    const d = addDays(today, -1);
    return { start: d, end: d, label: '昨天' };
  }
  if (/上周|上星期/.test(text)) {
    const m = mondayOf(today);
    return { start: addDays(m, -7), end: addDays(m, -1), label: '上周' };
  }
  if (/本周|这周|这个星期|这一周|这一星期|此周/.test(text)) return { start: mondayOf(today), end: today, label: '本周' };
  if (/上月|上个月/.test(text)) {
    const ym = dayjs(`${monthKey(today)}-01`).subtract(1, 'month');
    return {
      start: ym.startOf('month').format('YYYY-MM-DD'),
      end: ym.endOf('month').format('YYYY-MM-DD'),
      label: '上月',
    };
  }
  if (/这个月|本月|这月|这一月/.test(text)) {
    return { start: dayjs(today).startOf('month').format('YYYY-MM-DD'), end: today, label: '本月' };
  }
  if (/去年|上一年/.test(text)) {
    const y = dayjs(today).subtract(1, 'year');
    return {
      start: y.startOf('year').format('YYYY-MM-DD'),
      end: y.endOf('year').format('YYYY-MM-DD'),
      label: '去年',
    };
  }
  if (/今年|这一年|本年度/.test(text)) {
    return { start: dayjs(today).startOf('year').format('YYYY-MM-DD'), end: today, label: '今年' };
  }
  const nMatch = /(?:最近|近)\s*(\d+)?\s*(天|周)/.exec(text);
  if (nMatch || /这些天|以来|最近/.test(text)) {
    const n = Math.min(90, Math.max(1, Number(nMatch?.[1] ?? 7) * (nMatch?.[2] === '周' ? 7 : 1)));
    return { start: addDays(today, -(n - 1)), end: today, label: `最近${n}天` };
  }
  return { start: '0000-01-01', end: '9999-12-31', label: '全部' };
}

/* ---------------- 查询域 ---------------- */

type Scope = 'mood' | 'time' | 'sub' | 'goods' | 'ledger' | 'all';

function detectScope(text: string): Scope {
  if (/心情|情绪|感觉/.test(text)) return 'mood';
  if (/时间|时长|多久|几个小时|小时/.test(text)) return 'time';
  if (/订阅|会员|续费|自动扣/.test(text)) return 'sub';
  if (/买|入手|购|物品|东西|装备/.test(text)) return 'goods';
  // 「一笔/花销/开销/花费」说的是单条流水，不是物品
  if (/一笔|花销|开销|花费|消费|吃|喝|饭|花|流水|支出|收入|账/.test(text)) return 'ledger';
  // 「我今天都干了什么」→ 全都要
  if (/(干|做|整|弄)了?(什么|啥|些)/.test(text)) return 'all';
  return 'all';
}

/* ---------------- 格式化 ---------------- */

function money(n: number): string {
  return Number.isInteger(n) ? `¥${n}` : `¥${n.toFixed(2)}`;
}

function dayLabel(d: string): string {
  return dayjs(d).format('M/D');
}

function inRange(d: string | undefined, r: Range): boolean {
  return !!d && d >= r.start && d <= r.end;
}

function durationText(min: number): string {
  if (min >= 60) return `${(min / 60).toFixed(1).replace(/\.0$/, '')}小时`;
  return `${min}分钟`;
}

function catName(cats: Category[], id: string): string {
  return cats.find((c) => c.id === id)?.name ?? '';
}

/** 生活流 note 可能带「早饭·」前缀，展示时去掉。 */
function cleanNote(note: string | undefined): string {
  return (note ?? '').replace(/^[早午晚宵夜下上]{1,2}[饭餐茶]·/, '').trim();
}

const PERIOD_LABEL: Record<string, string> = { month: '月', year: '年', week: '周' };

/* ------------------------------------------------------------------ */
/* ★v1.3.0 周期分类统计 / 日均 / 订阅月均 / 物品摊销                     */
/* ------------------------------------------------------------------ */

/**
 * 口语品类词 → 生活流分类名（按序首个命中）。
 * 铁律：互斥品类放不同行，「吃饭」归餐饮、「买菜/备菜」归食材（用户数据里
 * 咖啡/外卖走餐饮、周末备菜走食材，是两笔账）。
 */
const CATEGORY_WORDS: Array<[RegExp, string]> = [
  [/吃饭|餐饮|外卖|聚餐|饭钱|吃的|吃了|餐/, '餐饮'],
  [/食材|备菜|买菜|菜钱|柴米油盐/, '食材'],
  [/交通|打车|地铁|通勤|出行|车费|油钱|公交/, '交通'],
  [/房租|水电|居住|物业|燃气/, '居住'],
  [/学习|上课|课程|买书|培训/, '学习'],
  [/医院|看病|健康|买药|体检/, '健康'],
  [/娱乐|游戏|电影|唱歌|网游|氪金/, '娱乐'],
  [/人情|礼物|红包|礼金|请客/, '人情'],
  [/衣服|穿衣|服饰|买鞋|裤子/, '服饰'],
  [/饰品|首饰|项链|戒指/, '饰品'],
  [/日用|生活用品|洗洁|纸巾|纸/, '日用'],
];

/** 分类周期统计：「这一周吃饭花了多少钱」「这个月交通花多少」。 */
function isCategorySpend(text: string): boolean {
  if (/最(贵|便宜|多|少|大|小)/.test(text)) return false; // 超级比较优先
  return /多少|花了|花销|花费|消费|开销|支出|合计|统计/.test(text) && CATEGORY_WORDS.some(([re]) => re.test(text));
}

/** 日均/月均花费：「我平均每天花费多少」「平均每个月花多少」。 */
function isAvgSpend(text: string): boolean {
  return /平均|日均/.test(text) && /花|花费|消费|支出|开销|多少|钱/.test(text) && !/订阅|会员|续费/.test(text);
}

/** 订阅月均：「我的订阅平均每个月多少钱」。 */
function isSubMonthly(text: string): boolean {
  return /订阅|会员|续费/.test(text) && /平均|均/.test(text);
}

/** 订阅累计：「我的订阅一共花了多少」。 */
function isSubTotal(text: string): boolean {
  return /订阅|会员|续费/.test(text) && /一共|总共|累计|合计|拢共/.test(text);
}

/** 物品摊销查询：「我的物品每天成本多少」「这个月买的折旧多少」。 */
function isAmortize(text: string): boolean {
  return /摊销|折旧|回本|每天成本|每日成本|日均成本/.test(text);
}

/** 周期自然天数（start~end 含首尾）；「全部」用记录实际跨度，调用方传 spanDays。 */
function rangeDays(r: Range, fallbackSpan?: number): number {
  if (r.start === '0000-01-01' || r.end === '9999-12-31') {
    return Math.max(1, fallbackSpan ?? 1);
  }
  return Math.max(1, dayjs(r.end).diff(dayjs(r.start), 'day') + 1);
}

/** 口语品类词 → 分类 id（按名匹配；找不到返回 null）。 */
function categoryIdByWord(data: QueryData, text: string): string | null {
  for (const [re, name] of CATEGORY_WORDS) {
    if (!re.test(text)) continue;
    const hit = data.categories.find((c) => c.kind === 'ledger' && (c.name === name || c.name.includes(name)));
    if (hit) return hit.id;
  }
  return null;
}

/** 订阅折算月费（年/12、周×30/7、月原样；lifetime 记 initSpent 一次性）。 */
function subMonthly(s: Subscription): number {
  const a = Number(s.amount) || 0;
  if (s.type === 'lifetime') return 0;
  if (s.period === 'year') return a / 12;
  if (s.period === 'week') return (a * 30) / 7;
  return a;
}

/** 订阅自 startDate 至 today 的累计花费（按期数折算，至少 1 期）。 */
function subSpentToDate(s: Subscription, today: string): number {
  if (s.type === 'lifetime') return Number(s.initSpent ?? s.amount) || 0;
  const a = Number(s.amount) || 0;
  const start = dayjs(s.startDate);
  if (!start.isValid() || start.isAfter(dayjs(today))) return 0;
  if (s.period === 'year') {
    const years = Math.max(1, dayjs(today).diff(start, 'year'));
    return a * years;
  }
  if (s.period === 'week') {
    const weeks = Math.max(1, Math.floor(dayjs(today).diff(start, 'day') / 7) + 1);
    return a * weeks;
  }
  const months = Math.max(1, dayjs(today).diff(start, 'month'));
  return a * months;
}

/** 当前生效订阅（排除已停用）。 */
function activeSubs(data: QueryData): Subscription[] {
  const dead = new Set(data.archivedSubIds ?? []);
  return data.subscriptions.filter((s) => !dead.has(s.id));
}

/** 分类周期统计回答。 */
function answerCategorySpend(data: QueryData, r: Range, text: string): string {
  const catId = categoryIdByWord(data, text);
  const list = data.valueRecords
    .filter((v) => inRange(v.date, r) && v.type !== 'income' && (catId ? v.categoryId === catId : true))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const catLabel = catId ? catName(data.categories, catId) : '';
  if (list.length === 0) {
    return `${r.label}没有${catLabel || ''}支出记录。`;
  }
  const sum = list.reduce((s, v) => s + (Number(v.amount) || 0), 0);
  const days = rangeDays(r);
  const showDate = r.start !== r.end;
  const lines = list.slice(0, 5).map((v) => {
    const note = cleanNote(v.note);
    return `· ${showDate ? `${dayLabel(v.date)} ` : ''}${money(Number(v.amount) || 0)}${note ? ` ${note}` : ''}`;
  });
  const more = list.length > 5 ? `\n等 ${list.length} 笔` : '';
  return (
    `${r.label}${catLabel}共 ${list.length} 笔，合计 ${money(sum)}：\n${lines.join('\n')}${more}` +
    `\n日均 ${money(Math.round((sum / days) * 100) / 100)}（按 ${days} 天计）`
  );
}

/** 日均花费回答（含周期收支概览 + 明细）。 */
function answerAvgSpend(data: QueryData, r: Range): string {
  const list = data.valueRecords.filter((v) => inRange(v.date, r));
  if (list.length === 0) return `${r.label}还没有支出记录。`;
  const exp = list.filter((v) => v.type !== 'income');
  const inc = list.filter((v) => v.type === 'income');
  const sumExp = exp.reduce((s, v) => s + (Number(v.amount) || 0), 0);
  const sumInc = inc.reduce((s, v) => s + (Number(v.amount) || 0), 0);
  const dates = list.map((v) => v.date).sort();
  const span = dates.length > 1 ? dayjs(dates[dates.length - 1]!).diff(dayjs(dates[0]!), 'day') + 1 : 1;
  const days = rangeDays(r, span);
  const avg = Math.round((sumExp / days) * 100) / 100;
  const showDate = r.start !== r.end;
  const lines = exp
    .slice(0, 5)
    .map(
      (v) =>
        `· ${showDate ? `${dayLabel(v.date)} ` : ''}${catName(data.categories, v.categoryId)} ${money(
          Number(v.amount) || 0,
        )}${cleanNote(v.note) ? ` ${cleanNote(v.note)}` : ''}`,
    );
  const more = exp.length > 5 ? `\n等 ${exp.length} 笔` : '';
  return (
    `${r.label}共 ${list.length} 笔，支出 ${money(sumExp)}${inc.length ? `，收入 ${money(sumInc)}` : ''}：\n` +
    `${lines.join('\n')}${more}\n日均支出 ${money(avg)}（按 ${days} 天计）`
  );
}

/** 订阅月均回答。 */
function answerSubMonthly(data: QueryData): string {
  const list = activeSubs(data);
  if (list.length === 0) return '还没有生效中的订阅。说一句「开通了XX会员 25/月」就能记。';
  const monthly = list.reduce((s, x) => s + subMonthly(x), 0);
  const yearly = monthly * 12;
  const lines = list.slice(0, MAX_LIST).map((s) => {
    const m = subMonthly(s);
    const per = `${money(Number(s.amount) || 0)}/${PERIOD_LABEL[s.period] ?? '月'}`;
    const conv = s.period !== 'month' && s.type !== 'lifetime' ? `（≈${money(Math.round(m * 100) / 100)}/月）` : '';
    const off = s.autoRenew === false ? '（已关续费）' : '';
    return `· ${s.name} ${per}${conv}${off}`;
  });
  const more = list.length > MAX_LIST ? `\n等 ${list.length} 个` : '';
  return `当前订阅 ${list.length} 个，月均合计 ${money(Math.round(monthly * 100) / 100)}（年化 ${money(
    Math.round(yearly * 100) / 100,
  )}）：\n${lines.join('\n')}${more}`;
}

/** 订阅累计回答。 */
function answerSubTotal(data: QueryData, today: string): string {
  const list = activeSubs(data);
  if (list.length === 0) return '还没有生效中的订阅。';
  let total = 0;
  const lines = list.slice(0, MAX_LIST).map((s) => {
    const spent = subSpentToDate(s, today);
    total += spent;
    return `· ${s.name} 自 ${dayLabel(s.startDate)} 起 ${money(Number(s.amount) || 0)}/${
      PERIOD_LABEL[s.period] ?? '月'
    }，累计 ${money(Math.round(spent * 100) / 100)}`;
  });
  const more = list.length > MAX_LIST ? `\n等 ${list.length} 个` : '';
  return `当前订阅 ${list.length} 个，累计已花 ${money(Math.round(total * 100) / 100)}：\n${lines.join('\n')}${more}`;
}

/** 物品摊销回答（日均成本合计 + TOP，口径复用 domain/goods）。 */
function answerAmortize(data: QueryData, r: Range, today: string): string {
  const active = data.goods.filter((g) => g.status === 'active');
  if (active.length === 0) return '还没有在用物品。说一句「刚买了XX 花了899」就能记。';
  const inRangeList = active.filter((g) => inRange(g.buyDate, r));
  const total = active.reduce((s, g) => s + dailyCost(g, today), 0);
  const top = [...active].sort((a, b) => dailyCost(b, today) - dailyCost(a, today)).slice(0, 3);
  const lines = top.map((g) => {
    const days = holdDays(g, today);
    return `· ${g.name} ${money(Math.round(dailyCost(g, today) * 100) / 100)}/天（${money(
      Number(g.price) || 0,
    )} ÷ ${days} 天）`;
  });
  const scopeNote = inRangeList.length > 0 && r.start !== r.end ? `\n${r.label}新买入 ${inRangeList.length} 件` : '';
  return `在用物品 ${active.length} 件，日均摊销合计 ${money(Math.round(total * 100) / 100)}/天：\n${lines.join(
    '\n',
  )}${scopeNote}`;
}

/* ---------------- 各域回答 ---------------- */

/** 超级比较句（最贵/最便宜/最大/最少…）→ 直接给结论，不给列表。 */
function isSuperlative(text: string): boolean {
  return /最(贵|便宜|廉|多|少|大|小|高|低|长|短|久|爱|常)/.test(text);
}

/** 汇总/报表句（周报/月报/年报/汇总/统计…）。 */
function isSummary(text: string): boolean {
  return /(汇总|统计|月报|周报|年报|日报|季报|报告|总结|盘点|分析|情况|概览|一览)/.test(text);
}

/** 超级比较：方向（max=最贵/最大/最多/最长，min=最便宜/最少/最小/最短）。 */
function superlativeDir(text: string): 'max' | 'min' {
  return /最(便宜|廉|少|小|低|短)/.test(text) ? 'min' : 'max';
}

function answerSuperlative(data: QueryData, r: Range, text: string): string {
  const dir = superlativeDir(text);
  let scope = detectScope(text);
  // all 时按「物品 → 生活流 → 时间」找第一个有数据的域回答
  if (scope === 'all') {
    if (data.goods.some((g) => inRange(g.buyDate, r))) scope = 'goods';
    else if (data.valueRecords.some((v) => inRange(v.date, r))) scope = 'ledger';
    else if (data.times.some((t) => inRange(t.date, r))) scope = 'time';
  }
  if (scope === 'goods') {
    const list = data.goods.filter((g) => inRange(g.buyDate, r));
    if (list.length === 0) return `${r.label}没有买入物品的记录。`;
    const best = list.reduce((a, b) =>
      dir === 'max'
        ? (Number(b.price) || 0) > (Number(a.price) || 0)
          ? b
          : a
        : (Number(b.price) || 0) < (Number(a.price) || 0)
          ? b
          : a,
    );
    const cat = catName(data.categories, best.categoryId);
    const word = dir === 'max' ? '最贵' : '最便宜';
    return `${r.label}买过${word}的是：${best.name} ${money(Number(best.price) || 0)}${
      r.start !== r.end ? `（${dayLabel(best.buyDate)}）` : ''
    }${cat ? ` · ${cat}` : ''}`;
  }
  if (scope === 'ledger') {
    const list = data.valueRecords.filter((v) => inRange(v.date, r));
    if (list.length === 0) return `${r.label}没有生活流记录。`;
    const best = list.reduce((a, b) =>
      dir === 'max'
        ? (Number(b.amount) || 0) > (Number(a.amount) || 0)
          ? b
          : a
        : (Number(b.amount) || 0) < (Number(a.amount) || 0)
          ? b
          : a,
    );
    const word = dir === 'max' ? '最大' : '最小';
    const note = cleanNote(best.note);
    return `${r.label}${word}的一笔：${catName(data.categories, best.categoryId)} ${money(
      Number(best.amount) || 0,
    )}${r.start !== r.end ? `（${dayLabel(best.date)}）` : ''}${note ? ` ${note}` : ''}`;
  }
  if (scope === 'time') {
    const list = data.times.filter((t) => inRange(t.date, r));
    if (list.length === 0) return '还没有时间记录。';
    const best = list.reduce((a, b) =>
      dir === 'max'
        ? (Number(b.durationMin) || 0) > (Number(a.durationMin) || 0)
          ? b
          : a
        : (Number(b.durationMin) || 0) < (Number(a.durationMin) || 0)
          ? b
          : a,
    );
    const word = dir === 'max' ? '最长' : '最短';
    return `${r.label}${word}的一段：${durationText(Number(best.durationMin) || 0)}${
      best.note ? ` ${best.note}` : ''
    }`;
  }
  return answerAll(data, r);
}

/** 汇总报表：收支合计 + 分类构成 + 物品/心情/时间概览。 */
function answerSummary(data: QueryData, r: Range, today: string): string {
  const ledger = data.valueRecords.filter((v) => inRange(v.date, r));
  const goods = data.goods.filter((g) => inRange(g.buyDate, r));
  const moods = data.moods.filter((m) => inRange(m.date, r));
  const times = data.times.filter((t) => inRange(t.date, r));
  const exp = ledger.filter((v) => v.type !== 'income');
  const inc = ledger.filter((v) => v.type === 'income');
  const sumExp = exp.reduce((s, v) => s + (Number(v.amount) || 0), 0);
  const sumInc = inc.reduce((s, v) => s + (Number(v.amount) || 0), 0);
  if (ledger.length === 0 && goods.length === 0 && moods.length === 0 && times.length === 0) {
    return `${r.label}还没有任何记录。说一句「午饭花了25」就能开始记。`;
  }
  const lines: string[] = [`${r.label}汇总：`];
  lines.push(
    `· 生活流 ${ledger.length} 笔：支出 ${money(sumExp)}${inc.length ? ` · 收入 ${money(sumInc)}` : ''}`,
  );
  // 分类构成（支出，降序，最多 6 类）
  if (exp.length > 0) {
    const byCat = new Map<string, { sum: number; n: number }>();
    for (const v of exp) {
      const key = catName(data.categories, v.categoryId) || '其他';
      const cur = byCat.get(key) ?? { sum: 0, n: 0 };
      cur.sum += Number(v.amount) || 0;
      cur.n += 1;
      byCat.set(key, cur);
    }
    const rows = [...byCat.entries()].sort((a, b) => b[1].sum - a[1].sum);
    const shown = rows
      .slice(0, 6)
      .map(([name, v]) => `${name} ${money(v.sum)}（${v.n}笔）`)
      .join('｜');
    lines.push(`· 分类构成：${shown}${rows.length > 6 ? `｜等 ${rows.length} 类` : ''}`);
  }
  if (goods.length > 0) {
    const total = goods.reduce((s, g) => s + (Number(g.price) || 0), 0);
    lines.push(`· 买入物品 ${goods.length} 件，合计 ${money(total)}`);
  }
  // ★v1.3.0：在用物品日均摊销（口径 = domain/goods.dailyCost，与首页卡片一致）
  const activeGoods = data.goods.filter((g) => g.status === 'active');
  if (activeGoods.length > 0) {
    const ref = r.end === '9999-12-31' ? today : r.end;
    const amort = activeGoods.reduce((s, g) => s + dailyCost(g, ref), 0);
    lines.push(`· 物品日均摊销 ${money(Math.round(amort * 100) / 100)}/天（${activeGoods.length} 件在用）`);
  }
  const extra: string[] = [];
  if (moods.length > 0) extra.push(`心情 ${moods.length} 条`);
  if (times.length > 0) {
    const mins = times.reduce((s, t) => s + (Number(t.durationMin) || 0), 0);
    extra.push(`时间 ${durationText(mins)}`);
  }
  if (extra.length > 0) lines.push(`· ${extra.join(' · ')}`);
  return lines.join('\n');
}

function answerGoods(data: QueryData, r: Range): string {
  const list = data.goods
    .filter((g) => inRange(g.buyDate, r))
    .sort((a, b) => (a.buyDate < b.buyDate ? 1 : -1));
  if (list.length === 0) {
    return `${r.label}没有买入物品的记录。说一句「刚买了XX 花了899」就能记。`;
  }
  const total = list.reduce((s, g) => s + (Number(g.price) || 0), 0);
  const showDate = r.start !== r.end;
  const lines = list.slice(0, MAX_LIST).map((g) => {
    const cat = catName(data.categories, g.categoryId);
    const parts = [showDate ? dayLabel(g.buyDate) : '', cat].filter(Boolean);
    return `· ${g.name} ${money(Number(g.price) || 0)}${parts.length ? `（${parts.join(' · ')}）` : ''}`;
  });
  const more = list.length > MAX_LIST ? `\n等 ${list.length} 条，合计 ${money(total)}` : `\n合计 ${money(total)}`;
  return `${r.label}买入 ${list.length} 件物品：\n${lines.join('\n')}${more}`;
}

function answerLedger(data: QueryData, r: Range): string {
  const list = data.valueRecords
    .filter((v) => inRange(v.date, r))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (list.length === 0) {
    return `${r.label}没有生活流记录。说一句「午饭花了25」就能记。`;
  }
  const exp = list.filter((v) => v.type !== 'income');
  const inc = list.filter((v) => v.type === 'income');
  const sumExp = exp.reduce((s, v) => s + (Number(v.amount) || 0), 0);
  const sumInc = inc.reduce((s, v) => s + (Number(v.amount) || 0), 0);
  const showDate = r.start !== r.end;
  const lines = list.slice(0, MAX_LIST).map((v) => {
    const note = cleanNote(v.note);
    const cat = catName(data.categories, v.categoryId);
    const head = `${v.type === 'income' ? '收入' : cat || '支出'}${showDate ? ` ${dayLabel(v.date)}` : ''}`;
    return `· ${head} ${money(Number(v.amount) || 0)}${note ? ` ${note}` : ''}`;
  });
  const more = list.length > MAX_LIST ? `\n等 ${list.length} 笔` : '';
  const head = `${r.label}共 ${list.length} 笔，支出 ${money(sumExp)}${
    inc.length ? `，收入 ${money(sumInc)}` : ''
  }：`;
  return `${head}\n${lines.join('\n')}${more}`;
}

function answerMood(data: QueryData, r: Range): string {
  const list = data.moods
    .filter((m) => inRange(m.date, r))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (list.length === 0) {
    return '还没有心情记录。说一句「今天很开心」就能记。';
  }
  const showDate = r.start !== r.end || r.label !== '今天';
  const lines = list.slice(0, MAX_LIST).map((m) => {
    const txt = (m.text ?? '').trim();
    return `· ${showDate ? `${dayLabel(m.date)} ` : ''}${m.feeling}${txt ? ` ${txt}` : ''}`;
  });
  const more = list.length > MAX_LIST ? `\n等 ${list.length} 条` : '';
  return `心情记录 ${list.length} 条：\n${lines.join('\n')}${more}`;
}

function answerTime(data: QueryData, r: Range): string {
  const list = data.times
    .filter((t) => inRange(t.date, r))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (list.length === 0) {
    return '还没有时间记录。说一句「打游戏打了2小时」就能记。';
  }
  const total = list.reduce((s, t) => s + (Number(t.durationMin) || 0), 0);
  const showDate = r.start !== r.end;
  const lines = list.slice(0, MAX_LIST).map((t) => {
    const note = (t.note ?? '').trim();
    return `· ${showDate ? `${dayLabel(t.date)} ` : ''}${durationText(Number(t.durationMin) || 0)}${
      note ? ` ${note}` : ''
    }`;
  });
  const more = list.length > MAX_LIST ? `\n等 ${list.length} 条` : '';
  return `时间记录 ${list.length} 条，合计 ${durationText(total)}：\n${lines.join('\n')}${more}`;
}

function answerSub(data: QueryData): string {
  const list = data.subscriptions;
  if (list.length === 0) {
    return '还没有订阅记录。说一句「开通了腾讯视频会员 25/月」就能记。';
  }
  const lines = list.slice(0, MAX_LIST).map((s) => {
    const per = `${money(Number(s.amount) || 0)}/${PERIOD_LABEL[s.period] ?? '月'}${
      s.every > 1 ? `（每${s.every}期）` : ''
    }`;
    const next = s.nextRenewDate ? `，${dayLabel(s.nextRenewDate)} 续费` : '';
    return `· ${s.name} ${per}${next}${s.autoRenew === false ? '（已关续费）' : ''}`;
  });
  const more = list.length > MAX_LIST ? `\n等 ${list.length} 个` : '';
  return `当前订阅 ${list.length} 个：\n${lines.join('\n')}${more}`;
}

function answerAll(data: QueryData, r: Range): string {
  const goods = data.goods.filter((g) => inRange(g.buyDate, r));
  const ledger = data.valueRecords.filter((v) => inRange(v.date, r));
  const moods = data.moods.filter((m) => inRange(m.date, r));
  const times = data.times.filter((t) => inRange(t.date, r));
  const sumExp = ledger
    .filter((v) => v.type !== 'income')
    .reduce((s, v) => s + (Number(v.amount) || 0), 0);
  const goodsTotal = goods.reduce((s, g) => s + (Number(g.price) || 0), 0);
  const parts = [
    `物品 ${goods.length} 件${goods.length ? `（${money(goodsTotal)}）` : ''}`,
    `生活流 ${ledger.length} 笔${ledger.length ? `（支出 ${money(sumExp)}）` : ''}`,
    `订阅 ${data.subscriptions.length} 个`,
    `心情 ${moods.length} 条`,
    `时间 ${times.length} 条`,
  ];
  return `${r.label}记录：${parts.join(' · ')}。\n想问细节就说「昨天买了什么」「这周花了多少」「心情怎么样」。`;
}

/* ---------------- 入口 ---------------- */

/**
 * 回答一句查询。调用方需先 `isQueryIntent` 命中。
 *
 * 优先级：超级比较（最贵/最便宜）→ 汇总报表（周报/月报/汇总）→ 摊销 →
 * 分类周期统计 → 日均花费 → 订阅月均/累计 → 分域明细。
 *
 * @returns 多行文本（对话气泡按 `whitespace-pre-line` 展示）
 */
export function answerQuery(text: string, data: QueryData, today: string): string {
  const r = resolveRange(text, today);
  if (isSuperlative(text)) return answerSuperlative(data, r, text);
  if (isSummary(text)) return answerSummary(data, r, today);
  // ★v1.3.0：品类统计必须先于 detectScope（「吃饭」含吃/饭会被误判物品域）
  if (isCategorySpend(text)) return answerCategorySpend(data, r, text);
  if (isAvgSpend(text)) return answerAvgSpend(data, r);
  if (isSubMonthly(text)) return answerSubMonthly(data);
  if (isSubTotal(text)) return answerSubTotal(data, today);
  if (isAmortize(text)) return answerAmortize(data, r, today);
  const scope = detectScope(text);
  switch (scope) {
    case 'goods':
      return answerGoods(data, r);
    case 'ledger':
      return answerLedger(data, r);
    case 'mood':
      return answerMood(data, r);
    case 'time':
      return answerTime(data, r);
    case 'sub':
      return answerSub(data);
    default:
      return answerAll(data, r);
  }
}
