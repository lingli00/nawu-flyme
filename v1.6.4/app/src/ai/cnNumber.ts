/**
 * 中文数字 → 阿拉伯数字。
 *
 * 覆盖 Web 版口径：`两千=2000`、`一千二=1200`、`三千五=3500`、`半=0.5`。
 */

/** 基本数字字符。 */
const DIGITS: Record<string, number> = {
  零: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
  〇: 0,
};

/** 单位 → 倍数。 */
const UNITS: Record<string, number> = {
  十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000,
};

/** 段位（会触发进位）。 */
const SECTIONS: Record<string, number> = { 万: 10000, 亿: 100000000 };

/**
 * 解析中文数字。
 *
 * 算法：按「段（万/亿）」累加，段内按「单位（十/百/千）」累加；
 * 结尾的单个数字若前面有单位（如「一千二」的「二」），按 `单位/10` 折算，
 * 这样才能得到 `1200` 而不是 `1202`。
 *
 * @returns 解析结果；无法解析时返回 NaN
 */
export function cnToNumber(input: string): number {
  const text = (input ?? '').toString().trim();
  if (!text) return Number.NaN;
  if (/^\d+(\.\d+)?$/.test(text)) return Number.parseFloat(text);
  if (text === '半') return 0.5;
  if (text === '块' || text === '元') return Number.NaN;

  let total = 0;
  let section = 0;
  let current = 0;
  let lastUnit = 0;
  let matched = false;

  for (const ch of text) {
    if (ch in DIGITS) {
      current = DIGITS[ch] as number;
      matched = true;
      continue;
    }
    if (ch in UNITS) {
      const unit = UNITS[ch] as number;
      section += (current === 0 ? 1 : current) * unit;
      current = 0;
      lastUnit = unit;
      matched = true;
      continue;
    }
    if (ch in SECTIONS) {
      const scale = SECTIONS[ch] as number;
      section = (section + current) * scale;
      total += section;
      section = 0;
      current = 0;
      lastUnit = scale;
      matched = true;
      continue;
    }
    // 遇到无法识别的字符（如「块」「钱」）直接结束
    break;
  }

  if (!matched) return Number.NaN;

  // 「一千二」= 1200：结尾数字按上一个单位的 1/10 折算
  if (current > 0 && lastUnit >= 10) {
    total += section + (current * lastUnit) / 10;
  } else {
    total += section + current;
  }
  return total;
}

/**
 * 统一入口：阿拉伯数字或中文数字都能吃。
 * @returns 解析结果；失败返回 NaN
 */
export function toNumber(input: string | number): number {
  if (typeof input === 'number') return Number.isFinite(input) ? input : Number.NaN;
  const text = (input ?? '').toString().trim().replace(/[,，\s]/g, '');
  if (!text) return Number.NaN;
  if (/^\d+(\.\d+)?$/.test(text)) return Number.parseFloat(text);
  // 「1千2百」这类混合写法：先把阿拉伯数字段转成中文再算（简化：只处理纯中文）
  return cnToNumber(text);
}

/** 是否是「可当作金额」的数字（0 < v < 1e8）。 */
export function isAmountLike(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 1e8;
}

/** 中文数字字符类（供正则复用）。 */
export const CN_NUM_CHARS = '零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟〇';
