import { create } from 'zustand';
import { pullSync, pushSync } from '../api/sync';
import { humanMessage } from '../lib/error';
import { slimRecordForSnapshot } from '../lib/imageCompress';
import logger from '../lib/log';
import { saveCollection } from '../storage/repo';
import type { ServerConfig, Settings } from '../types/entities';
import { isLoggedIn, useAuthStore } from '../store/useAuthStore';
import { refreshTheme } from '../store/useAppStore';
import { useDataStore } from '../store/useDataStore';
import { currentServer } from '../store/useServerStore';
import { useSettingsStore } from '../store/useSettingsStore';
import {
  clearNeedSeed,
  getCursor,
  getMeta,
  peekNeedSeed,
  readOutbox,
  removeEntries,
  setCursor,
  setEnqueueListener,
  setMeta,
} from './outbox';
import {
  dropOversizeChanges,
  mergeRoamingSettings,
  recordUpdatedAt,
  remoteShouldWin,
  SETTINGS_DOC_ID,
  stripSensitiveSettings,
  type SyncableRecord,
  type SyncChange,
} from './model';
import { noteSettingsMutation } from './note';

/**
 * ★v1.7.0 多端同步引擎
 *
 * 职责：登录态下把本机变更推上云（outbox）、把云端变更拉下来按 LWW 合并进本地，
 * 实现「手机写、电脑自动看到」。未登录时引擎不启动，行为与旧版（纯本地）完全一致。
 *
 * 触发时机：启动 / 登录成功 / 数据变更后防抖 2.5s / 设置变更 / 切前台 / 每 60s 轮询。
 *
 * 合并规则（LWW）：
 * - 远端新（updatedAt 严格更大）→ 覆盖本地；
 * - 本地有未推送的更新（outbox 命中且不早于远端）→ 本地优先，推完自然覆盖云端；
 * - 删除走墓碑，不会被旧数据"复活"。
 *
 * ★v1.8.0 图片云端化：每轮同步前先把「本地有、云端没有」的图托管（低频、失败静默），
 * 推送时云端图只留 `{source:'cloud', ref, sha256}` —— 图片字节不再进同步链路。
 */

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'error';

interface SyncState {
  status: SyncStatus;
  /** 上次成功同步时间（ms，0 = 从未）。 */
  lastSyncAt: number;
  /** 待推送变更条数。 */
  pending: number;
  error: string;
}

export const useSyncStore = create<SyncState>()(() => ({
  status: 'off',
  lastSyncAt: 0,
  pending: 0,
  error: '',
}));

/* ---------------- 模块内状态 ---------------- */

const DEBOUNCE_MS = 2500;
const INTERVAL_MS = 60_000;
const PUSH_CHUNK = 200;
/** pull 循环安全上限（500 × 40 = 2 万条）。 */
const PULL_MAX_ROUNDS = 40;
/** ★v1.8.0 图片托管的最小间隔：同步是 60s 轮询，不能每轮都扫全量集合。 */
const IMAGE_MIGRATE_INTERVAL_MS = 5 * 60_000;

let started = false;
let syncing = false;
let rerunRequested = false;
let applyingRemote = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let unsubSettings: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;
/** ★v1.8.0：上次图片托管时间（5 分钟内不重复扫全量）。 */
let lastImageMigrateAt = 0;

function patchStore(patch: Partial<SyncState>): void {
  useSyncStore.setState(patch);
}

/* ---------------- 对外 API ---------------- */

/** 防抖调度一次同步（outbox 入队后由 listener 触发）。 */
export function scheduleSync(delay = DEBOUNCE_MS): void {
  if (!started) return;
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void syncNow('debounce');
  }, delay);
}

/**
 * 立即同步一轮（推 outbox → 拉 → 合并）。
 * @returns 是否完整成功
 */
export async function syncNow(reason: string): Promise<boolean> {
  const server = currentServer();
  if (!started || !server || !isLoggedIn() || useAuthStore.getState().sessionState !== 'valid') {
    return false;
  }
  if (!useDataStore.getState().loaded || !useSettingsStore.getState().loaded) return false;
  if (syncing) {
    rerunRequested = true;
    return false;
  }
  syncing = true;
  patchStore({ status: 'syncing', error: '' });
  try {
    await runSync(server);
    patchStore({ status: 'idle', lastSyncAt: Date.now(), error: '' });
    await setMeta(server.id, { lastSyncAt: Date.now(), lastError: '' });
    return true;
  } catch (e) {
    const msg = humanMessage(e);
    logger.warn('sync', `同步失败（${reason}）：${msg}`);
    patchStore({ status: 'error', error: msg });
    try {
      await setMeta(server.id, { lastSyncAt: useSyncStore.getState().lastSyncAt, lastError: msg });
    } catch {
      /* 元信息写失败不影响 */
    }
    return false;
  } finally {
    syncing = false;
    if (rerunRequested) {
      rerunRequested = false;
      scheduleSync(300);
    }
  }
}

