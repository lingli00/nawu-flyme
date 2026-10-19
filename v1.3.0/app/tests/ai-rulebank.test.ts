import { describe, expect, it } from 'vitest';
import {
  buildCorrection,
  classificationChanged,
  displayCoWords,
  extractKeywordCluster,
  matchLearnedRule,
  withoutRule,
  withoutSamples,
  type LearnedRule,
} from '../src/ai/ruleBank';
import {
  loadLearnedRules,
  loadLearnSamples,
  recordCorrection,
  removeLearnedRule,
  resetLearnedCache,
} from '../src/api/learnedRules';

/**
 * ★v1.2.0 自学习规则库（PRD：对话式智能记录入口改造 · 四、规则学习机制）。
 * 覆盖：关键词簇提炼、共现词匹配语义、纠正样本融合、删除回退、存储往返。
 */

function rule(partial: Partial<LearnedRule> & { keyword: string }): LearnedRule {
  return {
    id: partial.id ?? `lr_${partial.keyword}`,
    keyword: partial.keyword,
    coWords: partial.coWords ?? [],
    kind: partial.kind ?? 'goods',
    categoryName: partial.categoryName ?? '数码',
    hits: partial.hits ?? 0,
    from: partial.from ?? '',
    createdAt: partial.createdAt ?? '2026-10-19T09:00:00.000Z',
  };
}

describe('ruleBank · 关键词簇提炼', () => {
  it('「N95准系统笔记本」→ keyword=n95，共现词含中文段与其 2 字组', () => {
    const { keyword, coWords } = extractKeywordCluster('N95准系统笔记本');
    expect(keyword).toBe('n95');
    expect(coWords).toContain('准系统笔记本');
    expect(coWords).toContain('笔记');
    expect(coWords).toContain('记本');
  });

  it('优先取「像型号」的词元作 keyword：RTX4090 显卡', () => {
    const { keyword, coWords } = extractKeywordCluster('RTX4090显卡');
    expect(keyword).toBe('rtx4090');
    expect(coWords).toContain('显卡');
  });

  it('纯数字名称学不到规则（「95」这类空泛词元被拒绝）', () => {
    expect(extractKeywordCluster('95').keyword).toBe('');
  });

  it('displayCoWords 去掉被更长词包含的 2 字组噪音', () => {
    const shown = displayCoWords(['准系统笔记本', '准系', '系统', '统笔', '笔记', '记本']);
    expect(shown).toEqual(['准系统笔记本']);
    // 独立的短词元（如「显卡」）不是任何长词的子串，保留
    expect(displayCoWords(['准系统笔记本', '准系', '显卡'])).toEqual(['准系统笔记本', '显卡']);
  });
});

describe('ruleBank · 匹配语义（关键词簇 + 上下文共现词）', () => {
  const rules = [
    rule({ id: 'lr1', keyword: 'n95', coWords: ['准系统笔记本', '笔记', '电脑'], kind: 'goods', categoryName: '数码' }),
  ];

  it('关键词 + 任一共现词命中 → 生效', () => {
    expect(matchLearnedRule('刚买了个N95笔记本准系统 花了899', rules)?.id).toBe('lr1');
    expect(matchLearnedRule('N95 迷你电脑主机', rules)?.id).toBe('lr1');
  });

  it('关键词命中但共现词缺席 → 不生效（N95 口罩不被数码规则抢走）', () => {
    expect(matchLearnedRule('买了N95口罩花了50', rules)).toBeNull();
    expect(matchLearnedRule('N95', rules)).toBeNull();
  });

  it('共现词为空的关键词单独出现也生效（用户明确纠正过）', () => {
    const bare = [rule({ id: 'lr2', keyword: '纸巾', coWords: [], kind: 'ledger', categoryName: '日用' })];
    expect(matchLearnedRule('买了包纸巾', bare)?.categoryName).toBe('日用');
  });

  it('分类改动判定：只有大类/小类变了才算（PRD 3.3）', () => {
    expect(classificationChanged({ kind: 'goods', categoryId: 'cg0' }, { kind: 'goods', categoryId: 'cg0' })).toBe(false);
    expect(classificationChanged({ kind: 'goods', categoryId: 'cg0' }, { kind: 'goods', categoryId: 'cg1' })).toBe(true);
    expect(classificationChanged({ kind: 'ledger', categoryId: 'cl7' }, { kind: 'goods', categoryId: 'cg0' })).toBe(true);
  });
});

