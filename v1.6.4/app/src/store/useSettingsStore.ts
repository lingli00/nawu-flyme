import { create } from 'zustand';
import { getKV, setKV } from '../storage/kv';
import { KV_SETTINGS } from '../storage/keys';
import { createDefaultSettings } from '../storage/seed';
import type { Settings, ThemeMode } from '../types/entities';

/**
 * 设置 store（含 AI 配置与 `lastBackupAt`）。
 *
 * 说明：`settings` 是快照的一部分，恢复备份时会被整体覆盖。
 */

interface SettingsStoreState {
  settings: Settings;
  loaded: boolean;
  /** 冷启动读取（缺失时用默认设置并落盘）。 */
  load: () => Promise<void>;
  /** 局部更新并持久化。 */
  update: (patch: Partial<Settings>) => Promise<void>;
  /** 整体替换（恢复备份用）。 */
  replace: (next: Settings) => Promise<void>;
  /** 记录一次备份时间（自动备份节流依据）。 */
  setLastBackupAt: (iso: string) => Promise<void>;
  /** 恢复默认设置。 */
  reset: () => Promise<void>;
}

/** 写入（失败不影响内存状态）。 */
async function persist(settings: Settings): Promise<void> {
  await setKV(KV_SETTINGS, settings);
}

export const useSettingsStore = create<SettingsStoreState>()((set, get) => ({
  settings: createDefaultSettings(),
  loaded: false,

  load: async () => {
    const saved = await getKV<Settings>(KV_SETTINGS, null);
    const settings = saved ? { ...createDefaultSettings(), ...saved } : createDefaultSettings();
    if (!saved) await persist(settings);
    set({ settings, loaded: true });
  },

  update: async (patch) => {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    await persist(next);
  },

  replace: async (next) => {
    const merged = { ...createDefaultSettings(), ...next };
    set({ settings: merged });
    await persist(merged);
  },

  setLastBackupAt: async (iso) => {
    await get().update({ lastBackupAt: iso });
  },

  reset: async () => {
    const defaults = createDefaultSettings();
    set({ settings: defaults });
    await persist(defaults);
  },
}));

/** 解析主题（system → 跟随系统）。 */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}
