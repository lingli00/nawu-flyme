import { round } from '../lib/money';
import type { ExtraFee } from '../types/entities';
import type { TradeDraft } from '../types/ai';
import { cnToNumber } from './cnNumber';

/**
 * ★v1.3.6 二手物品「买入 + 卖出」一体识别。
 *
 * 需求原点（用户原话）：
 *   「买入N95笔记本360元，卖出560元，手续费费率千分之6、快递费20、额外费用10」
 *   ——要能一句话跑完：先入库（带买入金额）→ 卡片下方展开卖出信息（售价 / 费率 /
 *   快递 / 杂费）→ 提交后自动标记退役（已售出），净赚计入生活流。
 *
 * 旧版为什么跑不通：
 *   1. `RE_SELL` 里只有「卖了/出售/回血…」，**没有「卖出」**——「卖出560元」根本没被
 *      当成卖出动作，最后按「有金额的生活流」记成了一笔 560 的支出；
 *   2. 一条消息被逗号切成两句，买入句和卖出句各自弹一张卡：物品卡还没落库，
 *      卖出卡去物品库里找不到目标 → 直接报「没找到匹配的物品，请先入库」。
 *
 * 本模块只做**纯解析**（不读 store、不发请求），输出一个 `TradeDraft`，
 * 由 `SmartRecordDock` 先于分句链路拦截，走一张「买卖一体」确认卡。
 * 手续费不做成独立字段：一律折进 `extraFees`，这样
 * `sellProfit = 售价 − (买入价 + 所有附加费用)` 的既有口径不用改，
 * 净赚、日均成本、生活流收入自动就是对的。
 */

/** 卖出动作（含「卖出」——旧规则漏掉的那个词）。 */
const SELL_RE = /(卖出|卖了|卖掉|出掉|出售|回血|转让|出手|转手|已出)/;
/** 买入动作。 */
const BUY_RE = /(买入|买了|购入|入手|买到|购买|买)/;
/** 费率写法：千分之6 / 千分之六 / 0.6% / 6‰ / 6个点。 */
const RATE_RE = /(千分之?\s*[0-9一二三四五六七八九十点]+|百分之?\s*[0-9一二三四五六七八九十点]+|[0-9.]+\s*[%‰]|[0-9.]+\s*个点)/;
/** 快递 / 运费。 */
const SHIP_RE = /(快递费|快递|运费|邮费|物流费)/;
/** 额外杂费。 */
const EXTRA_RE = /(额外费用|额外杂费|额外开支|额外|杂费|其他费用|其它费用|其他|其它)/;
/** 手续费类（费率或金额）。 */
const FEE_RE = /(手续费|佣金|服务费|平台费|抽成)/;

/** 分句用的分隔符（保留原文顺序）。 */
const CLAUSE_SEP = /[，,、；;。\n]+/;

