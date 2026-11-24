import { ApiError } from '../lib/error';
import { del, get, post } from '../net/httpClient';
import type {
  BackupDetail,
  BackupDetailResp,
  BackupListResp,
  BackupRow,
  CreateBackupBody,
  CreateBackupResp,
  OkResp,
  SnapshotPayload,
} from '../types/api';
import type { ServerConfig } from '../types/entities';
import { EP } from './endpoints';
import {
  UPLOAD_CHUNK,
  UPLOAD_UNSUPPORTED,
  clearUploadProgress,
  splitChunks,
  toBase64,
  uploadKey,
  writeUploadProgress,
  type UploadProgress,
} from '../lib/resumableUpload';

/**
 * 备份接口。
 *
 * ★F4：
 * - 列表字段是 **`rows`**（不是 `backups`）
 * - 详情 `payload` **可能是对象也可能是 JSON 字符串** → 反序列化双兼容
 * - 服务端**只保留最近 3 份**（PHP 侧 trimBackups(3)），UI 必须明示
 */

/** 设备名：`Android/型号`，截断 60 字符（后端允许 110，Web 版截 60，跟随 Web）。 */
export async function deviceLabel(): Promise<string> {
  let label = 'Android/Device';
  try {
    const mod = await import('@capacitor/device');
    const info = await mod.Device.getInfo();
    const model = (info as { model?: string; name?: string }).model || '';
    label = model ? `Android/${model}` : `Android/${(info as { name?: string }).name ?? 'Device'}`;
  } catch {
    // 浏览器或非原生环境用默认名
  }
  return label.slice(0, 60);
}

/** 备份列表（★读 `rows` 字段）。 */
export async function listBackups(server: ServerConfig | null): Promise<BackupRow[]> {
  const res = await get<BackupListResp>(server, EP.backups);
  const data = res.data;
  if (!data || data.ok !== true) {
    throw new ApiError('http', data?.error ?? '备份列表获取失败', res.status, data);
  }
  const rows = Array.isArray(data.rows) ? data.rows : [];
  // 兜底：万一后端（或旧版本）用 backups 字段
  const legacy = (data as unknown as { backups?: BackupRow[] }).backups;
  return rows.length ? rows : Array.isArray(legacy) ? legacy : [];
}

/**
 * 上传一份备份，返回新备份 id。
 *
 * ★v1.5.1：≥1MB 的备份走**分片断点续传**（`/api/user/uploads/*`），
 * 弱网/切后台/App 重启后从已收字节继续；老服务器没有这些接口时自动回落单次 POST。
 */
export async function createBackup(
  server: ServerConfig | null,
  body: CreateBackupBody,
  onProgress?: (p: UploadProgress) => void,
): Promise<number> {
  const payloadStr = typeof body.payload === 'string' ? body.payload : JSON.stringify(body.payload);
  if (payloadStr.length >= UPLOAD_CHUNK) {
    try {
      return await createBackupChunked(server, body, payloadStr, onProgress);
    } catch (e) {
      if (!(e instanceof Error) || e.message !== UPLOAD_UNSUPPORTED) throw e;
      /* 老服务器：回落单次 POST */
    }
  }
  const res = await post<CreateBackupResp>(server, EP.backups, body);
  const data = res.data;
  if (!data || data.ok !== true || typeof data.id !== 'number') {
    throw new ApiError('http', data?.error ?? '备份上传失败', res.status, data);
  }
  return data.id;
}

interface UploadInitResp {
  ok: boolean;
  key: string;
  received: number;
  chunk_size: number;
  error?: string;
}

/** 分片续传实现：init → 逐片 → finish。任何一环失败都保留分片，下次可续。 */
async function createBackupChunked(
  server: ServerConfig | null,
  body: CreateBackupBody,
  payloadStr: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<number> {
  const key = uploadKey(payloadStr);
  const total = payloadStr.length;

  // ① init：服务端返回已收字节（断点续传的锚点）
  const initRes = await post<UploadInitResp>(server, '/api/user/uploads/init', {
    key,
    total,
    chunk_size: UPLOAD_CHUNK,
  });
  if (initRes.status === 404) throw new Error(UPLOAD_UNSUPPORTED);
  const init = initRes.data;
  if (!init || init.ok !== true) {
    throw new ApiError('http', init?.error ?? '上传初始化失败', initRes.status, init);
  }
  const chunkSize = init.chunk_size > 0 ? init.chunk_size : UPLOAD_CHUNK;
  const chunks = splitChunks(payloadStr, chunkSize);
  const startIndex = Math.floor((init.received || 0) / chunkSize);

  let sent = Math.min(init.received || 0, total);
  onProgress?.({ sent, total, pct: total ? Math.floor((sent / total) * 100) : 0 });
  writeUploadProgress(key, sent);

  for (let i = startIndex; i < chunks.length; i += 1) {
    const piece = chunks[i] ?? '';
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const r = await post<{ ok: boolean; received: number; error?: string }>(server, '/api/user/uploads/chunk', {
        key,
        index: i,
        data: toBase64(piece),
      });
      if (r.status === 404) throw new Error(UPLOAD_UNSUPPORTED);
      const d = r.data;
      if (d && d.ok === true) {
        sent = Math.min(total, (i + 1) * chunkSize);
        writeUploadProgress(key, sent);
        onProgress?.({ sent, total, pct: topicPct(sent, total) });
        break;
      }
      if (attempt >= 3) {
        throw new ApiError('http', d?.error ?? `第 ${i + 1} 片上传失败`, r.status, d);
      }
      await new Promise((res) => setTimeout(res, 400 * attempt));
    }
  }

  // ② finish：服务端拼接 + 校验 + 落库
  const fin = await post<CreateBackupResp>(server, '/api/user/uploads/finish', {
    key,
    label: body.label,
    item_count: body.item_count,
    device: body.device,
  });
  if (fin.status === 404) throw new Error(UPLOAD_UNSUPPORTED);
  const fd = fin.data;
  if (!fd || fd.ok !== true || typeof fd.id !== 'number') {
    throw new ApiError('http', fd?.error ?? '备份上传失败', fin.status, fd);
  }
  clearUploadProgress(key);
  return fd.id;
}

function topicPct(sent: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0;
}

/** 备份详情（payload 可能是对象或字符串，这里原样返回，交由 snapshot 层解析）。 */
export async function getBackup(server: ServerConfig | null, id: number | string): Promise<BackupDetail> {
  const res = await get<BackupDetailResp>(server, EP.backup(id));
  const data = res.data;
  if (!data || data.ok !== true || data.payload === undefined) {
    throw new ApiError('http', data?.error ?? '备份详情获取失败', res.status, data);
  }
  return { payload: data.payload as SnapshotPayload | string, label: data.label ?? '' };
}

/** 删除一份备份。 */
export async function deleteBackup(server: ServerConfig | null, id: number | string): Promise<void> {
  const res = await del<OkResp>(server, EP.backup(id));
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', res.data?.error ?? '备份删除失败', res.status, res.data);
  }
}
