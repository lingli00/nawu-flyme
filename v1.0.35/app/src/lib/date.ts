import dayjs from 'dayjs';

/**
 * 日期工具。
 *
 * 约定（架构 §10.2）：业务日期统一 `'YYYY-MM-DD'` 字符串，按设备本地时区；
 * 时间戳字段（`createdAt` / `exportedAt`）用 ISO 8601 UTC 字符串。
 */

export const DATE_FORMAT = 'YYYY-MM-DD';
const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 今天（'YYYY-MM-DD'）。 */
export function today(): string {
  return dayjs().format(DATE_FORMAT);
}

/** 当前时刻的 ISO 字符串（UTC）。 */
export function nowISO(): string {
  return new Date().toISOString();
}

/** 格式化日期；入参可以是 'YYYY-MM-DD'、Date 或时间戳。 */
export function fmtDate(value: string | number | Date | undefined | null, pattern: string = DATE_FORMAT): string {
  if (value === undefined || value === null || value === '') return '';
  return dayjs(value).format(pattern);
}

/** 日期加减天数，返回 'YYYY-MM-DD'。 */
export function addDays(date: string, days: number): string {
  return dayjs(date).add(days, 'day').format(DATE_FORMAT);
}

/** 日期加减月份，返回 'YYYY-MM-DD'。 */
export function addMonths(date: string, months: number): string {
  return dayjs(date).add(months, 'month').format(DATE_FORMAT);
}

/** 取月份键 'YYYY-MM'。 */
export function monthKey(date: string = today()): string {
  return dayjs(date || undefined).format('YYYY-MM');
}

/** 某月的起止日期（含首尾）。 */
export function monthRange(ym: string): { start: string; end: string } {
  const d = dayjs(`${ym}-01`);
  return {
    start: d.startOf('month').format(DATE_FORMAT),
    end: d.endOf('month').format(DATE_FORMAT),
  };
}

/** 上一个月（'YYYY-MM'）。 */
export function prevMonth(ym: string): string {
  return dayjs(`${ym}-01`).subtract(1, 'month').format('YYYY-MM');
}

/** 下一个月（'YYYY-MM'）。 */
export function nextMonth(ym: string): string {
  return dayjs(`${ym}-01`).add(1, 'month').format('YYYY-MM');
}

/** b - a，按天取整（可为负）。 */
export function daysBetween(a: string, b: string): number {
  return dayjs(b).startOf('day').diff(dayjs(a).startOf('day'), 'day');
}

/** 距今天多少天（正数=未来，负数=过去）。 */
export function daysFromToday(date: string): number {
  return daysBetween(today(), date);
}

/** 相对日期文案：今天 / 昨天 / 前天 / 明天 / M月D日。 */
export function relativeDayLabel(date: string): string {
  const diff = daysFromToday(date);
  if (diff === 0) return '今天';
  if (diff === -1) return '昨天';
  if (diff === -2) return '前天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  return fmtDate(date, 'M月D日');
}

/** 星期文案：'周二'。 */
export function cnWeekday(date: string = today()): string {
  return WEEK_CN[dayjs(date || undefined).day()] ?? '';
}

/** '2026-10-06（周二）' —— AI 提示词用。 */
export function todayLabelWithWeek(): string {
  const t = today();
  return `${t}（${cnWeekday(t)}）`;
}

/** 是否合法日期字符串。 */
export function isValidDate(date: string): boolean {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return dayjs(date).isValid() && dayjs(date).format(DATE_FORMAT) === date;
}

/** 最近 n 天（含今天），升序。 */
export function lastNDays(n: number, from: string = today()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(addDays(from, -i));
  return out;
}

/** 最近 n 个月的键（含本月），升序。 */
export function lastNMonths(n: number, from: string = today()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(dayjs(`${monthKey(from)}-01`).subtract(i, 'month').format('YYYY-MM'));
  return out;
}

/** '10月' / '2026年10月'。 */
export function monthLabel(ym: string, withYear = false): string {
  const d = dayjs(`${ym}-01`);
  return withYear ? d.format('YYYY年M月') : d.format('M月');
}

/** 把任意输入安全转成 'YYYY-MM-DD'（失败回落今天）。 */
export function toDateString(value: unknown, fallback: string = today()): string {
  if (typeof value !== 'string' || !isValidDate(value)) return fallback;
  return value;
}

/** ISO → 本地可读时间 'MM-DD HH:mm'。 */
export function fmtTimestamp(iso: string): string {
  if (!iso) return '';
  const d = dayjs(iso);
  return d.isValid() ? d.format('MM-DD HH:mm') : '';
}
