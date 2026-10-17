import { ApiError } from '../lib/error';
import { nowISO } from '../lib/date';
import { get, post } from '../net/httpClient';
import type { LoginResp, MeResp, OkResp, SendCodeResp } from '../types/api';
import type { ServerConfig, Session } from '../types/entities';
import { EP } from './endpoints';

/**
 * 认证接口。
 *
 * ★F5：
 * - 注册只在服务端 `requireVerified=true` 时才校验 `code`，且成功**直接返回 token**（自动登录）
 *   → 做成自适应流程：先提交邮箱+密码，后端要求验证码时抛 `requiresCode` 的 ApiError
 * - `reset` 用 `newPassword`；`changepassword` 用 `oldPassword` / `newPassword`
 */

/** 注册入参。 */
export interface RegisterArgs {
  email: string;
  password: string;
  /** 服务端要求验证码时再填 */
  code?: string;
}

/** 从登录/注册响应里提取会话；失败时抛带后端文案的 ApiError。 */
function toSession(res: { status: number; data: LoginResp }): Session {
  const data = res.data;
  if (!data || data.ok !== true) {
    throw new ApiError('http', data?.error ?? '账号或密码不正确', res.status, data);
  }
  if (!data.token || !data.user) {
    throw new ApiError('parse', '服务器返回内容缺少登录信息', res.status, data);
  }
  return { token: data.token, user: data.user, savedAt: nowISO() };
}

/** 登录。 */
export async function login(
  server: ServerConfig | null,
  email: string,
  password: string,
): Promise<Session> {
  const res = await post<LoginResp>(server, EP.login, { email, password });
  return toSession(res);
}

/**
 * 注册。
 *
 * 后端要求验证码时会抛 `ApiError`，其 `requiresCode === true`，
 * 注册页据此展开验证码步骤（先「发送验证码」，再带着 code 重新提交）。
 */
export async function register(server: ServerConfig | null, args: RegisterArgs): Promise<Session> {
  const body: Record<string, unknown> = { email: args.email, password: args.password };
  if (args.code) body.code = args.code;
  try {
    const res = await post<LoginResp>(server, EP.register, body);
    return toSession(res);
  } catch (e) {
    if (e instanceof ApiError && !e.requiresCode) {
      // 后端没有明确说「验证码」，但可能是同一语义（不同版本文案不同）
      if (/验证|verify|code/i.test(e.message ?? '')) {
        throw new ApiError(e.kind, e.message, e.status, e.raw, true);
      }
    }
    throw e;
  }
}

/** 发送验证码（注册 / 重置密码）。 */
export async function sendCode(
  server: ServerConfig | null,
  email: string,
  purpose: 'register' | 'reset' = 'register',
): Promise<void> {
  const res = await post<SendCodeResp>(server, EP.sendCode, { email, purpose });
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', res.data?.error ?? '验证码发送失败，请稍后重试', res.status, res.data);
  }
}

/** 重置密码（★字段名是 `newPassword`）。 */
export async function resetPassword(
  server: ServerConfig | null,
  email: string,
  code: string,
  newPassword: string,
): Promise<void> {
  const res = await post<OkResp>(server, EP.reset, { email, code, newPassword });
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', res.data?.error ?? '重置密码失败，请稍后重试', res.status, res.data);
  }
}

/** 校验 token（冷启动用）。 */
export async function me(server: ServerConfig | null): Promise<Session['user']> {
  const res = await get<MeResp>(server, EP.me);
  if (!res.data || res.data.ok !== true || !res.data.user) {
    throw new ApiError('http', res.data?.error ?? '登录态校验失败', res.status, res.data);
  }
  return res.data.user;
}

/** 登出（服务端失效 token；本地清理由 store 负责）。 */
export async function logout(server: ServerConfig | null): Promise<void> {
  try {
    await post<OkResp>(server, EP.logout);
  } catch {
    // 服务端登出失败不影响本地退出
  }
}

/** 修改密码（★字段名是 `oldPassword` / `newPassword`）。 */
export async function changePassword(
  server: ServerConfig | null,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const res = await post<OkResp>(server, EP.changePassword, { oldPassword, newPassword });
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', res.data?.error ?? '修改密码失败，请稍后重试', res.status, res.data);
  }
}
