import { describe, expect, it } from 'vitest';
import { splitSentences } from '../src/ai/split';
import { parseLocalOnly } from '../src/ai/parseService';
import type { Category } from '../src/types/entities';

/**
 * 回归：真机语音输入的标点容错（用户实测反馈）。
 * - 句尾「。」不能导致整句不识别；
 * - 逗号两侧都有金额才拆分；只有一侧有金额（如「买了华为手机，花了3999」）保持一句；
 * - 全角数字（中文输入法）要归一化。
 */

const cats: Category[] = [];

describe('ai/split · 标点容错', () => {
  it('句尾「。」被剥掉，不产生空分句', () => {
    expect(splitSentences('今天早上吃了油条花了30。')).toEqual(['今天早上吃了油条花了30']);
    expect(splitSentences('花了30。！')).toEqual(['花了30']);
  });

  it('逗号两侧都有金额 → 拆成两笔', () => {
    expect(splitSentences('早饭12元，大巴30元')).toEqual(['早饭12元', '大巴30元']);
  });

  it('只有一侧有金额 → 保持一句（物品名不丢）', () => {
    expect(splitSentences('买了华为手机，花了3999')).toEqual(['买了华为手机，花了3999']);
  });

  it('句中句尾混合标点不产生空句', () => {
    const out = splitSentences('早上吃了个包子5块，然后坐地铁2元。');
    expect(out).toEqual(['早上吃了个包子5块', '坐地铁2元']);
  });
});

describe('ai/parse · 语音标点端到端', () => {
  it('「今天早饭花了12元。」→ 1 笔支出 12 元（句号不炸）', () => {
    const out = parseLocalOnly('今天早饭花了12元。', { categories: cats, today: '2026-10-07' });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.action).toBe('create_ledger');
    expect(out.items[0]?.ledgerDraft?.amount).toBe(12);
  });

  it('「早饭12元，大巴30元。」→ 2 笔', () => {
    const out = parseLocalOnly('早饭12元，大巴30元。', { categories: cats, today: '2026-10-07' });
    expect(out.items).toHaveLength(2);
    expect(out.items[0]?.ledgerDraft?.amount).toBe(12);
    expect(out.items[1]?.ledgerDraft?.amount).toBe(30);
  });

  it('「买了华为手机，花了3999」→ 1 个物品，价格 3999', () => {
    const out = parseLocalOnly('买了华为手机，花了3999', { categories: cats, today: '2026-10-07' });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.action).toBe('create_goods');
    expect(out.items[0]?.goodsDraft?.price).toBe(3999);
  });

  it('全角数字「早饭１２元」→ 金额 12', () => {
    const out = parseLocalOnly('早饭１２元', { categories: cats, today: '2026-10-07' });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.ledgerDraft?.amount).toBe(12);
  });
});
