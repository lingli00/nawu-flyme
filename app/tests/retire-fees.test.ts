import { describe, expect, it } from 'vitest';
import { feeAmountOf, parseSellFees, tradeFees, tradeNetProfit } from '../src/ai/trade';
import { parseLocal } from '../src/ai/localParser';

/**
 * ★v1.3.7 需求 2 回归：退役费用要能按**费率**录，而不是只能填固定金额。
 *
 * 用户原句：「我把粉色的N95笔记本卖了329，运费10块，手续费是2.1%」
 *
 * 旧版退役链路只取「物品 + 售价」，运费和手续费被整句丢掉：
 *   - 卡片上没有费用入口，想补只能当成「固定金额」；
 *   - 净赚 = 售价 − 买入，永远偏高。
 */

describe('parseSellFees · 纯卖出句子的费用抽取', () => {
  it('识别运费 + 百分比费率', () => {
    const f = parseSellFees('我把粉色的N95笔记本卖了329，运费10块，手续费是2.1%');
    expect(f.shippingFee).toBe(10);
    // 2.1% → 千分比 21
    expect(f.feeRatePermille).toBe(21);
  });

  it('支持千分之 / 个点 等口语写法', () => {
    expect(parseSellFees('卖了500，手续费千分之6').feeRatePermille).toBe(6);
    expect(parseSellFees('卖了500，手续费6个点').feeRatePermille).toBe(60);
    expect(parseSellFees('卖了500，手续费0.6%').feeRatePermille).toBe(6);
  });

  it('手续费给了绝对金额时不硬套费率', () => {
    const f = parseSellFees('卖了800，手续费 12 元');
    expect(f.feeAmount).toBe(12);
    expect(f.feeRatePermille).toBe(0);
  });

  it('没说费用就全是 0', () => {
    const f = parseSellFees('卖掉旧键盘 120');
    expect(f).toEqual({ feeRatePermille: 0, feeAmount: 0, shippingFee: 0, extraFee: 0 });
  });
});

describe('费率金额换算 · 与卡片显示一致', () => {
  it('售价 329、费率 2.1% → 手续费 6.91', () => {
    expect(feeAmountOf(329, 21)).toBe(6.91);
  });

  it('净赚扣掉手续费与运费', () => {
    const sell = 329;
    const permille = 21;
    const fee = feeAmountOf(sell, permille);
    expect(
      tradeNetProfit({ buyPrice: 200, sellPrice: sell, feeRatePermille: permille, shippingFee: 10 }),
    ).toBeCloseTo(329 - 200 - fee - 10, 2);
  });

  it('费用落库名与「二手买卖一体」一致（手续费 / 快递费）', () => {
    const fees = tradeFees({ sellPrice: 329, feeRatePermille: 21, shippingFee: 10 });
    expect(fees.map((f) => f.name)).toEqual(['手续费', '快递费']);
  });
});

describe('localParser · 退役草稿带出费用', () => {
  it('「卖了 X，运费 Y，手续费 Z%」把三项都带出来', () => {
    const item = parseLocal('我把粉色的N95笔记本卖了329，运费10块，手续费是2.1%', []);
    expect(item.action).toBe('retire_sell');
    expect(item.retireDraft?.sellPrice).toBe(329);
    expect(item.retireDraft?.shippingFee).toBe(10);
    expect(item.retireDraft?.feeRatePermille).toBe(21);
  });
});
