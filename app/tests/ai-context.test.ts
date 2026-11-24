import { describe, expect, it } from 'vitest';
import { parseLocal } from '../src/ai/localParser';
import { parseLocalOnly, applyLearnedRules } from '../src/ai/parseService';
import { resolveAmbiguous } from '../src/ai/localParser';
import { buildCorrection, type LearnedRule } from '../src/ai/ruleBank';
import { SEED_CATEGORIES } from '../src/storage/seed';
import type { AiResultItem } from '../src/types/ai';

/**
 * ★v1.2.0 上下文感知分类 + 学习规则接入（PRD 一/四）。
 *
 * 核心回归案例（PRD 原文）：
 *   用户输入「N95 笔记本准系统」（数码硬件消费）——
 *   旧规则只命中「N95」→ 误判 N95 口罩 → 生活流-医疗；
 *   新规则靠上下文共现词归 物品-数码。
 */

const cats = SEED_CATEGORIES;
const TODAY = '2026-10-19';

/** 学一条规则：文本 → 大类/小类（模拟用户在确认卡片上改分类）。 */
function learn(text: string, name: string, kind: 'goods' | 'sub' | 'ledger', categoryName: string): LearnedRule[] {
  const built = buildCorrection({ name, kind, categoryName, from: text, now: '2026-10-19T09:00:00.000Z' });
  expect(built).not.toBeNull();
  return built!.rules;
}

describe('歧义词簇消歧（PRD 四.2：上下文感知，而非孤立关键词）', () => {
  it('「N95 + 笔记本/准系统」→ 物品-数码', () => {
    expect(resolveAmbiguous('刚买了个N95笔记本准系统 花了899')).toEqual({ kind: 'goods', name: '数码' });
    expect(resolveAmbiguous('N95迷你主机')).toEqual({ kind: 'goods', name: '数码' });
  });

  it('「N95 + 口罩/防疫」→ 生活流-健康', () => {
    expect(resolveAmbiguous('买了N95口罩花了50')).toEqual({ kind: 'ledger', name: '健康' });
    expect(resolveAmbiguous('KN95防护口罩一盒')).toEqual({ kind: 'ledger', name: '健康' });
  });

  it('「N95」没有任何上下文 → 不猜（返回 null，交给确认卡片兜底）', () => {
    expect(resolveAmbiguous('买了N95')).toBeNull();
  });
});

describe('parseLocal · 上下文感知（不带学习规则的静态路径）', () => {
  it('「刚买了个N95准系统笔记本 花了899」→ 物品-数码（不再误判医疗）', () => {
    const it0 = parseLocal('刚买了个N95准系统笔记本 花了899', cats, { today: TODAY });
    expect(it0.action).toBe('create_goods');
    expect(it0.goodsDraft?.price).toBe(899);
    expect(it0.goodsDraft?.name).toContain('N95');
    expect(it0.goodsDraft?.categoryId).toBe('cg0'); // 数码
  });

  it('「买了N95口罩花了50」→ 生活流-健康（消耗品不入物品库）', () => {
    const it0 = parseLocal('买了N95口罩花了50', cats, { today: TODAY });
    expect(it0.action).toBe('create_ledger');
    expect(it0.ledgerDraft?.categoryId).toBe('cl4'); // 健康
    expect(it0.ledgerDraft?.amount).toBe(50);
  });

  it('来源原文记在 rawText 上（学习样本溯源用）', () => {
    const it0 = parseLocal('买了N95口罩花了50', cats, { today: TODAY });
    expect(it0.rawText).toBe('买了N95口罩花了50');
  });
});