/** 启动引擎（幂等）。登录成功 / App 启动时调用；未登录时每轮 syncNow 自行短路。 */
export function startSyncEngine(): void {
  if (started) {
    void syncNow('start');
    return;
  }
  started = true;
  patchStore({ status: 'idle' });

  // 冷启动：把上次同步元信息读进 store（UI 展示用）
  const sidAtStart = currentServer()?.id;
  if (sidAtStart) {
    void getMeta(sidAtStart)
      .then((m) => patchStore({ lastSyncAt: m.lastSyncAt, pending: 0 }))
      .catch(() => {
        /* 元信息读取失败不影响 */
      });
  }

  // outbox 有新变更 → 防抖同步
  setEnqueueListener(() => scheduleSync());

  // 设置变更 → 设置漫游（剥离敏感键）
  unsubSettings = useSettingsStore.subscribe((state, prev) => {
    if (applyingRemote) return;
    if (state.settings === prev.settings) return;
    void noteSettingsMutation(stripSensitiveSettings(state.settings));
  });

  intervalTimer = setInterval(() => {
    void syncNow('interval');
  }, INTERVAL_MS);

  visibilityHandler = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void syncNow('visible');
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', visibilityHandler);
  }
  void registerNativeResume();

  void syncNow('start');
}

/** 停止引擎（登出 / 会话过期时调用）。本地数据保留，队列与游标也保留。 */
export function stopSyncEngine(): void {
  if (!started) return;
  started = false;
  if (intervalTimer !== null) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  unsubSettings?.();
  unsubSettings = null;
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = null;
  setEnqueueListener(null);
  patchStore({ status: 'off', pending: 0 });
}

/* ---------------- 内部实现 ---------------- */

async function registerNativeResume(): Promise<void> {
  try {
    const mod = await import('@capacitor/app');
    await mod.App.addListener('resume', () => {
      void syncNow('resume');
    });
  } catch {
    /* 浏览器环境无原生 App 插件，忽略 */
  }
}

/** 一轮完整同步（★v1.7.1 修复重排）：
 *
 * 旧版缺陷：首次同步必须 seedAll 完整成功才解锁 pull —— 任何一次失败后
 * 游标永远为 null，每轮都重头全量推送，pull 永远执行不到，
 * 云端其他设备的数据（如电脑端新增的订阅）永远拉不下来。
 *
 * 新顺序：
 *   ① 恢复备份标记（needSeed）→ 先推本机全部（服务端 LWW 裁决），失败保留标记下轮重试；
 *   ② 首次（无游标）→ 游标占位 0，立即解锁 pull 通道；
 *   ③ 推 outbox（本机待推变更）；
 *   ④ 拉取合并（首次从 0 = 远端全量快照），收集远端已有的记录键；
 *   ⑤ 首次 → 只把「本地有、远端没有」的差集推上云（不重复推远端已有的）。
 *
 * ★v1.8.0：在最前面加一步「图片托管」，让 ①②③ 推出去的都是云端引用而非 base64。
 */
async function runSync(server: ServerConfig): Promise<void> {
  const sid = server.id;

  // 0. 刷新 pending 展示
  patchStore({ pending: (await readOutbox(sid)).length });

  // 0.5 图片托管（低频、失败静默）：只传云端没有的，然后把本地记录换成云端引用
  try {
    const now = Date.now();
    if (now - lastImageMigrateAt > IMAGE_MIGRATE_INTERVAL_MS) {
      lastImageMigrateAt = now;
      const { migrateLocalImages } = await import('../store/imageCloudActions');
      const report = await migrateLocalImages({ scope: 'all' });
      if (report.uploaded > 0 || report.records > 0) {
        logger.debug('sync', `同步前图片托管：新传 ${report.uploaded} 张、改写 ${report.records} 条`);
      }
    }
  } catch (e) {
    logger.warn('sync', '图片托管跳过（不影响同步）', e);
  }

  // 1. 恢复备份：先推本机全部（先推后拉，本机快照才不会被远端旧数据顶掉）
  if (await peekNeedSeed(sid)) {
    await seedAll(server);
    await clearNeedSeed(sid);
  }

  // 2. 首次同步：游标占位 0（立即解锁 pull，绝不让 seed 阻塞拉取）
  let cursor = await getCursor(sid);
  const firstSync = cursor === null;
  if (cursor === null) cursor = 0;
  if (firstSync) await setCursor(sid, 0);

  // 3. 推送 outbox（最多 20 轮 × 200 条，剩余下轮继续）
  await pushOutbox(server);

  // 4. 拉取并合并（循环直到没有更多），同时收集远端已有的记录键
  const remoteKeys = new Set<string>();
  for (let round = 0; round < PULL_MAX_ROUNDS; round += 1) {
    const res = await pullSync(server, cursor);
    if (res.changes.length > 0) {
      await applyRemoteChanges(server.id, res.changes);
      for (const c of res.changes) remoteKeys.add(`${c.collection}:${c.recordId}`);
    }
    cursor = res.cursor;
    await setCursor(sid, cursor);
    if (!res.hasMore) break;
  }

  // 5. 首次同步：把「本地有、远端没有」的差集推上云
  if (firstSync) {
    await seedMissing(server, remoteKeys);
  }

  patchStore({ pending: (await readOutbox(sid)).length });
}