describe('ruleBank · 纠正样本融合（PRD 四.1）', () => {
  it('同义纠正 → 合并共现词，不新增规则', () => {
    const first = buildCorrection({
      name: 'N95准系统笔记本',
      kind: 'goods',
      categoryName: '数码',
      from: '刚买了个N95准系统笔记本 花了899',
      now: '2026-10-19T09:00:00.000Z',
    });
    expect(first).not.toBeNull();
    const second = buildCorrection({
      name: 'N95笔记本',
      kind: 'goods',
      categoryName: '数码',
      from: '又买了台N95笔记本',
      existing: first!.rules,
      now: '2026-10-19T10:00:00.000Z',
    });
    expect(second?.merged).toBe(true);
    expect(second?.rules).toHaveLength(1);
    // 两次样本的共现词并集：「准系统笔记本」段 + 「笔记本」段
    expect(second?.rule.coWords).toContain('准系统笔记本');
    expect(second?.rule.coWords).toContain('笔记本');
  });

  it('同关键词不同分类 → 两条规则并存，新纠正的排前面（高优先级）', () => {
    const first = buildCorrection({
      name: 'N95笔记本',
      kind: 'goods',
      categoryName: '数码',
      from: 'N95笔记本 899',
      now: '2026-10-19T09:00:00.000Z',
    })!;
    const second = buildCorrection({
      name: 'N95口罩',
      kind: 'ledger',
      categoryName: '健康',
      from: '买了N95口罩',
      existing: first.rules,
      now: '2026-10-19T10:00:00.000Z',
    })!;
    expect(second.rules).toHaveLength(2);
    expect(second.rules[0]?.kind).toBe('ledger'); // 最新的纠正意图最强
    // 旧规则没被覆盖，仍作为备选存在
    expect(second.rules[1]?.kind).toBe('goods');
    expect(matchLearnedRule('买了N95口罩', second.rules)?.kind).toBe('ledger');
    expect(matchLearnedRule('买了N95笔记本准系统', second.rules)?.kind).toBe('goods');
  });

  it('空泛名称（纯数字）→ 不学', () => {
    expect(buildCorrection({ name: '95', kind: 'goods', categoryName: '数码', from: 'x' })).toBeNull();
    expect(buildCorrection({ name: '  ', kind: 'goods', categoryName: '数码', from: 'x' })).toBeNull();
  });

  it('删除规则连同样本一起走（withoutRule / withoutSamples）', () => {
    const rules = [rule({ id: 'a', keyword: 'a' }), rule({ id: 'b', keyword: 'b' })];
    expect(withoutRule(rules, 'a').map((r) => r.id)).toEqual(['b']);
    const samples = [
      { id: 's1', ruleId: 'a', text: 'x', kind: 'goods' as const, categoryName: '数码', createdAt: '' },
      { id: 's2', ruleId: 'b', text: 'y', kind: 'goods' as const, categoryName: '数码', createdAt: '' },
    ];
    expect(withoutSamples(samples, 'a').map((s) => s.id)).toEqual(['s2']);
  });
});

describe('api/learnedRules · 存储往返（本机 KV，不上云）', () => {
  it('纠正 → 落盘 → 重读 → 命中 → 删除 → 空库', async () => {
    resetLearnedCache();
    const out = await recordCorrection({
      text: '刚买了个N95准系统笔记本 花了899',
      name: 'N95准系统笔记本',
      kind: 'goods',
      categoryName: '数码',
    });
    expect(out).not.toBeNull();
    expect(out?.rule.keyword).toBe('n95');

    // 重新读取（不走缓存路径也验一下 KV 真写了）
    resetLearnedCache();
    const rules = await loadLearnedRules();
    expect(rules).toHaveLength(1);
    expect(matchLearnedRule('又买了台N95笔记本', rules)?.categoryName).toBe('数码');

    const samples = await loadLearnSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.text).toContain('N95');

    await removeLearnedRule(out!.rule.id);
    resetLearnedCache();
    expect(await loadLearnedRules()).toHaveLength(0);
    expect(await loadLearnSamples()).toHaveLength(0);
  });
});
