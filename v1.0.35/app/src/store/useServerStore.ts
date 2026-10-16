import { create } from 'zustand';
import { probeHealth } from '../api/server';
import { newServerId } from '../lib/id';
import { normalizeServerUrl } from '../lib/url';
import { nowISO } from '../lib/date';
import { ApiError } from '../lib/error';
import { getKV, setKV } from '../storage/kv';
import { K_SELFHOST, KV_SERVERS } from '../storage/keys';
import type { ProbeState, ServerConfig } from '../types/entities';

/**
 * 服务器 store：列表 / 当前 / 探测状态。
 *
 * 持久化：`flyme.kv.servers`（列表）+ `flyme.selfhost`（当前，与 Web 版兼容）。
 */

/** 切换服务器时的回调（由 `useAppStore` 注册为「清空登录态」）。 */
type ServerChangedHandler = (nextId: string | null) => void;
let serverChangedHandler: ServerChangedHandler | null = null;

/** 注册切换服务器回调。 */
export function setServerChangedHandler(fn: ServerChangedHandler | null): void {
  serverChangedHandler = fn;
}

interface ServerStoreState {
  servers: ServerConfig[];
  currentId: string | null;
  probeState: ProbeState;

  /** 冷启动读取。 */
  initServers: () => Promise<void>;
  /** 新增服务器（自动归一化地址），返回新建对象。 */
  add: (input: { alias?: string; url: string; note?: string }) => Promise<ServerConfig>;
  /** 更新（地址会被重新归一化）。 */
  update: (id: string, patch: Partial<Omit<ServerConfig, 'id'>>) => Promise<void>;
  /** 删除（若删的是当前则切到第一台）。 */
  remove: (id: string) => Promise<void>;
  /** 切换当前服务器（会触发 `serverChangedHandler` 清空 token）。 */
  setCurrent: (id: string | null) => Promise<void>;
  /** 探测连通性（默认探测当前服务器）。 */
  probe: (id?: string) => Promise<ProbeState>;
  /** 标记本次连接成功。 */
  markConnected: (id: string, ok: boolean) => Promise<void>;
}

function persistAll(servers: ServerConfig[], currentId: string | null): Promise<void[]> {
  const current = servers.find((s) => s.id === currentId) ?? null;
  return Promise.all([setKV(KV_SERVERS, servers), setKV(K_SELFHOST, current)]);
}

/** 取当前服务器（非 hook，供 api 层与 store 调用）。 */
export function currentServer(): ServerConfig | null {
  const { servers, currentId } = useServerStore.getState();
  return servers.find((s) => s.id === currentId) ?? null;
}

export const useServerStore = create<ServerStoreState>()((set, get) => ({
  servers: [],
  currentId: null,
  probeState: { kind: 'idle' },

  initServers: async () => {
    const servers = (await getKV<ServerConfig[]>(KV_SERVERS, null)) ?? [];
    const saved = await getKV<ServerConfig | null>(K_SELFHOST, null);
    let currentId = saved?.id && servers.some((s) => s.id === saved.id) ? saved.id : servers[0]?.id ?? null;
    if (!currentId && servers.length > 0) currentId = servers[0]?.id ?? null;
    set({ servers, currentId });
    if (servers.length > 0 && currentId !== saved?.id) await persistAll(servers, currentId);
  },

  add: async (input) => {
    const norm = normalizeServerUrl(input.url);
    if (!norm.ok) throw new ApiError('invalid_url', norm.reason ?? '地址格式不正确');
    const server: ServerConfig = {
      id: newServerId(),
      alias: (input.alias ?? '').trim() || '我的服务器',
      url: norm.url,
      note: input.note,
      createdAt: nowISO(),
    };
    const servers = [...get().servers, server];
    const currentId = get().currentId ?? server.id;
    set({ servers, currentId });
    await persistAll(servers, currentId);
    return server;
  },

  update: async (id, patch) => {
    const servers = get().servers.map((s) => {
      if (s.id !== id) return s;
      const next: ServerConfig = { ...s, ...patch, id: s.id };
      if (patch.url !== undefined) {
        const norm = normalizeServerUrl(patch.url);
        if (!norm.ok) throw new ApiError('invalid_url', norm.reason ?? '地址格式不正确');
        next.url = norm.url;
      }
      return next;
    });
    set({ servers });
    await persistAll(servers, get().currentId);
  },

  remove: async (id) => {
    const servers = get().servers.filter((s) => s.id !== id);
    const currentId = get().currentId === id ? servers[0]?.id ?? null : get().currentId;
    set({ servers, currentId });
    await persistAll(servers, currentId);
    // 删掉的正是当前服务器时通知上层清登录态
    if (get().currentId !== id || servers.length === 0) serverChangedHandler?.(currentId);
  },

  setCurrent: async (id) => {
    const prev = get().currentId;
    set({ currentId: id, probeState: { kind: 'idle' } });
    await persistAll(get().servers, id);
    if (prev !== id) serverChangedHandler?.(id);
  },

  probe: async (id) => {
    const target = id ? get().servers.find((s) => s.id === id) ?? null : currentServer();
    set({ probeState: { kind: 'probing' } });
    const state = await probeHealth(target);
    set({ probeState: state });
    if (target && state.kind === 'online') await get().markConnected(target.id, true);
    return state;
  },

  markConnected: async (id, ok) => {
    const servers = get().servers.map((s) =>
      s.id === id ? { ...s, lastOk: ok, lastConnectedAt: ok ? nowISO() : s.lastConnectedAt } : s,
    );
    set({ servers });
    await persistAll(servers, get().currentId);
  },
}));
