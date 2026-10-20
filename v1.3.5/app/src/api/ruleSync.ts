import { getRules, saveRules } from './user';
import { currentServer, useAuthStore } from '../store';
import { loadLearnedRules, replaceLearnedRules } from './learnedRules';
import type { LearnedRule } from '../ai/ruleBank';
import type { ServerConfig } from '../types/entities';
import logger from '../lib/log';

/**
 * ★v1.3.3 · 识别规则云端同步（「教 AI 识账」统一走账号）。
 *
 * 背景：v1.2.0 把「对话里改分类学到的东西」存成本机规则（`flyme.parse.learned`），
 * 只在本机生效——换手机、换浏览器就全没了，用户以为规则「白学了」。
 * v1.3.3 起：
 * - 学到新规则 → 自动并入云端账号（`/api/user/rules`）；
 * - 登录/打开规则页 → 把云端学到的规则拉回本机，让解析立刻用上；
 * - 手动新增的规则仍是同一个 payload 里的 `manual` 段（网页版/APP 互通）。
 *
 * payload 形状（**v2 信封**，同时兼容旧数组）：
 *   { v: 2, manual: ParseRule[], learned: LearnedRule[] }
 * 旧版直接存 `ParseRule[]`，读取时按数组处理，写回时自动升级成信封。
 */

/** 信封结构（云端 payload）。 */
export interface RuleEnvelope {
  v: 2;
  manual: unknown[];
  learned: LearnedRule[];
}

/** 兼容读取：旧数组 → 只有 manual；新信封 → 两段都在。 */
export function parseEnvelope(raw: unknown): RuleEnvelope {
  if (Array.isArray(raw)) return { v: 2, manual: raw, learned: [] };
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const manual = Array.isArray(o.manual) ? o.manual : Array.isArray(o.rules) ? o.rules : [];
    const learned = Array.isArray(o.learned) ? (o.learned as LearnedRule[]) : [];
    return { v: 2, manual, learned };
  }
  return { v: 2, manual: [], learned: [] };
}

/** 当前是否具备云同步条件（登录 + 有服务器）。 */
function cloudReady(): ServerConfig | null {
  const st = useAuthStore.getState();
  if (st.sessionState !== 'valid' || !st.session?.token) return null;
  return currentServer();
}

/**
 * ★v1.3.3 上云前脱敏：`from` 是「来源样本原文」（用户当时说的那句完整的话），
 * 属于对话内容 —— 按需求「对话产生的数据只留在本机」，这里一律剥成空串，
 * 只把规则本身（关键词簇 + 目标分类）同步出去。
 */
export function sanitizeForCloud(rules: LearnedRule[]): LearnedRule[] {
  return rules.map((r) => ({ ...r, from: '' }));
}

/**
 * 学到的规则按 id 合并（云端优先保留命中次数高的那条）。
 * 注意 `from` 一律保留本机那份：云端的那一版是被剥空的，不能被它覆盖掉，
 * 否则本机「这条规则哪来的」排查信息会莫名其妙消失。
 */
export function mergeLearned(local: LearnedRule[], remote: LearnedRule[]): LearnedRule[] {
  const map = new Map<string, LearnedRule>();
  for (const r of remote) map.set(r.id, r);
  for (const r of local) {
    const prev = map.get(r.id);
    if (!prev) map.set(r.id, r);
    else map.set(r.id, { ...prev, ...r, from: r.from || prev.from || '', hits: Math.max(prev.hits ?? 0, r.hits ?? 0) });
  }
  return [...map.values()];
}

/** 串行链：连发多条消息时避免并发 GET→POST 互相覆盖。 */
let chain: Promise<void> = Promise.resolve();

/**
 * 把本机学到的规则推到云端（读-改-写，保证 manual 段不被覆盖）。
 * 未登录 / 离线 → 静默跳过；失败只记日志，绝不打断记账主流程。
 */
export function pushLearnedRulesToCloud(): Promise<void> {
  const server = cloudReady();
  if (!server) return Promise.resolve();
  chain = chain
    .then(async () => {
      const local = await loadLearnedRules();
      if (local.length === 0) return;
      const env = parseEnvelope(await getRules(server));
      const merged = mergeLearned(local, env.learned);
      // 落云前脱敏：只留规则本体，不带任何原始对话文本
      await saveRules(server, { v: 2, manual: env.manual, learned: sanitizeForCloud(merged) });
    })
    .catch((e) => {
      logger.warn('rules', '学到的规则上云失败（不影响本地）：' + (e instanceof Error ? e.message : String(e)));
    });
  return chain;
}

/**
 * 把云端学到的规则拉回本机（登录后 / 打开规则页时调用）。
 * 返回合并后的本机规则条数（UI 提示用）。
 */
export async function pullLearnedRulesFromCloud(): Promise<number> {
  const server = cloudReady();
  if (!server) return (await loadLearnedRules()).length;
  try {
    const env = parseEnvelope(await getRules(server));
    if (env.learned.length === 0) return (await loadLearnedRules()).length;
    const local = await loadLearnedRules();
    const merged = mergeLearned(local, env.learned);
    await replaceLearnedRules(merged);
    return merged.length;
  } catch (e) {
    logger.warn('rules', '拉取云端规则失败：' + (e instanceof Error ? e.message : String(e)));
    return (await loadLearnedRules()).length;
  }
}
