import { getKV, setKV } from '../storage/kv';
import { nowISO } from '../lib/date';
import type { SyncChange } from './model';

/**
 * 同步队列（outbox）+ 游标/元信息 —— 持久化在本地 KV，**按服务器分槽**。
 *
 * 设计：
 * - 每条待推送变更以 `${collection}:${recordId}` 为键去重（同一条记录连改十次只推最后一次）；
 * - 上限 5000 条（超出丢最旧的，正常节流推送下到不了）；
 * - 游标 `cursor` 是服务端 flyme_sync_docs.id（单调递增），记录「本设备拉到哪了」；
 * - `needSeed` 标记：恢复备份 / 首次登录后需要把本机全量推一遍（服务端可能没有这些记录）。
 */

/** outbox 条目。 */
export interface OutboxEntry extends SyncChange {
  /** 去重键 `${collection}:${recordId}`。 */
  k: string;
}

/** 同步元信息（UI 展示用）。 */
export interface SyncMeta {
  lastSyncAt: number;
  lastError: string;
}

const outboxKey = (serverId: string): string => `flyme.kv.sync.${serverId}.outbox`;
const cursorKey = (serverId: string): string => `flyme.kv.sync.${serverId}.cursor`;
const metaKey = (serverId: string): string => `flyme.kv.sync.${serverId}.meta`;
const needSeedKey = (serverId: string): string => `flyme.kv.sync.${serverId}.needseed`;

/** 队列上限（超出丢最旧的）。 */
const OUTBOX_LIMIT = 5000;

/* ---------------- outbox ---------------- */

export async function readOutbox(serverId: string): Promise<OutboxEntry[]> {
  const raw = await getKV<Record<string, OutboxEntry>>(outboxKey(serverId), {});
  if (!raw || typeof raw !== 'object') return [];
  return Object.values(raw).filter(
    (e) => e && typeof e === 'object' && typeof e.k === 'string' && typeof e.recordId === 'string',
  );
}

async function writeOutbox(serverId: string, map: Record<string, OutboxEntry>): Promise<void> {
  await setKV(outboxKey(serverId), map);
}

/** 入队 upsert（同记录旧条目被覆盖）。 */
export async function enqueueUpsert(
  serverId: string,
  collection: string,
  recordId: string,
  data: unknown,
  updatedAt: number,
): Promise<void> {
  const map = await loadMap(serverId);
  map[`${collection}:${recordId}`] = { k: `${collection}:${recordId}`, collection, recordId, op: 'upsert', data, updatedAt };
  await saveMap(serverId, map);
}

/** 入队删除墓碑。 */
export async function enqueueDelete(
  serverId: string,
  collection: string,
  recordId: string,
  updatedAt: number,
): Promise<void> {
  const map = await loadMap(serverId);
  map[`${collection}:${recordId}`] = { k: `${collection}:${recordId}`, collection, recordId, op: 'delete', updatedAt };
  await saveMap(serverId, map);
}

/** 批量移除已推送成功的条目。 */
export async function removeEntries(serverId: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const map = await loadMap(serverId);
  for (const k of keys) delete map[k];
  await saveMap(serverId, map);
}

/** 指定记录是否在队列里有**不早于 since** 的待推送变更（拉取合并时「本地优先」依据）。 */
export function findPending(entries: OutboxEntry[], collection: string, recordId: string, since: number): OutboxEntry | null {
  const hit = entries.find((e) => e.collection === collection && e.recordId === recordId);
  return hit && hit.updatedAt >= since ? hit : null;
}

async function loadMap(serverId: string): Promise<Record<string, OutboxEntry>> {
  const raw = await getKV<Record<string, OutboxEntry>>(outboxKey(serverId), {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

async function saveMap(serverId: string, map: Record<string, OutboxEntry>): Promise<void> {
  const entries = Object.values(map);
  if (entries.length > OUTBOX_LIMIT) {
    entries.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const e of entries.slice(0, entries.length - OUTBOX_LIMIT)) delete map[e.k];
  }
  await writeOutbox(serverId, map);
}

/* ---------------- 游标 / 元信息 / needSeed ---------------- */

export async function getCursor(serverId: string): Promise<number | null> {
  const v = await getKV<number>(cursorKey(serverId), null);
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

export async function setCursor(serverId: string, cursor: number): Promise<void> {
  await setKV(cursorKey(serverId), cursor);
}

export async function getMeta(serverId: string): Promise<SyncMeta> {
  const v = await getKV<SyncMeta>(metaKey(serverId), null);
  return v && typeof v === 'object' ? { lastSyncAt: v.lastSyncAt || 0, lastError: v.lastError || '' } : { lastSyncAt: 0, lastError: '' };
}

export async function setMeta(serverId: string, meta: SyncMeta): Promise<void> {
  await setKV(metaKey(serverId), meta);
}

export async function markNeedSeed(serverId: string): Promise<void> {
  await setKV(needSeedKey(serverId), nowISO());
}

/** 读取 seed 标记（不消费 —— seed 失败要保留，下一轮重试）。 */
export async function peekNeedSeed(serverId: string): Promise<boolean> {
  const v = await getKV<string>(needSeedKey(serverId), null);
  return Boolean(v);
}

/** seed 成功后清除标记。 */
export async function clearNeedSeed(serverId: string): Promise<void> {
  await setKV(needSeedKey(serverId), null);
}

/* ---------------- 事件回调（engine 注册调度器，避免循环依赖） ---------------- */

type EnqueueListener = () => void;
let listener: EnqueueListener | null = null;

/** engine 启动时注册「有新变更 → 调度一次同步」。 */
export function setEnqueueListener(fn: EnqueueListener | null): void {
  listener = fn;
}

/** 入队后触发（内部用）。 */
function notify(): void {
  try {
    listener?.();
  } catch {
    /* 调度失败不影响入队 */
  }
}

/** 带通知的入队便捷封装（note.ts 用）。 */
export async function enqueueAndNotify(
  serverId: string,
  collection: string,
  recordId: string,
  data: unknown,
  updatedAt: number,
): Promise<void> {
  await enqueueUpsert(serverId, collection, recordId, data, updatedAt);
  notify();
}

export async function enqueueDeleteAndNotify(
  serverId: string,
  collection: string,
  recordId: string,
  updatedAt: number,
): Promise<void> {
  await enqueueDelete(serverId, collection, recordId, updatedAt);
  notify();
}
