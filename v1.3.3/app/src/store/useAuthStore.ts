import { create } from 'zustand';
import * as authApi from '../api/auth';
import { nowISO } from '../lib/date';
import { ApiError, humanMessage } from '../lib/error';
import logger from '../lib/log';
import { setTokenProvider, setUnauthorizedHandler } from '../net/httpClient';
import { getKV, removeKV, setKV } from '../storage/kv';
import { K_SESSIONS, K_USER } from '../storage/keys';
import type { ServerConfig, Session, SessionState } from '../types/entities';
import { currentServer, useServerStore } from './useServerStore';

/**
 * 登录态 store。
 *
 * ★v1.3.3 多服务器独立登录态：
 * - 会话按服务器 id 分别存进 `flyme.sessions`（`{ [serverId]: Session }`），
 *   同时把当前那台镜像到 `flyme.user`（Web 版/旧数据兼容）；
 * - 切换服务器 = 换一份会话（而不是清空），未登录的服务器就显示未登录，
 *   登录过的服务器直接恢复账号，不用再输一次密码；
 * - 同一台设备最多记 3 台服务器（见 useServerStore.add 的上限）。
 *
 * - `sessionState`：`'unknown' | 'valid' | 'expired' | 'offline'`
 * - 401 由 `net/httpClient` 的 `setUnauthorizedHandler` 回调驱动 → `markExpired()`
 *   （**只清 token，保留本地业务数据与服务器配置**）
 */

interface AuthStoreState {
  session: Session | null;
  sessionState: SessionState;
  /** 当前会话归属的服务器 id（切服务器时用来区分槽位）。 */
  sessionServerId: string | null;
  /** 登录/校验过程中的错误文案（可直接展示） */
  error: string;
  busy: boolean;

  /** 冷启动：读本地 session，若有 token 则校验。 */
  hydrateSession: () => Promise<void>;
  /** ★v1.3.3 切到另一台服务器的登录态（各服务器独立保存）。 */
  switchServer: (nextId: string | null) => Promise<void>;
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

/** 读整张「服务器 → 会话」表（防御式：坏数据当空表）。 */
async function loadSessionMap(): Promise<Record<string, Session>> {
  const raw = await getKV<Record<string, Session>>(K_SESSIONS, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, Session> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === 'object' && typeof (v as Session).token === 'string') out[k] = v as Session;
  }
  return out;
}

/**
 * 写当前服务器的会话：
 * - `flyme.user` 始终是「当前服务器」的镜像（旧版与 Web 版读这里）；
 * - `flyme.sessions[serverId]` 是这一台服务器自己的那份，切回来时用它恢复。
 */
async function persistSession(session: Session | null, serverId?: string | null): Promise<void> {
  const id = serverId ?? currentServer()?.id ?? null;
  if (session) await setKV(K_USER, session);
  else await removeKV(K_USER);
  if (!id) return;
  const map = await loadSessionMap();
  if (session) map[id] = session;
  else delete map[id];
  await setKV(K_SESSIONS, map);
}

export const useAuthStore = create<AuthStoreState>()((set, get) => ({
  session: null,
  sessionState: 'unknown',
  sessionServerId: null,
  error: '',
  busy: false,

  hydrateSession: async () => {
    const serverId = currentServer()?.id ?? null;
    const map = await loadSessionMap();
    // 旧数据迁移：map 里没有这台服务器、但 flyme.user 有会话 → 认作这台的
    const legacy = await getKV<Session>(K_USER, null);
    let session = (serverId ? map[serverId] : null) ?? null;
    if (!session && legacy?.token) {
      session = legacy;
      if (serverId) {
        map[serverId] = legacy;
        await setKV(K_SESSIONS, map);
      }
    }
    if (!session?.token) {
      set({ session: null, sessionState: 'unknown' });
      return;
    }
    set({ session, sessionState: 'valid' });
    // 后台校验，失败会把状态改成 expired / offline
    void get().verify();
  },

  /**
   * ★v1.3.3 切换服务器：把当前会话留在它自己的槽位，换出目标服务器那份。
   * 目标服务器没登录过 → 显示未登录（不清别的服务器的会话）。
   */
  switchServer: async (nextId) => {
    const prevId = get().sessionServerId;
    if (prevId === nextId) return;
    // 当前会话已随每次持久化写进 map；这里只需要取目标那份
    const map = await loadSessionMap();
    const next = nextId ? map[nextId] ?? null : null;
    await setKV(K_USER, next);
    if (!next?.token) {
      set({ session: null, sessionState: 'unknown', sessionServerId: nextId ?? null, error: '' });
      return;
    }
    set({ session: next, sessionState: 'valid', sessionServerId: nextId ?? null, error: '' });
    void get().verify();
  },

  login: async (email, password) => {
    set({ busy: true, error: '' });
    try {
      const server = currentServer();
      const session = await authApi.login(server, email.trim(), password);
      await persistSession(session, server?.id ?? null);
      set({ session, sessionState: 'valid', sessionServerId: server?.id ?? null, busy: false, error: '' });
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
      await persistSession(session, server?.id ?? null);
      set({ session, sessionState: 'valid', sessionServerId: server?.id ?? null, busy: false, error: '' });
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
      await persistSession(next, get().sessionServerId ?? currentServer()?.id ?? null);
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
      await persistSession(null, get().sessionServerId ?? currentServer()?.id ?? null);
      set({ session: null, sessionState: 'unknown', sessionServerId: currentServer()?.id ?? null, error: '' });
    }
  },

  markExpired: async () => {
    await persistSession(null, get().sessionServerId ?? currentServer()?.id ?? null);
    set({ session: null, sessionState: 'expired' });
  },

  clearLocalSession: async () => {
    await persistSession(null, get().sessionServerId ?? currentServer()?.id ?? null);
    set({ session: null, sessionState: 'unknown', sessionServerId: currentServer()?.id ?? null, error: '' });
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

/**
 * ★v1.3.3 列出「哪些服务器存着登录态」（服务器管理页打「已登录」标用）。
 * 只返回 serverId 与该服务器上的账号邮箱，永不返回 token。
 */
export async function readServerSessions(): Promise<Record<string, { email: string }>> {
  const map = await loadSessionMap();
  const out: Record<string, { email: string }> = {};
  for (const [id, s] of Object.entries(map)) {
    out[id] = { email: s.user?.email ?? '' };
  }
  return out;
}

/** 是否已登录（供路由守卫与自动备份判断）。 */
export function isLoggedIn(): boolean {
  return useAuthStore.getState().sessionState === 'valid' && Boolean(useAuthStore.getState().session?.token);
}

/** 当前服务器（重导出，便于页面只 import store）。 */
export function activeServer(): ServerConfig | null {
  return currentServer();
}
