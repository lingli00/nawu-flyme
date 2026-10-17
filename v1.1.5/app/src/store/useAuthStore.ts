import { create } from 'zustand';
import * as authApi from '../api/auth';
import { nowISO } from '../lib/date';
import { ApiError, humanMessage } from '../lib/error';
import logger from '../lib/log';
import { setTokenProvider, setUnauthorizedHandler } from '../net/httpClient';
import { getKV, removeKV, setKV } from '../storage/kv';
import { K_USER } from '../storage/keys';
import type { ServerConfig, Session, SessionState } from '../types/entities';
import { currentServer, useServerStore } from './useServerStore';

/**
 * 登录态 store。
 *
 * - `sessionState`：`'unknown' | 'valid' | 'expired' | 'offline'`
 * - 401 由 `net/httpClient` 的 `setUnauthorizedHandler` 回调驱动 → `markExpired()`
 *   （**只清 token，保留本地业务数据与服务器配置**）
 */

interface AuthStoreState {
  session: Session | null;
  sessionState: SessionState;
  /** 登录/校验过程中的错误文案（可直接展示） */
  error: string;
  busy: boolean;

  /** 冷启动：读本地 session，若有 token 则校验。 */
  hydrateSession: () => Promise<void>;
  /** 登录。 */
  login: (email: string, password: string) => Promise<void>;
  /**
   * 注册（★F5 自适应）：先提交邮箱+密码，
   * 后端要求验证码时抛 `ApiError`（`requiresCode === true`）。
   */
  register: (email: string, password: string, code?: string) => Promise<void>;
  /** 发送验证码。 */
  sendCode: (email: string, purpose?: 'register' | 'reset') => Promise<void>;
  /** 重置密码。 */
  resetPassword: (email: string, code: string, newPassword: string) => Promise<void>;
  /** 修改密码。 */
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
  /** 主动校验 token（冷启动 / 切前台用）。 */
  verify: () => Promise<SessionState>;
  /** 登出（服务端 + 本地）。 */
  logout: () => Promise<void>;
  /** 401 回调：置为过期并清 token（保留本地数据）。 */
  markExpired: () => Promise<void>;
  /** 只清本地会话（切换服务器时用）。 */
  clearLocalSession: () => Promise<void>;
  /** 清空错误文案。 */
  clearError: () => void;
}

async function persistSession(session: Session | null): Promise<void> {
  if (session) await setKV(K_USER, session);
  else await removeKV(K_USER);
}

export const useAuthStore = create<AuthStoreState>()((set, get) => ({
  session: null,
  sessionState: 'unknown',
  error: '',
  busy: false,

  hydrateSession: async () => {
    const session = await getKV<Session>(K_USER, null);
    if (!session?.token) {
      set({ session: null, sessionState: 'unknown' });
      return;
    }
    set({ session, sessionState: 'valid' });
    // 后台校验，失败会把状态改成 expired / offline
    void get().verify();
  },

  login: async (email, password) => {
    set({ busy: true, error: '' });
    try {
      const server = currentServer();
      const session = await authApi.login(server, email.trim(), password);
      await persistSession(session);
      set({ session, sessionState: 'valid', busy: false, error: '' });
      if (server) await useServerStore.getState().markConnected(server.id, true);
    } catch (e) {
      set({ busy: false, error: humanMessage(e) });
      throw e;
    }
  },

  register: async (email, password, code) => {
    set({ busy: true, error: '' });
    try {
      const server = currentServer();
      const session = await authApi.register(server, {
        email: email.trim(),
        password,
        code,
      });
      await persistSession(session);
      set({ session, sessionState: 'valid', busy: false, error: '' });
      if (server) await useServerStore.getState().markConnected(server.id, true);
    } catch (e) {
      set({ busy: false, error: humanMessage(e) });
      throw e;
    }
  },

  sendCode: async (email, purpose = 'register') => {
    set({ busy: true, error: '' });
    try {
      await authApi.sendCode(currentServer(), email.trim(), purpose);
      set({ busy: false });
    } catch (e) {
      set({ busy: false, error: humanMessage(e) });
      throw e;
    }
  },

  resetPassword: async (email, code, newPassword) => {
    set({ busy: true, error: '' });
    try {
      await authApi.resetPassword(currentServer(), email.trim(), code, newPassword);
      set({ busy: false });
    } catch (e) {
      set({ busy: false, error: humanMessage(e) });
      throw e;
    }
  },

  changePassword: async (oldPassword, newPassword) => {
    set({ busy: true, error: '' });
    try {
      await authApi.changePassword(currentServer(), oldPassword, newPassword);
      set({ busy: false });
    } catch (e) {
      set({ busy: false, error: humanMessage(e) });
      throw e;
    }
  },

  verify: async () => {
    const { session } = get();
    if (!session?.token) {
      set({ sessionState: 'unknown' });
      return 'unknown';
    }
    try {
      const user = await authApi.me(currentServer());
      const next: Session = { ...session, user, savedAt: nowISO() };
      await persistSession(next);
      set({ session: next, sessionState: 'valid' });
      return 'valid';
    } catch (e) {
      const kind = e instanceof ApiError ? e.kind : 'network';
      if (kind === 'auth') {
        await get().markExpired();
        return 'expired';
      }
      // 网络不通：保留本地登录态，进入离线可用
      set({ sessionState: 'offline' });
      logger.warn('auth', '校验失败（网络），转为离线可用');
      return 'offline';
    }
  },

  logout: async () => {
    try {
      await authApi.logout(currentServer());
    } finally {
      await persistSession(null);
      set({ session: null, sessionState: 'unknown', error: '' });
    }
  },

  markExpired: async () => {
    await persistSession(null);
    set({ session: null, sessionState: 'expired' });
  },

  clearLocalSession: async () => {
    await persistSession(null);
    set({ session: null, sessionState: 'unknown', error: '' });
  },

  clearError: () => set({ error: '' }),
}));

/* ----------------------------------------------------------------------------
 * 与网络层的接线（token 注入 + 401 回调）
 * --------------------------------------------------------------------------*/

setTokenProvider(() => useAuthStore.getState().session?.token ?? null);

setUnauthorizedHandler(() => {
  const state = useAuthStore.getState();
  if (state.sessionState === 'expired') return;
  void state.markExpired();
});

/** 是否已登录（供路由守卫与自动备份判断）。 */
export function isLoggedIn(): boolean {
  return useAuthStore.getState().sessionState === 'valid' && Boolean(useAuthStore.getState().session?.token);
}

/** 当前服务器（重导出，便于页面只 import store）。 */
export function activeServer(): ServerConfig | null {
  return currentServer();
}