/** ★v1.8.0：云端图只留引用（slimRecordForSnapshot）+ 剔除服务端必拒的超大记录。 */
function preparePush(
  changes: Array<{ collection: string; recordId: string; op: 'upsert'; data: unknown; updatedAt: number }>,
): SyncChange[] {
  const slimmed: SyncChange[] = changes.map((c) => ({
    collection: c.collection,
    recordId: c.recordId,
    op: c.op,
    data: slimRecordForSnapshot(c.data),
    updatedAt: c.updatedAt,
  }));
  const { keep, dropped } = dropOversizeChanges(slimmed);
  if (dropped.length > 0) {
    logger.warn('sync', `跳过 ${dropped.length} 条超大记录（服务端单条上限 2MB）：${dropped.join(', ')}`);
  }
  return keep;
}

/** 本机全量 seed：12 集合 + 设置（剥离敏感键）。服务端按 LWW 去重，幂等。 */
async function seedAll(server: ServerConfig): Promise<void> {
  const ds = useDataStore.getState();
  const { COLLECTIONS } = await import('../types/entities');
  const changes: Array<{ collection: string; recordId: string; op: 'upsert'; data: unknown; updatedAt: number }> = [];
  for (const name of COLLECTIONS) {
    const rows = (ds[name] as unknown as SyncableRecord[]) ?? [];
    for (const r of rows) {
      if (!r || typeof r.id !== 'string') continue;
      changes.push({
        collection: name,
        recordId: r.id,
        op: 'upsert',
        data: r,
        updatedAt: recordUpdatedAt(r) || Date.now(),
      });
    }
  }
  changes.push({
    collection: SETTINGS_DOC_ID,
    recordId: 'settings',
    op: 'upsert',
    data: stripSensitiveSettings(useSettingsStore.getState().settings),
    updatedAt: Date.now(),
  });

  let applied = 0;
  for (let i = 0; i < changes.length; i += PUSH_CHUNK) {
    const res = await pushSync(server, preparePush(changes.slice(i, i + PUSH_CHUNK)));
    applied += res.applied;
  }
  logger.debug('sync', `全量 seed 完成：${changes.length} 条（服务端 applied ${applied}）`);
}

/** 首次同步差集（★v1.7.1）：只推「本地有、远端没有」的记录，远端已有的交给 pull 合并。
 *  比旧版「无脑全量推」快得多，也不会因 seed 失败而阻塞拉取。 */
async function seedMissing(server: ServerConfig, remoteKeys: Set<string>): Promise<void> {
  const ds = useDataStore.getState();
  const { COLLECTIONS } = await import('../types/entities');
  const changes: Array<{ collection: string; recordId: string; op: 'upsert'; data: unknown; updatedAt: number }> = [];
  for (const name of COLLECTIONS) {
    const rows = (ds[name] as unknown as SyncableRecord[]) ?? [];
    for (const r of rows) {
      if (!r || typeof r.id !== 'string') continue;
      if (remoteKeys.has(`${name}:${r.id}`)) continue; // 远端已有：不重复推
      changes.push({
        collection: name,
        recordId: r.id,
        op: 'upsert',
        data: r,
        updatedAt: recordUpdatedAt(r) || Date.now(),
      });
    }
  }
  if (changes.length === 0) return;

  let applied = 0;
  for (let i = 0; i < changes.length; i += PUSH_CHUNK) {
    const res = await pushSync(server, preparePush(changes.slice(i, i + PUSH_CHUNK)));
    applied += res.applied;
  }
  logger.debug('sync', `差集 seed 完成：${changes.length} 条（服务端 applied ${applied}）`);
}

