import type { Settings } from '../types/entities';

/**
 * 多端增量同步 · 纯函数层（可单测，不依赖 store / 网络）。
 *
 * ★v1.7.0：
 * - LWW（Last-Write-Wins）：每条变更带毫秒时间戳，新者胜；
 * - 删除走「墓碑」（op='delete'），防止一端删除被另一端的旧数据"复活"；
 * - 设置漫游剥离敏感键：AI Endpoint / Key 只留本机，永不上云。
 */

/** 设置漫游专用文档 id（服务端白名单集合之一）。 */
export const SETTINGS_DOC_ID = '__settings';

/** 不随账号漫游的设置键（敏感 / 本机私有）。 */
export const NON_ROAMING_SETTING_KEYS = ['aiEndpoint', 'aiKey'] as const;

/** 可同步记录的最小形状（12 个集合的实体都满足）。 */
export interface SyncableRecord {
  id: string;
  updatedAt?: string | number;
  createdAt?: string;
}

/** 同步变更（与服务端 `/api/user/sync/*` DTO 对齐）。 */
export interface SyncChange {
  collection: string;
  recordId: string;
  op: 'upsert' | 'delete';
  data?: unknown;
  /** 毫秒时间戳（LWW 依据）。 */
  updatedAt: number;
}

/** 任意值 → 毫秒时间戳（无法解析返回 0）。 */
export function toMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v !== '') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** 记录的 LWW 时间戳：优先 updatedAt，回落 createdAt，再回落 0（最旧）。 */
export function recordUpdatedAt(r: unknown): number {
  const rec = r as SyncableRecord | null;
  if (!rec || typeof rec !== 'object') return 0;
  return toMs(rec.updatedAt) || toMs(rec.createdAt);
}

/** 剥离不漫游的设置键（推送 / 拉取双向都用）。 */
export function stripSensitiveSettings(s: Settings): Settings {
  const out = { ...s } as Record<string, unknown>;
  for (const k of NON_ROAMING_SETTING_KEYS) delete out[k];
  return out as unknown as Settings;
}

/**
 * 合并远端漫游设置：远端覆盖本地，但敏感键永远以本机为准
 * （服务端存的本来就是剥离后的，这里是双保险）。
 */
export function mergeRoamingSettings(local: Settings, remote: Partial<Settings>): Settings {
  const merged = { ...local, ...remote } as Settings;
  merged.aiEndpoint = local.aiEndpoint;
  merged.aiKey = local.aiKey;
  return merged;
}

/**
 * 差集：before → after 的变更（按 id + JSON 深比较）。
 * - upserts：新增或内容变化的记录
 * - deletes：before 有、after 没有的 id
 */
export function diffCollection<T>(before: T[], after: T[]): { upserts: T[]; deletes: string[] } {
  const prevMap = new Map<string, string>();
  for (const r of (before ?? []) as SyncableRecord[]) {
    if (r && typeof r.id === 'string') prevMap.set(r.id, stableStringify(r));
  }
  const nextMap = new Map<string, string>();
  for (const r of (after ?? []) as SyncableRecord[]) {
    if (r && typeof r.id === 'string') nextMap.set(r.id, stableStringify(r));
  }

  const upserts: T[] = [];
  for (const [id, json] of nextMap) {
    if (prevMap.get(id) !== json) upserts.push(after.find((r) => (r as SyncableRecord).id === id) as T);
  }
  const deletes: string[] = [];
  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) deletes.push(id);
  }
  return { upserts, deletes };
}

/** 稳定 JSON（键序无关的比较用）。 */
export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

/**
 * ★v1.8.0 服务端单条记录上限（GF_Sync::normalizeChange 对 >2MB 直接 ignored）。
 *
 * 旧版客户端碰到这种记录（典型：AI 导入的巨图 base64）是**静悄悄地永远同步不上**，
 * 没有任何提示。推送前用 `dropOversizeChanges` 剔出来并记日志，把「同步了但没生效」
 * 变成可排查的问题。图片走云端托管后单条只有几十字节，这条只服务极端脏数据。
 */
export const SYNC_MAX_RECORD_BYTES = 2 * 1024 * 1024;

/** 剔除服务端一定会拒收的超大 upsert；返回被剔掉的键（用于日志）。 */
export function dropOversizeChanges(changes: SyncChange[]): { keep: SyncChange[]; dropped: string[] } {
  const keep: SyncChange[] = [];
  const dropped: string[] = [];
  for (const c of changes) {
    if (c.op === 'upsert' && c.data !== undefined && c.data !== null) {
      let size = 0;
      try {
        size = JSON.stringify(c.data).length;
      } catch {
        size = Number.MAX_SAFE_INTEGER;
      }
      if (size > SYNC_MAX_RECORD_BYTES) {
        dropped.push(`${c.collection}:${c.recordId}(${Math.round(size / 1024)}KB)`);
        continue;
      }
    }
    keep.push(c);
  }
  return { keep, dropped };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/**
 * LWW 裁决：拉下来的远端变更应不应该覆盖本地记录。
 * @param localUpdatedAt 本地记录时间戳（ms，0 = 无记录）
 * @param remoteUpdatedAt 远端变更时间戳（ms）
 * @param hasPendingLocal 本地是否有该记录**更新的**未推送变更（outbox 命中）
 */
export function remoteShouldWin(
  localUpdatedAt: number,
  remoteUpdatedAt: number,
  hasPendingLocal: boolean,
): boolean {
  if (hasPendingLocal) return false; // 本地有未推送的更新：等推上去自然覆盖
  return remoteUpdatedAt > localUpdatedAt; // 严格大于：相等视为同版本，不动本地
}
