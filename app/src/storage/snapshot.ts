import { ApiError } from '../lib/error';
import { nowISO } from '../lib/date';
import logger from '../lib/log';
import type { SnapshotPayload } from '../types/api';
import { COLLECTIONS, type CollectionName, type Settings } from '../types/entities';
import { createDefaultSettings } from './seed';

/**
 * 备份快照序列化 / 反序列化。
 *
 * ★两条硬约束：
 * 1. `app` 固定写 `'flyme-web'`（不能写 flyme-android，否则与 Web 版备份互斥）
 * 2. `count` 只算 `goods + subscriptions + valueRecords`（与 Web 版同口径）
 */

/** 快照来源数据。 */
export interface SnapshotInput {
  collections: Partial<Record<CollectionName, unknown[]>>;
  settings?: Settings | null;
}

/** 快照里的 app 标识（★固定值）。 */
export const SNAPSHOT_APP = 'flyme-web' as const;
/** 快照格式版本。 */
export const SNAPSHOT_VERSION = 1;

/** 组装快照。 */
export function buildSnapshot(input: SnapshotInput): SnapshotPayload {
  const collections: Partial<Record<CollectionName, unknown[]>> = {};
  for (const name of COLLECTIONS) {
    const rows = input.collections?.[name];
    collections[name] = Array.isArray(rows) ? rows : [];
  }
  const goods = collections.goods?.length ?? 0;
  const subs = collections.subscriptions?.length ?? 0;
  const ledger = collections.valueRecords?.length ?? 0;

  return {
    collections,
    settings: input.settings ?? null,
    count: goods + subs + ledger,
    app: SNAPSHOT_APP,
    version: SNAPSHOT_VERSION,
    exportedAt: nowISO(),
  };
}

/** 反序列化结果：12 个集合（缺失补空数组）+ 设置。 */
export interface AppliedSnapshot {
  collections: Record<CollectionName, unknown[]>;
  settings: Settings;
  count: number;
  exportedAt: string;
}

/**
 * 解析快照。
 *
 * ★F4：`payload` 可能是**对象**也可能是 **JSON 字符串**，这里双兼容。
 * 任何单个集合损坏都不会中断整体恢复（缺失即空数组）。
 *
 * ★settings 合并语义（对齐 Web 版 `patchSettings`）：
 * `{ 默认值, 本机现有值, 快照值 }` 依次覆盖 —— 本机现有 settings 里
 * 快照没有的键（如 `archivedSubIds`）**必须保留**，严禁整体替换。
 *
 * @param currentSettings 本机当前 settings（恢复前的状态），可为 null
 * @throws {ApiError} kind='parse'：内容完全无法识别
 */
export function applySnapshot(
  raw: SnapshotPayload | string | null | undefined,
  currentSettings?: Settings | null,
): AppliedSnapshot {
  let payload: unknown = raw;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      throw new ApiError('parse', '备份内容无法识别（不是合法 JSON）', undefined, raw);
    }
  }
  if (!payload || typeof payload !== 'object') {
    throw new ApiError('parse', '备份内容无法识别', undefined, raw);
  }

  const p = payload as Partial<SnapshotPayload> & { collections?: unknown };
  const rawCollections = (p.collections ?? {}) as Record<string, unknown>;

  const collections = {} as Record<CollectionName, unknown[]>;
  for (const name of COLLECTIONS) {
    const arr = rawCollections[name];
    collections[name] = Array.isArray(arr) ? arr : [];
  }

  // 合并顺序：默认值兜底 → 本机现有（保留快照没有的自定义键）→ 快照覆盖
  const settings: Settings = {
    ...createDefaultSettings(),
    ...(currentSettings ?? {}),
    ...(p.settings && typeof p.settings === 'object' ? (p.settings as Settings) : {}),
  };

  const count =
    typeof p.count === 'number'
      ? p.count
      : collections.goods.length + collections.subscriptions.length + collections.valueRecords.length;

  return {
    collections,
    settings,
    count,
    exportedAt: typeof p.exportedAt === 'string' ? p.exportedAt : '',
  };
}

/** 序列化成字符串（Web 版导出 / 调试用）。 */
export function snapshotToJson(payload: SnapshotPayload): string {
  return JSON.stringify(payload);
}

/** 从字符串解析（失败抛 parse 错误）。 */
export function snapshotFromJson(text: string): SnapshotPayload {
  try {
    const parsed = JSON.parse(text) as SnapshotPayload;
    if (!parsed || typeof parsed !== 'object' || !parsed.collections) {
      throw new Error('bad snapshot');
    }
    return parsed;
  } catch (e) {
    logger.error('snapshot', '解析失败', e);
    throw new ApiError('parse', '备份内容无法识别（不是合法 JSON）', undefined, text.slice(0, 200));
  }
}

/** 快照总条数（恢复后 UI 提示「已恢复 N 条」用）。 */
export function snapshotItemCount(payload: AppliedSnapshot | SnapshotPayload): number {
  if ('collections' in payload && 'count' in payload && typeof payload.count === 'number') {
    if (payload.count > 0) return payload.count;
  }
  const collections = (payload as AppliedSnapshot).collections ?? {};
  return COLLECTIONS.reduce((acc, name) => acc + (collections[name]?.length ?? 0), 0);
}
