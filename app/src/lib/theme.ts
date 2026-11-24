/**
 * 主题应用（只改 `data-theme` 与 meta theme-color，令牌全部走 CSS 变量）。
 */
export type ResolvedTheme = 'light' | 'dark';

/** 把解析后的主题写到 `<html data-theme>` 与状态栏颜色 meta。 */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#121513' : '#f4f5f3');

  // 同步原生状态栏（仅在 Capacitor 容器内生效）
  void syncStatusBar(theme);
}

/** 同步原生状态栏颜色（失败静默）。 */
async function syncStatusBar(theme: ResolvedTheme): Promise<void> {
  try {
    const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
    if (!w.Capacitor?.isNativePlatform?.()) return;
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light });
    await StatusBar.setBackgroundColor({ color: theme === 'dark' ? '#121513' : '#f4f5f3' });
  } catch {
    // 非原生或插件不可用：忽略
  }
}
