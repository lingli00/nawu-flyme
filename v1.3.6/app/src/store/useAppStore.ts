import { create } from 'zustand';
import { applyTheme } from '../lib/theme';
import { getKV, setKV } from '../storage/kv';
import { K_UI } from '../storage/keys';
import { ensureSeeded, SEED_UI } from '../storage/seed';
import type { ThemeMode, UiState } from '../types/entities';
import { useAuthStore } from './useAuthStore';
import { useDataStore } from './useDataStore';
import { setServerChangedHandler, useServerStore } from './useServerStore';
import { resolveTheme, useSettingsStore } from './useSettingsStore';

/**
 * App 级 store：冷启动 hydrate + 主题 + 离线模式。
 *
 * 冷启动顺序（架构 §5.4）：
 * 1. 读 UI 偏好 → 2. 灌种子 → 3. 装 12 集合 → 4. 读设置 → 5. 读服务器列表
 * → 6. 有 token 则校验（成功 valid / 401 expired / 网络 offline）→ 7. hydrated = true
 */

interface AppStoreState {
  /** hydrate 完成前 UI 显示启动骨架 */
  hydrated: boolean;
  /** 解析后的实际主题（light / dark） */
  theme: 'light' | 'dark';
  /** 用户选择的主题模式 */
  themeMode: ThemeMode;
  /** 是否跳过登录、离线使用 */
  offlineMode: boolean;
  /** 冷启动异常文案 */
  bootError: string;

  /** 冷启动入口（main.tsx 调用一次）。 */
  init: () => Promise<void>;
  /** 切换主题（system / light / dark）。 */
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  /** 开关离线模式。 */
  setOfflineMode: (on: boolean) => Promise<void>;
  /** 记录最后访问路由。 */
  setLastRoute: (route: string) => Promise<void>;
}

async function persistUi(ui: UiState): Promise<void> {
  await setKV(K_UI, ui);
}

export const useAppStore = create<AppStoreState>()((set) => ({
  hydrated: false,
  theme: 'light',
  themeMode: 'system',
  offlineMode: false,
  bootError: '',

  init: async () => {
    try {
      // 1. UI 偏好
      const ui = (await getKV<UiState>(K_UI, null)) ?? { ...SEED_UI };
      set({ offlineMode: ui.offlineMode === true });

      // 2. 种子（分类 27 条 + 默认设置）
      await ensureSeeded();

      // 3. 12 个集合
      await useDataStore.getState().hydrateAll();

      // 4. 设置 + 主题
      await useSettingsStore.getState().load();
      const mode = useSettingsStore.getState().settings.theme;
      const theme = resolveTheme(mode);
      set({ themeMode: mode, theme });
      applyTheme(theme);

      // 5. 服务器列表
      await useServerStore.getState().initServers();

      // 6. 切换服务器 → 换出该服务器自己的登录态（★v1.3.3 不再清空）
      setServerChangedHandler((nextId) => {
        void useAuthStore.getState().switchServer(nextId);
      });

      // 7. 登录态校验（后台进行，不阻塞进入首页）
      void useAuthStore.getState().hydrateSession();

      set({ hydrated: true, bootError: '' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e ?? '');
      set({ hydrated: true, bootError: message || '本地数据初始化失败' });
    }
  },

  setThemeMode: async (mode) => {
    await useSettingsStore.getState().update({ theme: mode });
    const theme = resolveTheme(mode);
    set({ themeMode: mode, theme });
    applyTheme(theme);
  },

  setOfflineMode: async (on) => {
    const ui = (await getKV<UiState>(K_UI, null)) ?? { ...SEED_UI };
    const next: UiState = { ...ui, offlineMode: on };
    await persistUi(next);
    set({ offlineMode: on });
  },

  setLastRoute: async (route) => {
    const ui = (await getKV<UiState>(K_UI, null)) ?? { ...SEED_UI };
    await persistUi({ ...ui, lastRoute: route });
  },
}));

/** 是否已 hydrate（非 hook）。 */
export function isHydrated(): boolean {
  return useAppStore.getState().hydrated;
}

/** 重新应用主题（系统主题变化时调用）。 */
export function refreshTheme(): void {
  const mode = useSettingsStore.getState().settings.theme;
  const theme = resolveTheme(mode);
  useAppStore.setState({ theme, themeMode: mode });
  applyTheme(theme);
}
