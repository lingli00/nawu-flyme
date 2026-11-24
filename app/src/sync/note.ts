import { currentServer } from '../store/useServerStore';
import { isLoggedIn } from '../store/useAuthStore';
import { enqueueAndNotify, enqueueDeleteAndNotify, markNeedSeed } from './outbox';
import { diffCollection, recordUpdatedAt, SETTINGS_DOC_ID, type SyncableRecord } from './model';
import logger from '../lib/log';

/**
 * 数据变更 → 同步队列的**唯一入口**（useDataStore.commit / undo 调用）。
 *
 * - 未登录 / 未配服务器：直接跳过（本地优先，登录后的全量 seed 会把数据补上去）；
 * - 恢复备份（setAllCollections）不走这里，走 markNeedSeedForCurrentServer。
 * - 任何失败只记日志，绝不影响记账主流程。
 */

/** 一次集合变更入队。 */
export async function noteCollectionMutation<T>(
  collection: string,
  before: T[],
  after: T[],
): Promise<void> {
  try {
    const server = currentServer();
    if (!server || !isLoggedIn()) return;
    const { upserts, deletes } = diffCollection(
      (before ?? []) as SyncableRecord[],
      (after ?? []) as SyncableRecord[],
    );
    if (upserts.length === 0 && deletes.length === 0) return;
    for (const r of upserts as SyncableRecord[]) {
      await enqueueAndNotify(server.id, collection, r.id, r, recordUpdatedAt(r) || Date.now());
    }
    for (const id of deletes) {
      await enqueueDeleteAndNotify(server.id, collection, id, Date.now());
    }
  } catch (e) {
    logger.warn('sync', '变更入队失败（不影响本地数据）', e);
  }
}

/** 设置变更入队（engine 订阅 settings store 时调用；data 需先剥离敏感键）。 */
export async function noteSettingsMutation(stripped: unknown): Promise<void> {
  try {
    const server = currentServer();
    if (!server || !isLoggedIn()) return;
    await enqueueAndNotify(server.id, SETTINGS_DOC_ID, 'settings', stripped, Date.now());
  } catch (e) {
    logger.warn('sync', '设置变更入队失败（不影响本地）', e);
  }
}

/** 标记「需要全量 seed」：恢复备份后调用（服务端可能没有这些记录）。 */
export async function markNeedSeedForCurrentServer(): Promise<void> {
  try {
    const server = currentServer();
    if (!server) return;
    await markNeedSeed(server.id);
  } catch (e) {
    logger.warn('sync', '标记 needSeed 失败', e);
  }
}
