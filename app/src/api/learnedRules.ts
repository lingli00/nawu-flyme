import { enqueueWrite, getKV, setKV } from '../storage/kv';
import { K_LEARNED_RULES, K_LEARN_SAMPLES } from '../storage/keys';
import {
  buildCorrection,
  withoutRule,
  withoutSamples,
  type LearnSample,
  type LearnedRule,
} from '../ai/ruleBank';
import type { CategoryKind } from '../types/entities';

/**
 * ★v1.2.0 本地自学习规则的存储层（PRD：对话式智能记录入口改造）。
 *
 * - 存本机 KV（`flyme.parse.learned` / `flyme.parse.samples`），**不上云**；
 * - 纯规则匹配/提炼逻辑在 `ai/ruleBank.ts`，本文件只负责读写与内存缓存；
 * - 写一律走 `enqueueWrite` 串行链（kv.ts 铁律：Android Preferences 并发写会丢）。
 */

/** 样本条数上限（防 localStorage 无限增长，超出丢最旧的）。 */
const SAMPLE_CAP = 200;

let ruleCache: LearnedRule[] | null = null;
let sampleCache: LearnSample[] | null = null;

/** 防御式归一：KV 数据可能被手改坏，逐条挑字段。 */
function normalizeRules(raw: unknown): LearnedRule[] {
  if (!Array.isArray(raw)) return [];
  const out: LearnedRule[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    const keyword = typeof r.keyword === 'string' ? r.keyword.trim().toLowerCase() : '';
    const kind = r.kind;
    const categoryName = typeof r.categoryName === 'string' ? r.categoryName.trim() : '';
    if (!keyword || !categoryName) continue;
    if (kind !== 'goods' && kind !== 'sub' && kind !== 'ledger') continue;
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : `lr_${keyword}`,
      keyword,
      coWords: Array.isArray(r.coWords) ? r.coWords.filter((w): w is string => typeof w === 'string' && w.length > 0) : [],
      kind,
      categoryName,
      hits: typeof r.hits === 'number' && Number.isFinite(r.hits) ? r.hits : 0,
      from: typeof r.from === 'string' ? r.from : '',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    });
  }
  return out;
}

function normalizeSamples(raw: unknown): LearnSample[] {
  if (!Array.isArray(raw)) return [];
  const out: LearnSample[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const s = it as Record<string, unknown>;
    const kind = s.kind;
    if (kind !== 'goods' && kind !== 'sub' && kind !== 'ledger') continue;
    out.push({
      id: typeof s.id === 'string' && s.id ? s.id : `ls_${out.length}`,
      ruleId: typeof s.ruleId === 'string' ? s.ruleId : '',
      text: typeof s.text === 'string' ? s.text : '',
      kind,
      categoryName: typeof s.categoryName === 'string' ? s.categoryName : '',
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : '',
    });
  }
  return out;
}

/** 读取学习规则（带内存缓存；写操作会失效缓存）。 */
export async function loadLearnedRules(): Promise<LearnedRule[]> {
  if (ruleCache) return ruleCache;
  ruleCache = normalizeRules(await getKV<unknown>(K_LEARNED_RULES, []));
  return ruleCache;
}

/** 读取学习样本。 */
export async function loadLearnSamples(): Promise<LearnSample[]> {
  if (sampleCache) return sampleCache;
  sampleCache = normalizeSamples(await getKV<unknown>(K_LEARN_SAMPLES, []));
  return sampleCache;
}

/** 覆盖写规则库（供「清空 / 导入」类操作；一般业务走 recordCorrection）。 */
export async function saveLearnedRules(rules: LearnedRule[]): Promise<void> {
  await enqueueWrite(() => setKV(K_LEARNED_RULES, rules));
  ruleCache = rules;
}

/**
 * ★v1.3.3 整库替换（云端拉回来的规则合并后写回本机）。
 * 与 saveLearnedRules 的区别只在语义：这里用于「合并同步」，不做增量融合。
 */
export async function replaceLearnedRules(rules: LearnedRule[]): Promise<void> {
  await saveLearnedRules(rules);
}

/** 覆盖写样本库。 */
export async function saveLearnSamples(samples: LearnSample[]): Promise<void> {
  await enqueueWrite(() => setKV(K_LEARN_SAMPLES, samples));
  sampleCache = samples;
}

export interface CorrectionOutcome {
  rule: LearnedRule;
  sample: LearnSample;
  merged: boolean;
}

/**
 * 记录一次人工纠正（PRD 3.2 模式B：用户改分类即学习）。
 *
 * 流程：读既有库 → 提炼规则并融合 → 落盘 → 返回学到的规则（供 UI 提示）。
 * 名称过于空泛（纯数字 / 空）时返回 null，不学。
 */
export async function recordCorrection(input: {
  text: string;
  name: string;
  kind: CategoryKind;
  categoryName: string;
}): Promise<CorrectionOutcome | null> {
  const existing = await loadLearnedRules();
  const built = buildCorrection({
    name: input.name,
    kind: input.kind,
    categoryName: input.categoryName,
    from: input.text,
    existing,
  });
  if (!built) return null;
  await saveLearnedRules(built.rules);
  const samples = await loadLearnSamples();
  await saveLearnSamples([built.sample, ...samples].slice(0, SAMPLE_CAP));
  return { rule: built.rule, sample: built.sample, merged: built.merged };
}

/** 删除一条规则（连同样本；规则管理页「学错了回退」用）。 */
export async function removeLearnedRule(ruleId: string): Promise<void> {
  const rules = withoutRule(await loadLearnedRules(), ruleId);
  const samples = withoutSamples(await loadLearnSamples(), ruleId);
  await saveLearnedRules(rules);
  await saveLearnSamples(samples);
}

/** 命中计数 +1（解析时规则真的被用上了才记；失败静默，不影响主流程）。 */
export async function bumpRuleHits(ruleId: string): Promise<void> {
  try {
    const rules = await loadLearnedRules();
    const i = rules.findIndex((r) => r.id === ruleId);
    if (i < 0) return;
    const next = rules.slice();
    next[i] = { ...next[i] as LearnedRule, hits: (next[i] as LearnedRule).hits + 1 };
    await saveLearnedRules(next);
  } catch {
    /* 计数失败不影响记账 */
  }
}

/** 测试用：清空内存缓存。 */
export function resetLearnedCache(): void {
  ruleCache = null;
  sampleCache = null;
}