describe('parseLocal · 学习规则优先（PRD：纠正样本 > 旧静态规则）', () => {
  it('纠正过一次后，相似输入直接归对（物品-数码）', () => {
    // 用户把「N95准系统笔记本」从生活流-其他 改成了 物品-数码
    const rules = learn('刚买了个N95准系统笔记本 花了899', 'N95准系统笔记本', 'goods', '数码');
    const it0 = parseLocal('又入手一个N95准系统 花了2100', cats, { today: TODAY, learned: rules });
    expect(it0.action).toBe('create_goods');
    expect(it0.goodsDraft?.categoryId).toBe('cg0');
  });

  it('学习规则不改写动作语义：卖了 / 开通 / 情绪 仍按原动作走', () => {
    const rules = learn('刚买了个N95准系统笔记本 花了899', 'N95准系统笔记本', 'goods', '数码');
    expect(parseLocal('把N95笔记本卖了800', cats, { today: TODAY, learned: rules }).action).toBe('retire_sell');
    expect(parseLocal('N95视频会员', cats, { today: TODAY, learned: rules }).action).toBe('create_subscription');
  });

  it('学习规则指定订阅：句中没有订阅词也按订阅建', () => {
    const rules = learn('坚果云Pro年费', '坚果云Pro', 'sub', '云服务');
    const it0 = parseLocal('坚果云Pro 260', cats, { today: TODAY, learned: rules });
    expect(it0.action).toBe('create_subscription');
    expect(it0.subDraft?.categoryId).toBe('cs3'); // 云服务
    expect(it0.subDraft?.amount).toBe(260);
  });

  it('学习规则指定生活流：把「耐用品词」的输入按生活流记', () => {
    // 用户口径：这台「笔记本」是耗材（比如维修件），手动归了生活流-维修
    const rules = learn('买了点笔记本维修件花了300', '笔记本维修件', 'ledger', '维修');
    const it0 = parseLocal('又买了点笔记本维修件 150', cats, { today: TODAY, learned: rules });
    expect(it0.action).toBe('create_ledger');
    expect(it0.ledgerDraft?.categoryId).toBe('cl23'); // 维修
  });

  it('共现词缺席时学习规则不生效，回落静态规则', () => {
    const rules = learn('刚买了个N95准系统笔记本 花了899', 'N95准系统笔记本', 'goods', '数码');
    // 「N95口罩」共现词对不上 → 不被数码规则抢走 → 静态表归 健康
    const it0 = parseLocal('买了N95口罩花了50', cats, { today: TODAY, learned: rules });
    expect(it0.action).toBe('create_ledger');
    expect(it0.ledgerDraft?.categoryId).toBe('cl4');
  });

  it('parseLocalOnly 透传学习规则', () => {
    const rules = learn('刚买了个N95准系统笔记本 花了899', 'N95准系统笔记本', 'goods', '数码');
    const out = parseLocalOnly('又入手一个N95准系统 花了2100', { categories: cats, today: TODAY, learned: rules });
    expect(out.items[0]?.action).toBe('create_goods');
  });
});

describe('applyLearnedRules · AI 路径同样受学习规则约束', () => {
  const aiItems: AiResultItem[] = [
    {
      action: 'create_ledger',
      ledgerDraft: { type: 'expense', amount: 899, categoryId: 'cl7', judgement: 'xu', date: TODAY, note: 'N95准系统笔记本' },
      explanation: 'AI 解析：生活流',
      source: 'ai',
    },
  ];

  it('条数与分句一致 → 按学习规则改写大类与小类', () => {
    const rules = learn('刚买了个N95准系统笔记本 花了899', 'N95准系统笔记本', 'goods', '数码');
    const out = applyLearnedRules(aiItems, ['刚买了个N95准系统笔记本 花了899'], rules, cats, TODAY);
    expect(out[0]?.action).toBe('create_goods');
    expect(out[0]?.goodsDraft?.categoryId).toBe('cg0');
    expect(out[0]?.goodsDraft?.price).toBe(899); // 金额/名称不丢
  });

  it('条数与分句不一致（多句合并）→ 不猜，原样返回', () => {
    const rules = learn('刚买了个N95准系统笔记本 花了899', 'N95准系统笔记本', 'goods', '数码');
    const out = applyLearnedRules(aiItems, ['a', 'b'], rules, cats, TODAY);
    expect(out[0]?.action).toBe('create_ledger');
  });

  it('情绪/时间等无分类动作不参与覆盖', () => {
    const rules = learn('今天很开心', '今天很开心', 'ledger', '娱乐');
    const mood: AiResultItem[] = [
      { action: 'create_mood', moodDraft: { feeling: '😄', text: '今天很开心' }, source: 'ai' },
    ];
    const out = applyLearnedRules(mood, ['今天很开心'], rules, cats, TODAY);
    expect(out[0]?.action).toBe('create_mood');
  });
});
