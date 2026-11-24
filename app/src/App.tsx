import { Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Keyboard, type KeyboardResize } from '@capacitor/keyboard';
import AppRoutes, { routeElementFor } from './router';
import MainShell from './components/layout/MainShell';
import TabPaneFallback from './components/layout/PaneFallback';
import SplashOverlay from './components/SplashOverlay';
import { useAppStore } from './store/useAppStore';
import { useServerStore } from './store/useServerStore';
import { useSettingsStore } from './store/useSettingsStore';
import { isNative } from './net/env';
import { UiHost } from './components/ui/UiHost';
import { setHapticsEnabled } from './lib/haptics';
import { BrandMark } from './components/BrandMark';

/**
 * 键盘残留高度修复（v1.0.16，仅原生）。
 *
 * 症状（用户实机录屏）：输入法开着时退到后台再回来，页面上一半有内容、
 * 下一半空白、底部 Tab 挤到屏幕中部——Keyboard resize:'body' 模式下 body
 * 高度被键盘改写，恢复前台时没有还原。
 *
 * 修复：resume 时 ① 重设一次 resize 模式强制原生侧重新计算布局；
 * ② 显式把 body/html 高度复位并强制 reflow；③ 广播 resize 事件让依赖
 * 视口的功能（报表图表等）重算。
 *
 * ★v1.0.35 增强：v1.0.16 的单次 250ms 修复在部分机型上跑早了（原生布局
 * 尚未稳定，又被后续一帧写回收窄值），改为 250ms + 800ms 两拍；配合
 * MainActivity.onResume 的原生侧高度复位双保险，根治底部大留白。
 */
function useKeyboardResumeFix(): void {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const once = (delay: number): void => {
      window.setTimeout(() => {
        // ① 原生侧重应用 resize 模式（重算 WebView inset / body 高度）
        const mode = 'body' as KeyboardResize;
        Keyboard.setResizeMode({ mode }).catch(() => undefined);
        // ② JS 侧兜底：显式复位高度 + 强制 reflow
        for (const el of [document.body, document.documentElement]) {
          el.style.height = '';
        }
        document.body.style.minHeight = '100%';
        void document.body.offsetHeight; // 读 offset 强制同步重排
        // ③ 广播 resize（图表/虚拟键盘感知组件重算）
        window.dispatchEvent(new Event('resize'));
      }, delay);
    };
    const fix = (): void => {
      once(250);
      once(800);
    };
    const sub = CapApp.addListener('appStateChange', (s) => {
      if (s.isActive) fix();
    });
    return () => {
      void sub.then((h) => h.remove());
    };
  }, []);
}

/**
 * 浏览器端自动注册服务器：网页用户本来就是从服务器打开的页面，
 * 服务器地址就是当前站点 origin —— 让用户再手填 IP 毫无道理（App 端才需要）。
 * 模块级防重入：hydrate 后只尝试一次；彻底失败则回落离线模式（仍可用全部记账功能）。
 */
let autoServerOnce = false;
async function ensureBrowserServer(): Promise<void> {
  if (autoServerOnce) return;
  autoServerOnce = true;
  const { add } = useServerStore.getState();
  try {
    await add({ alias: '当前站点', url: window.location.origin });
  } catch {
    await useAppStore.getState().setOfflineMode(true);
  }
}

/**
 * 路由守卫（架构 §5.4 + 主理人拍板修订）：
 * - 未 hydrate → 启动骨架（App 根部处理）
 * - App 端：无服务器配置且未选择离线 → 引导页（真机不知道服务器在哪，必须让用户填）
 * - 网页端（浏览器）：绝不进引导页 —— 自动把当前站点注册为服务器，直接进应用；
 *   服务器管理仍可从「我的」页进入（App 场景保留）。
 * - **不再强制登录**：允许未登录离线使用全部记账功能，登录从「我的」页进入
 */
function RouteGuard({ children }: { children: ReactNode }): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const hydrated = useAppStore((s) => s.hydrated);
  const offlineMode = useAppStore((s) => s.offlineMode);
  const serverCount = useServerStore((s) => s.servers.length);
  const native = isNative();

  useEffect(() => {
    if (!hydrated) return;
    if (!native) {
      // 网页端：自动配置当前站点；若手动导航到引导页一律弹回首页
      if (serverCount === 0 && !offlineMode) void ensureBrowserServer();
      if (location.pathname.startsWith('/onboarding')) navigate('/home', { replace: true });
      return;
    }
    if (serverCount === 0 && !offlineMode) {
      navigate('/onboarding/server', { replace: true });
    }
  }, [hydrated, location.pathname, navigate, native, offlineMode, serverCount]);

  return <>{children}</>;
}

