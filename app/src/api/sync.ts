import { ApiError } from '../lib/error';
import { get, post } from '../net/httpClient';
import type { ServerConfig } from '../types/entities';
import type { SyncChange } from '../sync/model';

/**
 * 多端增量同步接口（★v1.7.0，服务端 `/api/user/sync/*`）。
 * 均需登录（Bearer token 由 httpClient 注入）。
 */

interface SyncOkResp {
  ok: boolean;
  error?: string;
}

/** 单次推送条数上限（与服务端 GF_Sync::MAX_PUSH_CHANGES 一致）。 */
export const MAX_PUSH_CHANGES = 500;
/** 单次拉取条数上限（服务端硬上限 500）。 */
export const PULL_LIMIT = 500;

export interface PushResult {
  applied: number;
  ignored: number;
}

export async function pushSync(server: ServerConfig | null, changes: SyncChange[]): Promise<PushResult> {
  if (!server) throw new ApiError('invalid_url', '未配置服务器');
  if (changes.length === 0) return { applied: 0, ignored: 0 };
  const res = await post<SyncOkResp & { applied?: number; ignored?: number }>(server, '/api/user/sync/push', {
    changes,
  });
  const data = res.data;
  if (!data || data.ok !== true) {
    throw new ApiError('http', data?.error ?? '同步推送失败', res.status, data);
  }
  return { applied: data.applied ?? 0, ignored: data.ignored ?? 0 };
}

export interface PullChange extends SyncChange {
  /** 服务端游标（flyme_sync_docs.id）。 */
  cursor: number;
}

export interface PullResult {
  changes: PullChange[];
  cursor: number;
  hasMore: boolean;
}

export async function pullSync(server: ServerConfig | null, since: number, limit = PULL_LIMIT): Promise<PullResult> {
  if (!server) throw new ApiError('invalid_url', '未配置服务器');
  const res = await get<SyncOkResp & { changes?: PullChange[]; cursor?: number; hasMore?: boolean }>(
    server,
    '/api/user/sync/pull',
    { since, limit },
  );
  const data = res.data;
  if (!data || data.ok !== true) {
    throw new ApiError('http', data?.error ?? '同步拉取失败', res.status, data);
  }
  return {
    changes: Array.isArray(data.changes) ? data.changes : [],
    cursor: typeof data.cursor === 'number' ? data.cursor : since,
    hasMore: data.hasMore === true,
  };
}
