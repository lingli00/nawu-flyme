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

/** 上传一份备份，返回新备份 id。 */
export async function createBackup(
  server: ServerConfig | null,
  body: CreateBackupBody,
): Promise<number> {
  const res = await post<CreateBackupResp>(server, EP.backups, body);
  const data = res.data;
  if (!data || data.ok !== true || typeof data.id !== 'number') {
    throw new ApiError('http', data?.error ?? '备份上传失败', res.status, data);
  }
  return data.id;
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
