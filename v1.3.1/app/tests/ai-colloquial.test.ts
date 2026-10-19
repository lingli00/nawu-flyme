import { describe, expect, it } from 'vitest';
import { cleanNameText, detailsNote, extractOralDetails } from '../src/ai/colloquial';
import { parseLocal } from '../src/ai/localParser';
import { SEED_CATEGORIES } from '../src/storage/seed';

/* v1.2.1 口头语细节：地点/数量进备注，名称干净（用户反馈 3）。 */

describe('extractOralDetails', () => {
  it('线上平台 + 数量', () => {
    expect(extractOralDetails('我今天在淘宝花了29块钱买了30斤大米。')).toEqual({ place: '淘宝', qty: '30斤' });
    expect(extractOralDetails('在京东买了3盒牛奶')).toEqual({ place: '京东', qty: '3盒' });
    expect(extractOralDetails('拼多多买了包辣条')).toEqual({ place: '拼多多' });
  });

  it('中文数量（三盒 → 3盒）', () => {
    expect(extractOralDetails('买了三盒牛奶')).toEqual({ qty: '3盒' });
  });

  it('未知店名（在XX店/超市）', () => {
    expect(extractOralDetails('在楼下超市买了瓶水').place).toBe('楼下超市');
    expect(extractOralDetails('在永辉超市买了菜').place).toBe('永辉超市');
  });

  it('普通句子没有细节', () => {
    expect(extractOralDetails('刚买了个N95准系统笔记本 花了899')).toEqual({});
    expect(extractOralDetails('午饭25')).toEqual({});
    expect(extractOralDetails('抽纸花了0.01元。')).toEqual({});
  });
});

describe('cleanNameText', () => {
  it('用户原句：名称只留商品名', () => {
    expect(cleanNameText('我今天在淘宝花了29块钱买了30斤大米。')).toBe('大米');
    expect(cleanNameText('在京东买了3盒牛奶')).toBe('牛奶');
    expect(cleanNameText('早上吃了碗牛肉面25', '25')).toBe('牛肉面');
  });

  it('不误伤原有用例', () => {
    expect(cleanNameText('刚买了个N95准系统笔记本 花了899', '899')).toBe('N95准系统笔记本');
    expect(cleanNameText('抽纸花了0.01元。', '0.01元')).toBe('抽纸');
    expect(cleanNameText('买了包蓝利群花了39', '39')).toBe('蓝利群');
    expect(cleanNameText('午饭25', '25')).toBe('午饭');
    expect(cleanNameText('买了双跑鞋')).toBe('跑鞋');
    expect(cleanNameText('打车30', '30')).toBe('打车');
  });
});

describe('detailsNote', () => {
  it('有细节 → 细节前缀 + 原文', () => {
    expect(detailsNote('我今天在淘宝花了29块钱买了30斤大米。', { place: '淘宝', qty: '30斤' })).toBe(
      '淘宝 · 30斤｜我今天在淘宝花了29块钱买了30斤大米。',
    );
  });
  it('无细节 → 原文', () => {
    expect(detailsNote('午饭25', {})).toBe('午饭25');
  });
});

describe('parseLocal 口头语端到端', () => {
  it('「我今天在淘宝花了29块钱买了30斤大米。」→ 生活流，名称大米，备注带细节', () => {
    const item = parseLocal('我今天在淘宝花了29块钱买了30斤大米。', SEED_CATEGORIES, { today: '2026-10-19' });
    expect(item.action).toBe('create_ledger');
    expect(item.ledgerDraft?.amount).toBe(29);
    expect(item.ledgerDraft?.name).toBe('大米');
    expect(item.ledgerDraft?.note).toContain('淘宝');
    expect(item.ledgerDraft?.note).toContain('30斤');
  });

  it('「在京东买了3盒牛奶花了60」→ 生活流（消耗品），名称牛奶', () => {
    const item = parseLocal('在京东买了3盒牛奶花了60', SEED_CATEGORIES, { today: '2026-10-19' });
    expect(item.action).toBe('create_ledger');
    expect(item.ledgerDraft?.name).toBe('牛奶');
    expect(item.ledgerDraft?.amount).toBe(60);
  });

  it('N95 场景不被细节逻辑破坏', () => {
    const item = parseLocal('刚买了个N95准系统笔记本 花了899', SEED_CATEGORIES, { today: '2026-10-19' });
    expect(item.action).toBe('create_goods');
    expect(item.goodsDraft?.name).toBe('N95准系统笔记本');
    expect(item.goodsDraft?.price).toBe(899);
  });

  it('耐用品 + 无斤两单位仍是物品（苹果品牌）', () => {
    const item = parseLocal('买了苹果15', SEED_CATEGORIES, { today: '2026-10-19' });
    expect(item.action).toBe('create_goods');
  });

  it('水果（带斤）归生活流', () => {
    const item = parseLocal('买了5斤苹果花了30', SEED_CATEGORIES, { today: '2026-10-19' });
    expect(item.action).toBe('create_ledger');
    expect(item.ledgerDraft?.name).toBe('苹果');
  });
});