/** 推送 outbox（成功即移除；服务端 ignored 表示云端已有更新版本，同样移除）。 */
async function pushOutbox(server: ServerConfig): Promise<void> {
  const sid = server.id;
  for (let round = 0; round < 20; round += 1) {
    const entries = await readOutbox(sid);
    if (entries.length === 0) return;
    const batch = entries.slice(0, PUSH_CHUNK);
    // ★v1.8.0：云端图只推 `{source:'cloud', ref, sha256}`（outbox 里可能是带缩略图的旧形态）
    const slimmed: SyncChange[] = batch.map((e) => ({
      collection: e.collection,
      recordId: e.recordId,
      op: e.op,
      data: e.op === 'upsert' ? slimRecordForSnapshot(e.data) : e.data,
      updatedAt: e.updatedAt,
    }));
    const { keep, dropped } = dropOversizeChanges(slimmed);
    if (dropped.length > 0) {
      logger.warn('sync', `跳过 ${dropped.length} 条超大记录（服务端单条上限 2MB）：${dropped.join(', ')}`);
    }
    await pushSync(server, keep);
    await removeEntries(sid, batch.map((e) => e.k));
  }
}

/** 把远端变更合并进本地（LWW + 墓碑；settings 单独处理）。 */
async function applyRemoteChanges(
  serverId: string,
  changes: Array<{ collection: string; recordId: string; op: 'upsert' | 'delete'; data?: unknown; updatedAt: number }>,
): Promise<void> {
  const pending = await readOutbox(serverId);
  const ds = useDataStore.getState();

  /* 设置漫游 */
  for (const c of changes) {
    if (c.collection !== SETTINGS_DOC_ID) continue;
    if (c.op !== 'upsert' || !c.data || typeof c.data !== 'object') continue;
    const local = useSettingsStore.getState().settings;
    const merged = mergeRoamingSettings(local, c.data as Partial<Settings>);
    applyingRemote = true;
    try {
      await useSettingsStore.getState().replace(merged);
      refreshTheme();
    } finally {
      applyingRemote = false;
    }
  }

  /* 12 集合：按 collection 分组批量合并 */
  const byCollection = new Map<string, typeof changes>();
  for (const c of changes) {
    if (c.collection === SETTINGS_DOC_ID) continue;
    const list = byCollection.get(c.collection) ?? [];
    list.push(c);
    byCollection.set(c.collection, list);
  }

  for (const [collection, list] of byCollection) {
    const rows = ((ds as unknown as Record<string, SyncableRecord[]>)[collection] ?? []).slice();
    let changed = false;

    // 删除墓碑
    for (const c of list) {
      if (c.op !== 'delete') continue;
      const idx = rows.findIndex((r) => r?.id === c.recordId);
      if (idx < 0) continue;
      const localAt = recordUpdatedAt(rows[idx]);
      const pendingNewer = pending.some((p) => p.collection === collection && p.recordId === c.recordId && p.updatedAt >= c.updatedAt);
      if (pendingNewer || localAt > c.updatedAt) continue; // 本地更新：保留，推上去会覆盖云端
      rows.splice(idx, 1);
      changed = true;
    }

    // upsert 合并
    for (const c of list) {
      if (c.op !== 'upsert' || !c.data || typeof c.data !== 'object') continue;
      const remote = c.data as SyncableRecord;
      if (!remote || typeof remote.id !== 'string') continue;
      const idx = rows.findIndex((r) => r?.id === remote.id);
      const pendingNewer = pending.some((p) => p.collection === collection && p.recordId === remote.id && p.updatedAt >= c.updatedAt);
      if (idx < 0) {
        rows.unshift(remote);
        changed = true;
        continue;
      }
      if (!remoteShouldWin(recordUpdatedAt(rows[idx]), c.updatedAt, pendingNewer)) continue;
      rows[idx] = remote;
      changed = true;
    }

    if (changed) {
      useDataStore.setState({ [collection]: rows } as unknown as Partial<Record<string, unknown>>);
      await saveCollection(collection as Parameters<typeof saveCollection>[0], rows as unknown as unknown[]);
    }
  }
}

/** 供 UI / 测试：读上次同步元信息。 */
export async function loadSyncMeta(serverId: string): Promise<{ lastSyncAt: number; lastError: string }> {
  return getMeta(serverId);
}

/** 引擎是否在运行（测试 / 调试用）。 */
export function isSyncEngineRunning(): boolean {
  return started;
}