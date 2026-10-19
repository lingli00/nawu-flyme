import { request } from '../net/httpClient';
import { ApiError } from '../lib/error';
import type { ServerConfig } from '../types/entities';

/**
 * v1.0.36 · 管理后台「在线更新 / App 发布」接口封装。
 *
 * 与管理后台其它请求一致：X-Admin-Token 头 + auth:false + ignoreUnauth:true + retry:0，
 * 响应 ok!==true 时抛 ApiError（消息透传后端中文文案）。
 */

export interface ServerUpdateSource {
  url: string;
  effective: string;
  autoCheck: boolean;
}

export interface ServerApplied {
  version: string;
  appliedAt: string;
  source: string;
  fileCount: number;
}

export interface ServerBackup {
  id: string;
  version: string;
  createdAt: string;
  sizeMb: number;
  fileCount: number;
}

export interface ServerUpdateInfo {
  version: string;
  php: string;
  os: string;
  diskFreeMb: number | null;
  source: ServerUpdateSource;
  applied: ServerApplied | null;
  backups: ServerBackup[];
  activeJob: { id: string; status: string; phase: string } | null;
  schema: { current: number; target: number };
}

export type UpdateComparison = 'newer' | 'same' | 'older';

export interface UpdateCheckResult {
  comparison: UpdateComparison;
  canUpdate: boolean;
  reason: string;
  local: { version: string };
  remote: {
    version: string;
    publishedAt: string;
    notes: string;
    packageSize: number;
    packageSha256: string;
    minVersion: string;
  };
  diff: {
    added: number;
    updated: number;
    deleted: number;
    kept: number;
    totalRemote: number;
    deletedList: string[];
    deletedListCapped: boolean;
  };
  elapsedMs: number;
}

export interface UpdateJobLog {
  t: string;
  msg: string;
}

