import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { useAppStore } from './store/useAppStore';
import { isNative } from './net/env';
import ErrorBoundary from './components/ErrorBoundary';
import { installGlobalErrorCapture } from './lib/errlog';
import './index.css';

/**
 * 初始化原生插件（状态栏/键盘/返回键）。
 * 全部用动态 import + isNative() 守卫，保证浏览器 dev 环境不报错。
 */
async function initNativePlugins(theme: 'light' | 'dark'): Promise<void> {
  if (!isNative()) return;
  try {
    const [{ StatusBar, Style }, { Keyboard }, { App: CapApp }] = await Promise.all([
      import('@capacitor/status-bar'),
      import('@capacitor/keyboard'),
      import('@capacitor/app'),
    ]);
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light });
    await StatusBar.setBackgroundColor({ color: theme === 'dark' ? '#121513' : '#f4f5f3' });
    await Keyboard.setResizeMode({ mode: 'body' as never }).catch(() => undefined);
    await CapApp.removeAllListeners();
  } catch {
    // 插件不可用（浏览器 / 未安装）时静默降级，不影响业务
  }
}

/** 首屏骨架（★v1.0.30：hydrate 期间不再裸白屏）。 */
function BootSkeleton(): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-paper">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-line border-t-accent" />
      <p className="text-xs text-ink-3">纳物正在载入本地数据…</p>
    </div>
  );
}

/** 启动失败兜底（bootstrap 自身抛错时，不再永久白屏）。 */
function BootFatal({ msg }: { msg: string }): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-paper px-6 text-center text-ink">
      <p className="text-base font-medium">启动遇到问题</p>
      <p className="max-w-md break-all rounded-card bg-surface-2 px-3 py-2 text-left text-[11px] text-ink-2">{msg}</p>
      <button
        type="button"
        onClick={() => location.reload()}
        className="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-white active:scale-95"
      >
        重新加载
      </button>
    </div>
  );
}

/** 先挂载骨架（用户立刻看到界面），init 完成后再换 App。 */
function mount(node: React.ReactNode): void {
  const rootEl = document.getElementById('root');
  if (!rootEl) return;
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>{node}</ErrorBoundary>
    </React.StrictMode>,
  );
}

/** 冷启动：先迁移旧数据键 → hydrate 本地数据，再挂载 UI。 */
async function bootstrap(): Promise<void> {
  installGlobalErrorCapture();
  mount(<BootSkeleton />);

  try {
    // ★v1.0.26：旧 flyme.* localStorage 键一次性迁移到 flyme.*（必须在 hydrate 之前）
    const { migrateLegacyKeys } = await import('./storage/keys');
    migrateLegacyKeys();
    // ★v1.0.29：本地落盘失败（原生写队列被打爆等）时给用户明确反馈，
    // 而不是让 await addGoods() 无声挂起 —— 「入库失败」曾经没有任何提示。
    const { onRepoWriteError } = await import('./storage/repo');
    const { toastError } = await import('./store');
    onRepoWriteError(() => {
      toastError('本地保存失败，请重试一次');
    });
    const store = useAppStore.getState();
    await store.init();
    const theme = useAppStore.getState().theme;
    document.documentElement.setAttribute('data-theme', theme);
    void initNativePlugins(theme);

    mount(
      <HashRouter>
        <App />
      </HashRouter>,
    );
  } catch (e) {
    // ★v1.0.30：bootstrap 任何一步抛错都必须给出可见反馈 ——
    // 旧实现无 try/catch，init 失败 = 永久白屏（用户只能刷新且看不到任何原因）。
    console.error('bootstrap 失败', e);
    mount(<BootFatal msg={e instanceof Error ? `${e.name}: ${e.message}` : String(e)} />);
  }
}

void bootstrap();
