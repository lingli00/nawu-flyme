/**
 * ★v1.2.0 本地自学习规则库（PRD：对话式智能记录入口改造 V1.0 · 四、规则学习机制）。
 *
 * **纯逻辑模块，不碰存储**（存储封装见 `api/learnedRules.ts`）。
 *
 * 设计要点（与 PRD 逐条对齐）：
 * 1. 规则单元 = **关键词簇 + 上下文共现词**，而非孤立词：
 *    `keyword` 包含命中，且 `coWords` 为空或任一共现词也在文本中出现，规则才生效。
 *    反例（旧逻辑）：见「N95」→ 口罩 → 生活流-医疗；
 *    正例（新逻辑）：「N95」+ 共现词{笔记本、准系统…} → 物品-数码。
 * 2. 用户每次在确认卡片上**手动修改分类**，即沉淀一条样本并提炼成规则，
 *    **追加融合**进既有规则库：不覆盖、不删除旧规则；冲突时以
 *    「用户人工纠正过的样本」为高优先级（匹配顺序在前），旧静态规则降级为备选
 *    （静态表匹配在 `localParser.matchCategoryId` 里始终位于学习规则之后）。
 * 3. 样本与规则**只存本机不上云**（PRD 六.3）。
 */

import type { CategoryKind } from '../types/entities';

/** 学到的一条规则。 */
export interface LearnedRule {
  id: string;
  /** 主关键词（小写，包含匹配；取自样本名称里最「像型号」的词元）。 */
  keyword: string;
  /** 上下文共现词（小写）；为空表示该关键词单独出现也生效。 */
  coWords: string[];
  /** 目标大类。 */
  kind: CategoryKind;
  /** 目标小类（分类名，如「数码」）。 */
  categoryName: string;
  /** 累计命中次数（规则管理页展示用）。 */
  hits: number;
  /** 来源样本原文（便于排查「这条规则哪来的」）。 */
  from: string;
  /** ISO 时间。 */
  createdAt: string;
}

/** 学习样本：一次人工纠正的原始记录。 */
export interface LearnSample {
  id: string;
  /** 对应规则 id。 */
  ruleId: string;
  /** 用户原始输入。 */
  text: string;
  /** 用户最终确认的大类。 */
  kind: CategoryKind;
  /** 用户最终确认的小类（分类名）。 */
  categoryName: string;
  /** ISO 时间。 */
  createdAt: string;
}

/** 大类 → 展示名（与确认卡片一致）。 */
export const KIND_LABEL: Record<CategoryKind, string> = {
  goods: '物品',
  sub: '订阅',
  ledger: '生活流',
};

/**
 * 把名称切成候选词元：英文/数字串（N95、RTX4090、iPhone15）与中文连续段。
 * 中文连续段不再细分——共现词由 {@link buildCoWords} 补二元组解决。
 */
export function tokenizeName(name: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z0-9][A-Za-z0-9+#.\-]*|[一-龥]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) !== null) out.push(m[0]);
  return out;
}

/** 词元是否「有信息量」：长度 ≥2 且至少含一个中文或字母（排除纯数字如 '95'）。 */
function isMeaningfulToken(t: string): boolean {
  return t.length >= 2 && /[一-龥A-Za-z]/.test(t);
}

/**
 * 从样本名称提炼「关键词簇」。
 *
 * - keyword：优先取含字母/数字的词元（型号感最强，如 N95 / RTX4090 / iPhone15），
 *   否则取最长词元；
 * - coWords：其余词元；中文连续段额外展开 2 字组（「准系统笔记本」→ 统…笔记/电脑），
 *   保证「N95 笔记本」这样的短说法也能共现命中。
 */
export function extractKeywordCluster(name: string): { keyword: string; coWords: string[] } {
  const tokens = tokenizeName(name).filter(isMeaningfulToken);
  if (tokens.length === 0) return { keyword: '', coWords: [] };
  const modelLike = tokens.find((t) => /[A-Za-z0-9]/.test(t));
  const keyword = (modelLike ?? tokens.slice().sort((a, b) => b.length - a.length)[0] ?? '').toLowerCase();
  const rest = tokens.filter((t) => t.toLowerCase() !== keyword);
  const coWords: string[] = [];
  for (const t of rest) {
    const lower = t.toLowerCase();
    coWords.push(lower);
    // 中文段展开 2 字组（长度 ≥3 才有意义；2 字段自身即共现词）
    if (/^[一-龥]+$/.test(t) && t.length >= 3) {
      for (let i = 0; i + 2 <= t.length; i += 1) coWords.push(t.slice(i, i + 2).toLowerCase());
    }
  }
  return { keyword, coWords: [...new Set(coWords)] };
}

/**
 * 学习规则命中：`keyword` 包含命中 且（`coWords` 为空 或 任一共现词共现）。
 *
 * @param rules 已按优先级排好序的规则（新的/常用在前）
 * @returns 第一条命中的规则；没有命中返回 null
 */
