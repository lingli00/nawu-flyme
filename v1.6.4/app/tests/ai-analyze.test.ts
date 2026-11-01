import { describe, expect, it } from 'vitest';
import { localInsights, type AnalyzeInput } from '../src/ai/analyzeService';

/**
 * ★v1.1.3 · AI 分析本地规则洞察（纯函数部分）。
 * AI 增强走网络不在此测；未配置时的降级文案由页面消费。
 */

function input(over: Partial<AnalyzeInput> = {}): AnalyzeInput {
  return {
    windowLabel: '2026-10',
    currency: 'CNY',
    income: 0,
    expense: 0,
    topCategories: [],
    judgement: [],
    trend: [],
    saleProfit: 0,
    recordCount: 0,
    ...over,
  };
}

describe('analyzeService · localInsights', () => {
  it('没有记录 → 只有一条引导文案', () => {
    const out = localInsights(input());
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('先记几笔');
  });

  it('只有支出没有收入 → 说明负结余是口径使然', () => {
    const out = localInsights(input({ expense: 500, recordCount: 3 }));
    expect(out[0]).toContain('只有支出');
    expect(out[0]).toContain('500.00');
  });

  it('支出集中度：Top 分类占 40%+ → 点名大类', () => {
    const out = localInsights(
      input({
        expense: 1000,
        recordCount: 5,
        topCategories: [{ name: '餐饮', amount: 600, ratio: 0.6 }],
      }),
    );
    expect(out.some((t) => t.includes('餐饮') && t.includes('60%'))).toBe(true);
  });

  it('支出分散 → 提示没有单一巨头', () => {
    const out = localInsights(
      input({
        expense: 1000,
        recordCount: 9,
        topCategories: [
          { name: '餐饮', amount: 200, ratio: 0.2 },
          { name: '交通', amount: 180, ratio: 0.18 },
          { name: '娱乐', amount: 150, ratio: 0.15 },
        ],
      }),
    );
    expect(out.some((t) => t.includes('分散'))).toBe(true);
  });

  it('「否」占比 20%+ → 建议先过冷静期', () => {
    const out = localInsights(
      input({
        expense: 1000,
        recordCount: 5,
        judgement: [{ label: '否', amount: 300, ratio: 0.3 }],
      }),
    );
    expect(out.some((t) => t.includes('本可避免') && t.includes('冷却期'))).toBe(true);
  });

  it('趋势：最近一期高出此前均值 20%+ → 点名走高', () => {
    const out = localInsights(
      input({
        expense: 900,
        recordCount: 9,
        trend: [
          { label: '8月', expense: 400, income: 0 },
          { label: '9月', expense: 400, income: 0 },
          { label: '10月', expense: 500, income: 0 },
        ],
      }),
    );
    // 均值 400 → 最近一期 500，高 25%
    expect(out.some((t) => t.includes('10月') && t.includes('高 25%'))).toBe(true);
  });

  it('转卖净赚 > 0 → 提示已计入收入', () => {
    const out = localInsights(
      input({ expense: 300, income: 350, recordCount: 4, saleProfit: 350 }),
    );
    expect(out.some((t) => t.includes('转卖净赚') && t.includes('350.00'))).toBe(true);
  });

  it('有结余 → 报结余数', () => {
    const out = localInsights(input({ income: 1000, expense: 800, recordCount: 2 }));
    expect(out[0]).toContain('结余 200.00');
  });
});
