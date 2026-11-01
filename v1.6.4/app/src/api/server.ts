import { ApiError } from '../lib/error';
import logger from '../lib/log';
import { HEALTH_TIMEOUT_MS, get } from '../net/httpClient';
import type { HealthResp, SettingsResp } from '../types/api';
import type { ProbeState, ServerConfig } from '../types/entities';
import { EP } from './endpoints';

/**
 * 服务器相关接口。
 *
 * ★F3：`/api/health` 即使 DB 挂了也返回 `ok:true`，
 * 因此判定「在线」后必须再看 `db` 字段，决定绿点还是黄点。
 */

/** 探测服务器（§6.4 三态判定）。失败时返回 `{ kind:'error' }`，不抛错。 */
export async function probeHealth(server: ServerConfig | null): Promise<ProbeState> {
  if (!server) return { kind: 'idle' };
  try {
    const res = await get<HealthResp>(server, EP.health, undefined, HEALTH_TIMEOUT_MS);
    const data = res.data;
    if (res.status === 200 && data?.ok === true) {
      return { kind: 'online', dbOk: data.db !== false, serverTime: data.time ?? '' };
    }
    throw new ApiError('parse', '服务器已连通，但接口返回异常，请确认这是纳物服务端', res.status, data);
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError('network', '无法连接到服务器', undefined, e);
    logger.warn('server', 'probe failed', err.kind, err.message);
    return { kind: 'error', error: err };
  }
}

/**
 * 拉取站点设置。
 *
 * ★F2：该接口**需要登录**且不含站点名 → 引导页不要用它取品牌名，登录后（P2）再拉。
 */
export async function fetchSettings(server: ServerConfig | null): Promise<Record<string, unknown>> {
  if (!server) return {};
  const res = await get<SettingsResp>(server, EP.settings);
  return res.data?.settings ?? {};
}