export function matchLearnedRule(text: string, rules: readonly LearnedRule[] | null | undefined): LearnedRule | null {
  if (!rules || rules.length === 0 || !text) return null;
  const lower = text.toLowerCase();
  for (const rule of rules) {
    if (!rule.keyword || !lower.includes(rule.keyword)) continue;
    if (rule.coWords.length === 0) return rule;
    if (rule.coWords.some((w) => w && lower.includes(w))) return rule;
  }
  return null;
}

/** 分类是否被改动（学习触发条件，PRD 3.3：仅改金额/名称/时间/备注**不触发**）。 */
export function classificationChanged(
  before: { kind: CategoryKind; categoryId: string },
  after: { kind: CategoryKind; categoryId: string },
): boolean {
  return before.kind !== after.kind || before.categoryId !== after.categoryId;
}

/** 共现词展示用：去掉被更长共现词包含的短词（二元组噪音），控制数量。 */
export function displayCoWords(coWords: readonly string[], limit = 6): string[] {
  const kept = coWords.filter((w) => !coWords.some((o) => o !== w && o.length > w.length && o.includes(w)));
  return kept.slice(0, limit);
}

/** 生成规则 id（`lr_` 前缀，便于与业务 id 区分）。 */
function newRuleId(): string {
  return `lr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface CorrectionInput {
  /** 样本名称（物品/订阅名，或生活流 note 已剥离餐次前缀）。 */
  name: string;
  /** 用户确认的大类。 */
  kind: CategoryKind;
  /** 用户确认的小类（分类名）。 */
  categoryName: string;
  /** 原始输入原文。 */
  from: string;
  /** 既有规则库（用于融合去重）。 */
  existing?: readonly LearnedRule[];
  /** ISO 时间（测试可注入）。 */
  now?: string;
}

export interface CorrectionResult {
  rule: LearnedRule;
  sample: LearnSample;
  /** 融合后的完整规则库（调用方直接落盘）。 */
  rules: LearnedRule[];
  /** true = 合并进了已存在的同义规则（没产生新规则）。 */
  merged: boolean;
}

/**
 * 从一次人工纠正生成规则并融合进既有规则库（PRD 四.1 新旧规则融合）。
 *
 * 融合规则：
 * - 同 `keyword + kind + categoryName` → 合并共现词（并集），不新增规则；
 * - 同 `keyword + kind` 但分类不同 → 两条都保留，**新纠正的排前面**（高优先级）；
 * - 绝不覆盖/删除旧规则，旧静态表规则更是只读备选（见 localParser 匹配顺序）。
 *
 * @returns 名称过于空泛（如纯数字）时返回 null，不学。
 */
export function buildCorrection(input: CorrectionInput): CorrectionResult | null {
  const name = (input.name ?? '').trim();
  const categoryName = (input.categoryName ?? '').trim();
  if (!name || !categoryName) return null;
  const { keyword, coWords } = extractKeywordCluster(name);
  if (!keyword) return null;

  const now = input.now ?? new Date().toISOString();
  const existing = input.existing ?? [];
  const sameIntent = existing.find(
    (r) => r.keyword === keyword && r.kind === input.kind && r.categoryName === categoryName,
  );
  const sampleId = `ls_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  if (sameIntent) {
    // 同义规则：并集共现词，样本追加，规则保持原 id/创建时间（排位不变）
    const rule: LearnedRule = {
      ...sameIntent,
      coWords: [...new Set([...sameIntent.coWords, ...coWords])],
      from: input.from,
    };
    const sample: LearnSample = {
      id: sampleId,
      ruleId: rule.id,
      text: input.from,
      kind: input.kind,
      categoryName,
      createdAt: now,
    };
    return { rule, sample, rules: [rule, ...existing.filter((r) => r.id !== rule.id)], merged: true };
  }

  const rule: LearnedRule = {
    id: newRuleId(),
    keyword,
    coWords,
    kind: input.kind,
    categoryName,
    hits: 0,
    from: input.from,
    createdAt: now,
  };
  const sample: LearnSample = {
    id: sampleId,
    ruleId: rule.id,
    text: input.from,
    kind: input.kind,
    categoryName,
    createdAt: now,
  };
  // 新规则插到最前：匹配时优先于旧学习规则（用户最近的纠正意图最强）
  return { rule, sample, rules: [rule, ...existing], merged: false };
}

/** 删除一条规则（连同其样本），返回剩余规则。 */
export function withoutRule(rules: readonly LearnedRule[], ruleId: string): LearnedRule[] {
  return rules.filter((r) => r.id !== ruleId);
}

/** 删除一条规则对应的全部样本。 */
export function withoutSamples(samples: readonly LearnSample[], ruleId: string): LearnSample[] {
  return samples.filter((s) => s.ruleId !== ruleId);
}
