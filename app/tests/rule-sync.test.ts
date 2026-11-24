// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

/**
 * ★v1.3.3 识别规则云端同步（`src/api/ruleSync.ts`）。
 *
 * 三个必须守住的点：
 * 1. **信封兼容**：云端 payload 从「裸数组」升级成 `{v:2, manual, learned}`，
 *    老账号读回来不能丢手动规则；老客户端读到新信封也不能崩。
 * 2. **隐私**：`from` 是「来源样本原文」（用户当时说的一整句话），
 *    按需求「对话产生的数据只留在本机」——上云前一律剥空。
 * 3. **合并**：同一 id 的规则取 hits 大的那条；本机的 `from` 不被云端的空串覆盖。
 */

import { mergeLearned, parseEnvelope, sanitizeForCloud } from '../src/api/ruleSync';
import type { LearnedRule } from '../src/ai/ruleBank';

function rule(over: Partial<LearnedRule> = {}): LearnedRule {
  return {
    id: 'r1',
    keyword: 'n95',
    coWords: ['口罩'],
    kind: 'ledger',
    categoryName: '健康',
    hits: 1,
    from: '刚买了一盒N95口罩 花了39',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('规则信封兼容（v2）', () => {
  it('旧数据是裸数组 → 全进 manual，learned 为空', () => {
    const env = parseEnvelope([{ keyword: 'x', categoryName: '数码' }]);
    expect(env.v).toBe(2);
    expect(env.manual).toHaveLength(1);
    expect(env.learned).toEqual([]);
  });

  it('新信封原样读回两段', () => {
    const env = parseEnvelope({ v: 2, manual: [{ keyword: 'a' }], learned: [rule()] });
    expect(env.manual).toHaveLength(1);
    expect(env.learned).toHaveLength(1);
    expect(env.learned[0].keyword).toBe('n95');
  });

  it('老客户端写的 { rules: [...] } 也能读成 manual', () => {
    const env = parseEnvelope({ rules: [{ keyword: 'b' }] });
    expect(env.manual).toHaveLength(1);
  });

  it('null / 字符串 / 缺字段一律降级成空信封，不抛错', () => {
    for (const raw of [null, undefined, 'oops', 42, {}, { v: 2 }]) {
      const env = parseEnvelope(raw);
      expect(env.v).toBe(2);
      expect(Array.isArray(env.manual)).toBe(true);
      expect(Array.isArray(env.learned)).toBe(true);
    }
  });
});

describe('上云脱敏', () => {
  it('from 被剥成空串，规则本体原样保留', () => {
    const out = sanitizeForCloud([rule(), rule({ id: 'r2', keyword: '纸巾', from: '超市买了纸巾 12 块' })]);
    expect(out.map((r) => r.from)).toEqual(['', '']);
    expect(out[0].keyword).toBe('n95');
    expect(out[1].categoryName).toBe('健康');
    // 原文里出现的金额/店名绝不能跟着上云
    expect(JSON.stringify(out)).not.toContain('39');
    expect(JSON.stringify(out)).not.toContain('超市');
  });

  it('不改动入参数组（纯函数）', () => {
    const src = [rule()];
    sanitizeForCloud(src);
    expect(src[0].from).toBe('刚买了一盒N95口罩 花了39');
  });
});

describe('规则合并', () => {
  it('同 id 取 hits 大的那条', () => {
    const merged = mergeLearned([rule({ hits: 1 })], [rule({ hits: 7 })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].hits).toBe(7);
  });

  it('本机 from 不被云端的空串覆盖（排查信息要留着）', () => {
    const local = [rule({ from: '刚买了一盒N95口罩 花了39', hits: 2 })];
    const cloud = [rule({ from: '', hits: 5 })];
    const merged = mergeLearned(local, cloud);
    expect(merged[0].hits).toBe(5);
    expect(merged[0].from).toBe('刚买了一盒N95口罩 花了39');
  });

  it('两边独有的规则都保留（并集）', () => {
    const merged = mergeLearned([rule({ id: 'a' })], [rule({ id: 'b', keyword: '洗衣液' })]);
    expect(merged.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});
