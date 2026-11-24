import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { useAppStore } from './store/useAppStore';
import { isNative } from './net/env';
import ErrorBoundary from './components/ErrorBoundary';
import { installGlobalErrorCapture } from './lib/errlog';
import { bootSkin } from './lib/skin';
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
      <p className="max-w-md break-all rounded-card bg-surface-2 px-3 py-2 text-left text-micro text-ink-2">{msg}</p>
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

/**
 * ★v1.8.0 bug1：**单例 root**。
 *
 * 旧写法每次 mount() 都 `createRoot(rootEl)` —— root 容器被 createRoot 过两次
 * （实测控制台：`Warning: You are calling ReactDOMClient.createRoot() on a container
 * that has already been passed to createRoot()`）。两个 root 共用同一个 #root 时，
 * 后挂载的会整块替换前言，且旧 root 的 StrictMode 双提交、调度器与事件监听
 * 都会继续挂在同一棵 DOM 上 —— 这正是「载入后连续滑动会卡住几秒再恢复」里
 * 那一截额外主线程抖动的来源之一（滑动时每个 pane 都要与重复挂载的 fiber 树对齐）。
 *
 * 现在：只创建一次，之后一律 root.render() 切换内容；首帧的静态骨架（index.html
 * 里 .nw-boot）在首次 render 前显式移除，避免与 BootSkeleton 同屏。
 */
let appRoot: ReactDOM.Root | null = null;

function mount(node: React.ReactNode): void {
  const rootEl = document.getElementById('root');
  if (!rootEl) return;
  if (!appRoot) {
    // 静态首帧骨架（index.html 内联）交给 React 接管前先摘掉，避免两层骨架叠在一起
    rootEl.querySelector('.nw-boot')?.remove();
    appRoot = ReactDOM.createRoot(rootEl);
  }
  appRoot.render(
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
    // ★桌面外观皮肤（预览）：必须在首屏之前应用，避免浅色闪一下再变深色
    // ★v1.8.1：原来是 `await import('./lib/skin')` —— 模块本身就在首包内，
    // 动态 import 只是多让出一帧（Promise 微/宏任务 + 再走一次模块解析），
    // 冷启动白屏时长实测多 8~16ms。改成同步 import 后 bootSkin() 紧跟首帧骨架执行。
    bootSkin();
    // ★v1.0.26：旧 flyme.* localStorage 键一次性迁移到 flyme.*（必须在 hydrate 之前）
    const { migrateLegacyKeys } = await import('./storage/keys');
    migrateLegacyKeys();
    // ★v1.7.8：清掉历史遗留的「云端图缓存条目」（曾把 26 张云图又存回 KV ~1.9MB）。
    // 只跑一次（内部有标记位），失败静默 —— 不影响主流程。
    void import('./lib/iconCache')
      .then((m) => m.purgeCloudIconCache())
      .catch(() => undefined);
    // ★v1.0.29：本地落盘失败（原生写队列被打爆等）时给用户明确反馈，
    // 而不是让 await addGoods() 无声挂起 —— 「入库失败」曾经没有任何提示。
    const { onRepoWriteError } = await import('./storage/repo');
    const { toastError } = await import('./store');
    onRepoWriteError(() => {
      toastError('本地保存失败，请重试一次');
    });
    /* ★v1.7.7：localStorage 配额不足且清图标缓存重试仍失败 —— 必须明确告诉用户
       是「存储不足」而不是笼统的保存失败（否则用户不知道该去删图片/清缓存）。
       同一会话内只提示一次，避免写入重试把屏幕刷满 toast。 */
    const { onKvQuotaFailure } = await import('./storage/kv');
    let quotaWarned = false;
    onKvQuotaFailure(() => {
      if (quotaWarned) return;
      quotaWarned = true;
      toastError('本地存储不足，图片可能未保存');
      setTimeout(() => {
        quotaWarned = false;
      }, 60_000);
    });
    const store = useAppStore.getState();
    await store.init();
    /* 预览演示数据：仅在带过 ?demo=1 且本地为空时灌（已有数据一律不动） */
    const { seedDemoIfEmpty } = await import('./lib/demoSeed');
    await seedDemoIfEmpty();
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
