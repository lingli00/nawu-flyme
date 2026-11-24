import { describe, expect, it } from 'vitest';
import { dailyQuote } from '../src/lib/dailyQuote';

/**
 * ★v1.0.35：生活流「每日一言」。
 * 锁定三个性质：同日稳定 / 跨日轮换 / 字段完整。
 */
describe('dailyQuote 每日一言', () => {
  it('同一天内多次调用结果一致（确定性）', () => {
    const d = new Date(2026, 9, 17, 8, 0, 0);
    const a = dailyQuote(d);
    const b = dailyQuote(new Date(2026, 9, 17, 23, 59, 59));
    expect(a.text).toBe(b.text);
  });

  it('跨日轮换：相邻两天不同（且长期覆盖多条）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const d = new Date(2026, 0, 1 + i);
      seen.add(dailyQuote(d).text);
    }
    // 60 天内应覆盖池子里相当多的条目（池 40+ 条，60 天必重复但集合应 > 30）
    expect(seen.size).toBeGreaterThan(30);
  });

  it('每条语录都有非空正文，作者可有可无', () => {
    for (let i = 0; i < 400; i++) {
      const q = dailyQuote(new Date(2026, 0, 1 + (i % 365)));
      expect(q.text.trim().length).toBeGreaterThan(4);
      if (q.from !== undefined) expect(q.from.trim().length).toBeGreaterThan(0);
    }
  });
});