export interface UpdateJob {
  id: string;
  status: 'running' | 'stalled' | 'done' | 'failed' | 'rolled_back' | 'cancelled';
  phase: string;
  phaseLabel: string;
  percent: number;
  message: string;
  log: UpdateJobLog[];
  error: string | null;
  progress: { bytes: number; totalBytes: number; fileIndex: number; fileTotal: number } | null;
  backupId: string | null;
  result: { added: number; updated: number; deleted: number } | null;
  migration: { from: number; to: number; log: string[] } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AppReleaseHistoryItem {
  version: string;
  file: string;
  fileSize: number;
  publishedAt: string;
  notes: string;
}

export interface AppReleaseManifest {
  version: string;
  notes: string;
  file: string;
  fileSize: number;
  publishedAt: string;
  history: AppReleaseHistoryItem[];
}

async function adminRequest<T>(
  server: Pick<ServerConfig, 'url'> | null | undefined,
  token: string,
  path: string,
  init: {
    method?: 'GET' | 'POST';
    body?: unknown;
    query?: Record<string, string | number>;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const res = await request<Record<string, unknown>>(server, {
    method: init.method ?? 'GET',
    path,
    body: init.body,
    query: init.query,
    timeoutMs: init.timeoutMs,
    auth: false,
    retry: 0,
    ignoreUnauth: true,
    headers: token ? { 'X-Admin-Token': token } : undefined,
  });
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', (res.data as { error?: string })?.error ?? '请求失败', res.status, res.data);
  }
  return res.data as unknown as T;
}

export function fetchServerInfo(server: Pick<ServerConfig, 'url'> | null, token: string): Promise<{ info: ServerUpdateInfo }> {
  return adminRequest<{ info: ServerUpdateInfo }>(server, token, '/api/admin/server/info');
}

export function fetchSource(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
): Promise<{ url: string; autoCheck: boolean; effective: string }> {
  return adminRequest(server, token, '/api/admin/server/source');
}

export function saveSource(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
  url: string,
  autoCheck: boolean,
): Promise<Record<string, never>> {
  return adminRequest(server, token, '/api/admin/server/source', { method: 'POST', body: { url, autoCheck } });
}

export function testSource(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
  url: string,
): Promise<{ remoteVersion: string; publishedAt: string; packageSize: number }> {
  return adminRequest(server, token, '/api/admin/server/source/test', { method: 'POST', body: { url } });
}

export function checkServerUpdate(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
  force = false,
): Promise<UpdateCheckResult> {
  return adminRequest<UpdateCheckResult>(server, token, '/api/admin/server/check', { method: 'POST', body: { force } });
}

/**
 * 注意超时：`/status` 是「轮询即推进」——服务端每次响应前先干一片活（SLICE_MS）。
 * 默认 15s 会和服务端的 18s 预算打架，导致跨公网更新时前端永远收不到 jobId，
 * 表现为「连接超时（15s）」+「已有更新任务正在进行」死循环。这里统一给 30s。
 */
const UPDATE_TIMEOUT_MS = 30000;

export function startServerUpdate(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
  force: boolean,
  siteUrl = '',
): Promise<{ jobId: string; resumed: boolean }> {
  return adminRequest(
    server,
    token,
    '/api/admin/server/update',
    { method: 'POST', body: { force, siteUrl }, timeoutMs: UPDATE_TIMEOUT_MS },
  );
}

export function fetchJob(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
  jobId?: string,
): Promise<{ job: UpdateJob | null }> {
  return adminRequest<{ job: UpdateJob | null }>(server, token, '/api/admin/server/status', {
    query: jobId ? { jobId } : undefined,
    timeoutMs: UPDATE_TIMEOUT_MS,
  });
}

export function cancelJob(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
  jobId: string,
): Promise<Record<string, never>> {
  return adminRequest(server, token, '/api/admin/server/cancel', { method: 'POST', body: { jobId } });
}

export function rollbackServer(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
  backupId: string,
): Promise<{ restored: number; version: string }> {
  return adminRequest(server, token, '/api/admin/server/rollback', { method: 'POST', body: { backupId } });
}

export function runMigration(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
): Promise<{ from: number; to: number; log: string[] }> {
  return adminRequest(server, token, '/api/admin/server/migrate', { method: 'POST', body: {} });
}

export function fetchAppRelease(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
): Promise<{ manifest: AppReleaseManifest; fileExists: boolean }> {
  return adminRequest(server, token, '/api/admin/app-release');
}

/** 发布 App 安装包：raw body 上传（走后端 php://input，绕开 upload_max_filesize）。 */
export async function publishAppRelease(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
  file: Blob,
  version: string,
  notes: string,
): Promise<{
  manifest: { version: string; file: string; fileSize: number; publishedAt: string };
  historyCount: number;
  replaced: boolean;
}> {
  const buf = await file.arrayBuffer();
  const res = await request<Record<string, unknown>>(server, {
    method: 'POST',
    path: '/api/admin/app-release',
    rawBody: buf,
    contentType: 'application/vnd.android.package-archive',
    query: { version, notes },
    timeoutMs: 600000,
    auth: false,
    retry: 0,
    ignoreUnauth: true,
    headers: token ? { 'X-Admin-Token': token } : undefined,
  });
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', (res.data as { error?: string })?.error ?? '发布失败', res.status, res.data);
  }
  return res.data as unknown as {
    manifest: { version: string; file: string; fileSize: number; publishedAt: string };
    historyCount: number;
    replaced: boolean;
  };
}

/**
 * 清理更新通道里的旧包（v1.1.7）。
 *
 * 留存策略：完整包、增量补丁各只留最近 3 份；当前清单点名的文件永远保留。
 * 发布时会自动跑一次，这里给后台一个手动入口（换过频道、手动传过包的场合）。
 */
export async function pruneUpdateChannel(
  server: Pick<ServerConfig, 'url'> | null,
  token: string,
): Promise<{ apk: number; patch: number; bytes: number }> {
  const res = await request<Record<string, unknown>>(server, {
    method: 'POST',
    path: '/api/admin/app-channel/prune',
    timeoutMs: 60000,
    auth: false,
    retry: 0,
    ignoreUnauth: true,
    headers: token ? { 'X-Admin-Token': token } : undefined,
  });
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', (res.data as { error?: string })?.error ?? '清理失败', res.status, res.data);
  }
  const d = res.data as { apk?: number; patch?: number; bytes?: number };
  return { apk: d.apk ?? 0, patch: d.patch ?? 0, bytes: d.bytes ?? 0 };
}
