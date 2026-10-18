/**
 * 金额工具。
 *
 * 约定（架构 §10.2）：金额一律 `number`，单位「元」（不用分），不做自动汇率换算（P1）。
 */

export interface CurrencyMeta {
  code: string;
  symbol: string;
  name: string;
}

/** 12 种货币（与 Web 版一致）。 */
export const CURRENCIES: CurrencyMeta[] = [
  { code: 'CNY', symbol: '¥', name: '人民币' },
  { code: 'USD', symbol: '$', name: '美元' },
  { code: 'EUR', symbol: '€', name: '欧元' },
  { code: 'JPY', symbol: '¥', name: '日元' },
  { code: 'GBP', symbol: '£', name: '英镑' },
  { code: 'HKD', symbol: 'HK$', name: '港币' },
  { code: 'TWD', symbol: 'NT$', name: '新台币' },
  { code: 'KRW', symbol: '₩', name: '韩元' },
  { code: 'SGD', symbol: 'S$', name: '新加坡元' },
  { code: 'AUD', symbol: 'A$', name: '澳元' },
  { code: 'CAD', symbol: 'C$', name: '加元' },
  { code: 'THB', symbol: '฿', name: '泰铢' },
];

const SYMBOL_MAP: Record<string, string> = CURRENCIES.reduce<Record<string, string>>((acc, c) => {
  acc[c.code] = c.symbol;
  return acc;
}, {});

/** 取货币符号（未知货币回落到原 code）。 */
export function symbolOf(currency: string): string {
  return SYMBOL_MAP[currency] ?? (currency ? `${currency} ` : '¥');
}

/** 千分位 + 最多两位小数（去掉末尾多余的 0）。 */
export function formatAmount(amount: number, maxFractionDigits = 2): string {
  const n = Number.isFinite(amount) ? amount : 0;
  return n.toLocaleString('zh-CN', { maximumFractionDigits: maxFractionDigits });
}

/**
 * 格式化金额：`¥1,200` / `¥30.5` / `-¥88`。
 *
 * @param amount 金额（元）
 * @param currency 货币代码，默认 CNY
 * @param withSign 支出是否显示负号，默认 false（列表里用颜色区分方向）
 */
export function formatMoney(amount: number, currency: string = 'CNY', withSign = false): string {
  const n = Number.isFinite(amount) ? amount : 0;
  const sign = withSign && n < 0 ? '-' : '';
  return `${sign}${symbolOf(currency)}${formatAmount(Math.abs(n))}`;
}

/** 带正负号：`+¥12,000` / `-¥88`（明细行用）。 */
export function formatSignedMoney(amount: number, type: 'expense' | 'income', currency: string = 'CNY'): string {
  const sign = type === 'income' ? '+' : '-';
  return `${sign}${symbolOf(currency)}${formatAmount(Math.abs(amount))}`;
}

/**
 * 净额带符号（★v1.0.35）：`+¥120` / `-¥47.59` / `¥0`。
 *
 * 此前报表「结余/净额」直接用 formatMoney（默认不带符号），负值被显示成
 * 正数金额——用户看到红色「结余 ¥47.59」却理解成「还剩 47.59」，实为
 * -47.59（支出多于收入）。统一改用本函数显示方向。
 */
export function formatNetMoney(amount: number, currency: string = 'CNY'): string {
  const n = Number.isFinite(amount) ? amount : 0;
  if (Math.abs(n) < 0.005) return `${symbolOf(currency)}0`;
  return `${n > 0 ? '+' : '-'}${symbolOf(currency)}${formatAmount(Math.abs(n))}`;
}

/** 紧凑写法：12000 → `1.2万`（概览卡片用）。 */
export function formatCompactMoney(amount: number, currency: string = 'CNY'): string {
  const n = Math.abs(Number.isFinite(amount) ? amount : 0);
  if (n >= 10000) return `${symbolOf(currency)}${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}万`;
  return formatMoney(amount, currency);
}

/** 安全转数字（解析失败返回 0）。 */
export function toAmount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,\s]/g, '');
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** 求和（自动过滤非法值）。 */
export function sumAmounts(values: number[]): number {
  return values.reduce((acc, v) => acc + toAmount(v), 0);
}

/** 四舍五入到指定小数位（默认 2 位，避免浮点尾差）。 */
export function round(amount: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round((Number.isFinite(amount) ? amount : 0) * p) / p;
}
