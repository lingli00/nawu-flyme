import { describe, expect, it } from 'vitest';
import { matchGoods, normalizeForMatch, tokenizeForMatch } from '../src/lib/itemMatch';

/**
 * ★v1.3.7 需求 1 回归：物品匹配要能容忍语序（并且要看得见备注）。
 *
 * 用户反馈原句：
 *   物品库里已有「N95笔记本准系统 粉色」，
 *   但说「粉色的N95笔记本」「粉色笔记本N95」「N95笔记本粉色」都匹配不到，
 *   最后报「没找到匹配的物品，请先入库」。
 *
 * 旧实现 g.name.includes(key) || key.includes(g.name) 是严格子串，
 * 语序一变就废；而且只查 name，不看 note。
 */

const LIB = [
  { id: 'g1', name: 'N95笔记本准系统 粉色', note: '闲鱼下单，粉色，8G+256G', status: 'active' },
  { id: 'g2', name: '机械键盘 87键', note: '茶轴，粉色键帽', status: 'active' },
  { id: 'g3', name: 'N95 笔记本准系统 黑色', note: '', status: 'active' },
  { id: 'g4', name: '显示器 27寸', note: '2K 144Hz', status: 'retired' },
];

describe('itemMatch · 归一化与切词', () => {
  it('去标点、去虚词、转小写', () => {
    expect(normalizeForMatch('粉色的 N95 笔记本！')).toBe('粉色n95笔记本');
    expect(normalizeForMatch('  ')).toBe('');
  });

  it('中文切 2-gram，短词整串保留', () => {
    expect(tokenizeForMatch('笔记本')).toEqual(['笔记', '记本']);
    expect(tokenizeForMatch('灯')).toEqual(['灯']);
  });
});

describe('itemMatch · 乱序关键词命中', () => {
  it('语序打乱也能命中同一件物品', () => {
    for (const q of ['粉色的N95笔记本', 'N95笔记本粉色', '粉色笔记本N95', '笔记本 N95 粉色']) {
      const r = matchGoods(LIB, q);
      expect(r?.item.id, q).toBe('g1');
    }
  });

  it('多一个「的」不影响命中', () => {
    expect(matchGoods(LIB, '粉色的N95笔记本')?.item.id).toBe('g1');
    expect(matchGoods(LIB, '粉色N95笔记本')?.item.id).toBe('g1');
  });

  it('颜色不同就落到另一件，不串味', () => {
    expect(matchGoods(LIB, 'N95笔记本黑色')?.item.id).toBe('g3');
  });

  it('只在备注里出现的说法也能命中', () => {
    // 「茶轴」只在 g2 的备注里
    expect(matchGoods(LIB, '茶轴键盘')?.item.id).toBe('g2');
  });

  it('完全不相关的描述不硬凑（返回 null）', () => {
    expect(matchGoods(LIB, '一杯拿铁')).toBeNull();
    expect(matchGoods(LIB, '')).toBeNull();
  });

  it('在役优先：退役物品不会被优先选中', () => {
    const lib = [
      { id: 'a', name: 'N95笔记本准系统 粉色', status: 'retired' },
      { id: 'b', name: 'N95笔记本准系统 粉色', status: 'active' },
    ];
    expect(matchGoods(lib, '粉色N95笔记本')?.item.id).toBe('b');
  });

  it('给出命中片段，便于卡片提示', () => {
    const r = matchGoods(LIB, '粉色N95笔记本');
    expect(r?.hits.length).toBeGreaterThan(0);
    expect(r?.score).toBeGreaterThan(0.8);
  });
});
