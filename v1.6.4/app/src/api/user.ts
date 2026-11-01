import { ApiError } from '../lib/error';
import { get, post } from '../net/httpClient';
import type { OkResp, ProfileResp, RulesResp } from '../types/api';
import type { ServerConfig } from '../types/entities';
import { EP } from './endpoints';

/**
 * 用户资料与自定义解析规则（对应 Web 版 `flyme.parse.rules`）。
 */

/** 读取自定义识别规则（本地键 `flyme.parse.rules` 的云端镜像）。 */
export async function getRules(server: ServerConfig | null): Promise<unknown> {
  const res = await get<RulesResp>(server, EP.rules);
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', res.data?.error ?? '规则获取失败', res.status, res.data);
  }
  return res.data.rules ?? null;
}

/** 保存自定义识别规则。 */
export async function saveRules(server: ServerConfig | null, rules: unknown): Promise<void> {
  const res = await post<OkResp>(server, EP.rules, { rules });
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', res.data?.error ?? '规则保存失败', res.status, res.data);
  }
}

/** 读取用户资料（昵称等）。 */
export async function getProfile(server: ServerConfig | null): Promise<Record<string, unknown>> {
  const res = await get<ProfileResp>(server, EP.profile);
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', res.data?.error ?? '资料获取失败', res.status, res.data);
  }
  return res.data.profile ?? {};
}

/**
 * 保存用户资料。
 *
 * ★v0.7.0：**扁平提交** `POST {display_name, avatar_url, plan}`——
 * 旧实现包了一层 `{ profile: {...} }`，而后端 `flyme_param('display_name')` 只读
 * 顶层参数，读到 null 存库，导致「昵称改了不保存」。后端已同时兼容两种形状。
 */
export async function saveProfile(
  server: ServerConfig | null,
  profile: Record<string, unknown>,
): Promise<void> {
  const res = await post<OkResp>(server, EP.profile, profile);
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', res.data?.error ?? '资料保存失败', res.status, res.data);
  }
}