/** 全角数字/字母 → 半角。 */
function toHalfWidth(s: string): string {
  return (s ?? '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * 取分句里第一个「像金额」的数字。
 *
 * 跳过两类：① 与字母紧邻的型号码（`N95` / `8G+128G`）；
 * ② 费率片段（`千分之6` / `0.6%` / `6‰` / `6个点`）里的数字。
 */
export function firstAmountIn(clause: string): number {
  const re = /(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null = re.exec(clause);
  while (m) {
    const token = m[0];
    const start = m.index;
    const end = start + token.length;
    const prev = clause.slice(Math.max(0, start - 1), start);
    const next = clause.slice(end, end + 1);
    const tail = clause.slice(end, end + 4);
    const head = clause.slice(Math.max(0, start - 4), start);
    const isModel = /[A-Za-z]/.test(prev) || /[A-Za-z]/.test(next);
    const isRate =
      /^\s*(?:[%‰]|个点)/.test(tail) || /千分之?\s*$/.test(head) || /百分之?\s*$/.test(head);
    if (!isModel && !isRate) {
      const v = Number(token);
      if (Number.isFinite(v) && v > 0) return v;
    }
    m = re.exec(clause);
  }
  return 0;
}

/**
 * 解析费率 → **千分比**（千分之 6 = 6）。
 * 支持：千分之6 / 千分之六 / 0.6% / 6‰ / 6个点；无法解析返回 0。
 */
export function parseFeePermille(text: string): number {
  const m = RATE_RE.exec(text);
  if (!m) return 0;
  const raw = m[1];
  const numText = raw.replace(/^(千分之?|百分之?)/, '').replace(/[%‰个点\s]/g, '');
  const n = /^[\d.]+$/.test(numText) ? Number(numText) : cnToNumber(numText);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 百分数 / 个点 → 千分比 ×10；千分比 / ‰ → 原值
  const isPercent = /^(百分之?)/.test(raw) || /%|个点/.test(raw);
  const permille = isPercent ? n * 10 : n;
  // 防手滑：费率不允许超过 100‰（10%）
  return permille > 0 && permille <= 100 ? round(permille, 4) : 0;
}

/** 手续费金额 = 售价 × 费率（千分比）。 */
export function feeAmountOf(sellPrice: number, permille: number): number {
  const price = Number.isFinite(sellPrice) ? sellPrice : 0;
  const rate = Number.isFinite(permille) ? permille : 0;
  if (price <= 0 || rate <= 0) return 0;
  return round((price * rate) / 1000, 2);
}

/**
 * 卖出侧附加费用（计入总投入，从而从净赚里扣掉）。
 * 只保留非零项，名称用中文短名，与物品详情页「附加费用」列表一致。
 */
export function tradeFees(d: {
  sellPrice: number;
  feeRatePermille: number;
  feeAmount?: number;
  shippingFee?: number;
  extraFee?: number;
}): ExtraFee[] {
  const out: ExtraFee[] = [];
  const fee = d.feeAmount && d.feeAmount > 0 ? round(d.feeAmount, 2) : feeAmountOf(d.sellPrice, d.feeRatePermille);
  if (fee > 0) out.push({ name: '手续费', amount: fee });
  if (d.shippingFee && d.shippingFee > 0) out.push({ name: '快递费', amount: round(d.shippingFee, 2) });
  if (d.extraFee && d.extraFee > 0) out.push({ name: '杂费', amount: round(d.extraFee, 2) });
  return out;
}

/** 净赚 = 售价 − 买入价 − 手续费 − 快递费 − 杂费。 */
export function tradeNetProfit(d: {
  buyPrice: number;
  sellPrice: number;
  feeRatePermille: number;
  feeAmount?: number;
  shippingFee?: number;
  extraFee?: number;
}): number {
  const fees = tradeFees(d).reduce((acc, f) => acc + f.amount, 0);
  return round((d.sellPrice || 0) - (d.buyPrice || 0) - fees, 2);
}

/** 从买入分句里抠物品名：去动词、去金额、去费用词。 */
function nameFromBuyClause(clause: string): string {
  let s = clause
    .replace(/(买入|买了|购入|入手|买到|购买|买了个|买)/g, ' ')
    .replace(/(手续费|佣金|服务费|平台费|抽成|快递费|快递|运费|邮费|物流费|额外费用|额外杂费|额外|杂费|其他费用|其它费用|其他|其它)/g, ' ')
    /**
     * 金额才抹掉，**型号码保留**：
     * `N95笔记本360元` 只该去掉 360 元，不能把 N95 的 95 一起吃了
     * （旧版 `\d+` 无差别替换会得到「N 笔记本」——正是名称记残的老毛病）。
     */
    .replace(/(\d+(?:\.\d+)?)(\s*(?:块钱|块|元|人民币|圆))?/g, (m, _num, unit, offset: number, whole: string) => {
      const prev = whole.slice(Math.max(0, offset - 1), offset);
      const next = whole.slice(offset + m.length, offset + m.length + 1);
      const looksLikeModel = /[A-Za-z]/.test(prev) || /[A-Za-z]/.test(next);
      if (!unit && looksLikeModel) return m;
      return ' ';
    })
    .replace(/[，,、；;。.!！?？~～\-—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 「N95笔记本360元」这类：数字已剥掉，只剩名称；再去掉尾部虚词
  s = s.replace(/(的|了|一个|个)$/g, '').trim();
  return s.slice(0, 24);
}

/** 解析上下文（分类匹配用）。 */
export interface TradeParseContext {
  /** 参考「今天」 */
  today: string;
  currency?: string;
}

/**
 * 识别「买入 + 卖出」一体场景。
 *
 * @returns 命中返回 `TradeDraft`；只要缺买入价或卖出价就返回 `null`
 *          （不抢原链路：单条「卖了 X」仍走 retire_sell，单条「买了 X」仍走物品/生活流）。
 */
export function detectTrade(text: string, ctx: TradeParseContext): TradeDraft | null {
  const raw = toHalfWidth(text ?? '').trim();
  if (!raw) return null;
  // 必须同时有买入语义与卖出语义，否则不归本流程
  if (!SELL_RE.test(raw) || !BUY_RE.test(raw)) return null;

  const clauses = raw.split(CLAUSE_SEP).map((c) => c.trim()).filter(Boolean);
  let buyPrice = 0;
  let sellPrice = 0;
  let feeRatePermille = 0;
  let feeAmount = 0;
  let shippingFee = 0;
  let extraFee = 0;
  let name = '';

  for (const clause of clauses) {
    // ① 费率优先：「手续费费率千分之6」里的 6 不是金额
    if (RATE_RE.test(clause) && (FEE_RE.test(clause) || /费率/.test(clause) || !/\d+\s*(元|块)/.test(clause))) {
      const rate = parseFeePermille(clause);
      if (rate > 0) feeRatePermille = rate;
      continue;
    }
    // ② 快递 / 运费
    if (SHIP_RE.test(clause)) {
      const v = firstAmountIn(clause);
      if (v > 0) shippingFee = v;
      continue;
    }
    // ③ 额外杂费
    if (EXTRA_RE.test(clause)) {
      const v = firstAmountIn(clause);
      if (v > 0) extraFee = v;
      continue;
    }
    // ④ 手续费（给了绝对值而非费率的情形）
    if (FEE_RE.test(clause)) {
      const v = firstAmountIn(clause);
      if (v > 0) feeAmount = v;
      continue;
    }
    // ⑤ 同一分句里「买入 … 卖出 …」都出现：以卖出词为界切两段
    if (BUY_RE.test(clause) && SELL_RE.test(clause)) {
      const at = clause.search(SELL_RE);
      const buyPart = clause.slice(0, at);
      const sellPart = clause.slice(at);
      const bp = firstAmountIn(buyPart);
      const sp = firstAmountIn(sellPart);
      if (bp > 0) {
        buyPrice = bp;
        name = nameFromBuyClause(buyPart);
      }
      if (sp > 0) sellPrice = sp;
      continue;
    }
    // ⑥ 纯卖出分句
    if (SELL_RE.test(clause) && !BUY_RE.test(clause)) {
      const v = firstAmountIn(clause);
      if (v > 0) sellPrice = v;
      continue;
    }
    // ⑦ 纯买入分句
    if (BUY_RE.test(clause) && !SELL_RE.test(clause)) {
      const v = firstAmountIn(clause);
      if (v > 0) {
        buyPrice = v;
        name = nameFromBuyClause(clause);
      }
    }
  }

  // 两个价格缺一不可——否则不是「买卖一体」，交给原链路
  if (buyPrice <= 0 || sellPrice <= 0) return null;

  const finalName = name || nameFromBuyClause(raw) || '物品';
  return {
    name: finalName,
    buyPrice,
    sellPrice,
    buyDate: ctx.today,
    currency: ctx.currency ?? 'CNY',
    categoryId: '',
    feeRatePermille,
    feeAmount,
    shippingFee,
    extraFee,
    note: raw.slice(0, 40),
  };
}

/**
 * 解析优先级：`detectTrade` 命中即用；未命中返回 null 让调用方走原链路。
 * 单独导出便于单测与后续在 AI 路径复用。
 */
export function parseTrade(text: string, ctx: TradeParseContext): TradeDraft | null {
  return detectTrade(text, ctx);
}
