import { describe, expect, it } from 'vitest';
import { detectTrade, feeAmountOf, parseFeePermille, tradeFees, tradeNetProfit } from '../src/ai/trade';
import type { TradeDraft } from '../src/types/ai';

/**
 * ★v1.3.6 需求 1 回归：对话记一笔要能跑通「二手物品完整交易」。
 *
 * 用户原句：买入N95笔记本360元，卖出560元，手续费费率千分之6、快递费20、额外费用10。
 *
 * 旧版三处连坏：
 *  ① `RE_SELL` 没有「卖出」，这句根本没被识别成卖出 → 记成一笔 560 的支出；
 *  ② 逗号把一句话切成两句，物品卡还没落库，卖出卡就去找物品 → 「请先入库」；
 *  ③ 手续费 / 快递 / 杂费没有落点，净赚口径对不上。
 */

const TODAY = '2026-10-21';

/** 测试用最小命中：只要 detectTrade 非空即可断言字段。 */
function mustTrade(text: string): TradeDraft {
  const d = detectTrade(text, { today: TODAY });
  if (!d) throw new Error(`未识别为二手交易：${text}`);
  return d;
}

describe('detectTrade · 二手买卖一体识别', () => {
  it('用户原句：买入 360 卖出 560，千分之6 + 快递20 + 杂费10', () => {
    const d = mustTrade('买入N95笔记本360元，卖出560元，手续费费率千分之6、快递费20、额外费用10');
    expect(d.name).toBe('N95笔记本');
    expect(d.buyPrice).toBe(360);
    expect(d.sellPrice).toBe(560);
    expect(d.feeRatePermille).toBe(6);
    expect(d.shippingFee).toBe(20);
    expect(d.extraFee).toBe(10);
    expect(d.buyDate).toBe(TODAY);
  });

  it('「N95」里的 95 不会被当成买入金额', () => {
    const d = mustTrade('买入N95笔记本360元，卖出560元');
    expect(d.buyPrice).toBe(360);
  });

  it('费率不吞金额：千分之6 归费率，快递费 20 归快递', () => {
    const d = mustTrade('买了相机2000，卖了2500，手续费千分之6，运费20');
    expect(d.buyPrice).toBe(2000);
    expect(d.sellPrice).toBe(2500);
    expect(d.feeRatePermille).toBe(6);
    expect(d.shippingFee).toBe(20);
  });

  it('同一分句里买卖都出现（无逗号）也能拆开', () => {
    const d = mustTrade('买入N95笔记本360元卖出560元');
    expect(d.buyPrice).toBe(360);
    expect(d.sellPrice).toBe(560);
  });

  it('「卖了」写法同样命中', () => {
    const d = mustTrade('买了台二手显示器 500，卖了 700');
    expect(d.buyPrice).toBe(500);
    expect(d.sellPrice).toBe(700);
  });

  it('只有买、没有卖 → 不拦（交回原链路建物品）', () => {
    expect(detectTrade('买了N95笔记本360元', { today: TODAY })).toBeNull();
  });

  it('只有卖、没有买 → 不拦（交回原链路走退役转卖）', () => {
    expect(detectTrade('把N95笔记本卖了560元', { today: TODAY })).toBeNull();
  });

  it('有买卖动词但缺价格 → 不拦', () => {
    expect(detectTrade('买入N95笔记本，卖出去了', { today: TODAY })).toBeNull();
  });

  it('全角数字也能识别（语音/中文输入法常见）', () => {
    const d = mustTrade('买入Ｎ９５笔记本３６０元，卖出５６０元，手续费千分之６');
    expect(d.buyPrice).toBe(360);
    expect(d.sellPrice).toBe(560);
    expect(d.feeRatePermille).toBe(6);
  });
});

describe('parseFeePermille · 各种费率写法', () => {
  it('千分之6 / 千分之六 / 6‰ / 0.6% 都归一到千分比 6', () => {
    expect(parseFeePermille('手续费千分之6')).toBe(6);
    expect(parseFeePermille('手续费千分之六')).toBe(6);
    expect(parseFeePermille('手续费6‰')).toBe(6);
    expect(parseFeePermille('手续费0.6%')).toBe(6);
  });

  it('「6个点」按百分点算 → 6% = 千分之 60', () => {
    expect(parseFeePermille('手续费6个点')).toBe(60);
  });

  it('没有费率时返回 0（而不是瞎猜）', () => {
    expect(parseFeePermille('快递费20')).toBe(0);
    expect(parseFeePermille('')).toBe(0);
  });

  it('离谱费率（>10%）不采纳', () => {
    expect(parseFeePermille('手续费千分之500')).toBe(0);
  });
});

describe('手续费与净赚口径', () => {
  const d = mustTrade('买入N95笔记本360元，卖出560元，手续费费率千分之6、快递费20、额外费用10');

  it('手续费 = 售价 × 费率（560 × 6‰ = 3.36）', () => {
    expect(feeAmountOf(560, 6)).toBe(3.36);
    expect(feeAmountOf(560, 0)).toBe(0);
  });

  it('三项费用都折进附加费用，名称不丢', () => {
    const fees = tradeFees(d);
    expect(fees).toEqual([
      { name: '手续费', amount: 3.36 },
      { name: '快递费', amount: 20 },
      { name: '杂费', amount: 10 },
    ]);
  });

  it('净赚 = 560 − 360 − 3.36 − 20 − 10 = 166.64', () => {
    expect(tradeNetProfit(d)).toBe(166.64);
  });

  it('没提任何费用时，净赚就是差价', () => {
    expect(
      tradeNetProfit({ buyPrice: 300, sellPrice: 500, feeRatePermille: 0, shippingFee: 0, extraFee: 0 }),
    ).toBe(200);
  });

  it('亏本转卖：净赚为负（调用方据此不记生活流收入）', () => {
    expect(
      tradeNetProfit({ buyPrice: 900, sellPrice: 500, feeRatePermille: 6, feeAmount: 3, shippingFee: 20, extraFee: 0 }),
    ).toBe(-423);
  });
});