/** 冷启动骨架（hydrate 完成前；★v1.0.33 P2-12 起用自有字标）。 */
function BootSplash(): JSX.Element {
  return (
    <div className="min-h-screen bg-paper flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <BrandMark size={36} variant="mono" className="text-ink-3" />
        <div className="t-h3 text-ink-2">纳物</div>
        <div className="w-40 h-1 rounded bg-line overflow-hidden">
          <div className="h-full w-1/3 shimmer" />
        </div>
      </div>
    </div>
  );
}

/**
 * ★v1.8.1 性能：Tab 页取元素的**稳定引用**。
 *
 * 旧写法（v1.7.9 及以前）把内联箭头函数直接交给 MainShell：
 *   `tabPane={(path) => AppRoutes.find((r) => r.path === path)?.element ?? null}`
 * 每次 MainShell 重渲染（滑页 idx 变化、底栏折叠、拖动把手、更新提示…）都会生成
 * 新函数引用 → 子组件拿到「新 props」，且每次都新建 element 对象 → React 认为
 * 四个 pane 的子树都换了新 type，四个 Tab 页的渲染函数全部重执行一遍。
 * 这正是「一次滑动重渲染全部 4 页」的直接来源。
 *
 * 现在：
 *   · 查表改成模块级的 `routeElementFor`（Map，O(1)，见 router.tsx）；
 *   · `renderTabPane` 用 useCallback 固定引用（依赖为空）；
 *   · 元素本身是 router.tsx 里的模块级常量，引用恒定 —— 即使重渲染也是同一个对象，
 *     React 可以直接复用 fiber，不再重建子树。
 */
/**
 * ★v1.8.0 修正：这里**不能**是 `useCallback` —— 它原先写在模块顶层（组件之外），
 * Hook 在 React 渲染上下文之外执行 → `ReactCurrentDispatcher.current` 为 null →
 * 启动即抛 `Cannot read properties of null (reading 'useCallback')`，整站白屏。
 *
 * 改为模块级**普通函数**：它本身引用恒定（模块只求值一次），效果与 useCallback([]) 相同，
 * 而且不依赖 Hook 上下文。router 的 `routeElementFor` 是 Map 查表，element 也是模块级常量，
 * 因此四个 Tab 的 element 引用依然恒定，React 可复用 fiber，不会重渲染四棵页面树。
 */
function renderTabPane(path: string): ReactNode {
  return routeElementFor(path) ?? <TabPaneFallback />;
}

/**
 * App 根组件（v1.0.17）：
 * 路由 + 主壳（底部 4 Tab + FAB，按路径自动显隐）+ 全局 Toast / Dialog 宿主
 * + 品牌开屏动画（受 `settings.splash` 控制）+ 触觉反馈总开关（受 `settings.vibrate` 控制）。
 *
 * ★v1.8.1：最外层再套一层 Suspense —— 二级页（设置/备份/分类…）全部改成了
 * React.lazy，直接由 `<Routes>` 渲染，必须有个统一的兜底，否则懒加载的那一帧
 * 会是整屏空白（旧版没有 Suspense 时这些页面是同步 import，自然没有这个问题）。
 */
export default function App(): JSX.Element {
  const hydrated = useAppStore((s) => s.hydrated);
  const vibrate = useSettingsStore((s) => s.settings.vibrate);
  const splash = useSettingsStore((s) => s.settings.splash);
  useKeyboardResumeFix();

  // 震动开关注入 lib/haptics（lib 不能反向依赖 store，故用注入式）
  useEffect(() => {
    setHapticsEnabled(vibrate !== false);
  }, [vibrate]);

  const shell = hydrated ? (
    <RouteGuard>
      <MainShell tabPane={renderTabPane}>
        <Routes>
          <Route path="/" element={<Navigate to="/home" replace />} />
          {AppRoutes.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </MainShell>
      <UiHost />
    </RouteGuard>
  ) : (
    <BootSplash />
  );

  return (
    <>
      <Suspense fallback={<TabPaneFallback full />}>{shell}</Suspense>
      {splash !== false ? <SplashOverlay /> : null}
    </>
  );
}
