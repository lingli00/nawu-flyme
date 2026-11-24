import { createElement, lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import PlaceholderPage from './pages/PlaceholderPage';
import PaneFallback from './components/layout/PaneFallback';


/**
 * 路由表（HashRouter，兼容 file:// 与 Capacitor 的 https://localhost 源）。
 *
 * ★v1.8.1 性能：**路由级代码分割**。
 *
 * 诊断结论：首包 1472 KB（gzip ~427 KB）里塞着 4 个 Tab 页（HomePage 1900+ 行、
 * LedgerPage、ReportPage、MePage）+ 全站 AI 逻辑 + dayjs + lucide。冷启动要等这
 * 一坨全部 parse/compile 完才有第一帧，而用户首屏只需要首页。
 *
 * 现在：
 *   · 4 个 Tab 页 + 其余二级页全部 `lazy(() => import(...))`，各自成 chunk；
 *   · 每个 lazy 元素外面包一层 `Suspense fallback={<PaneFallback />}`，
 *     保证「点进去 / 滑过去」的第一帧是有形状的骨架而不是空白；
 *   · 元素**只创建一次**（模块级常量）—— 这是关键：旧写法在 `App.tsx` 里用内联
 *     箭头函数 `(path) => AppRoutes.find(...)?.element`，每次 MainShell 重渲染都
 *     新建 element 对象，React 认为是新 type/新 key，于是 4 个页面全部重执行渲染函数。
 *     现在 `AppRoutes` 是模块级静态数组，element 引用恒定，`tabPane` 可以直接
 *     `useCallback` 稳定住。
 *
 * 路径本身不要改 —— PRD 与架构 §10.7 已约定为 kebab-case。
 */
export interface AppRoute {
  /** 路由路径（kebab-case，与架构 §10.7 一致） */
  path: string;
  /** 渲染元素 */
  element: ReactElement;
}

/** 把 lazy 组件包成「带骨架的普通元素」，保证任何时候都不会渲染出空白。 */
function page<P extends object>(Lazy: LazyExoticComponent<ComponentType<P>>): ReactElement {
  return createElement(Suspense, { fallback: createElement(PaneFallback) }, createElement(Lazy));
}

/** 非 Tab 的整页（二级页/引导页）：用全屏骨架兜底，风格与 Tab 页一致。 */
function screen<P extends object>(Lazy: LazyExoticComponent<ComponentType<P>>): ReactElement {
  return createElement(Suspense, { fallback: createElement(PaneFallback, { full: true }) }, createElement(Lazy));
}

/* —— 引导 / 账号（P01–P04） —— */
const ServerSetupPage = lazy(() => import('./pages/onboarding/ServerSetupPage'));
const LoginPage = lazy(() => import('./pages/onboarding/LoginPage'));

/* —— 连接 / 服务器管理（P05–P06） —— */
const ServerManagePage = lazy(() => import('./pages/ServerManagePage'));
const ServerEditPage = lazy(() => import('./pages/ServerEditPage'));

/* —— 四大 Tab（P07–P09 / P20）—— 首屏只需要 /home，其余按需拉 —— */
const HomePage = lazy(() => import('./pages/HomePage'));
const ReportPage = lazy(() => import('./pages/ReportPage'));
const LedgerPage = lazy(() => import('./pages/LedgerPage'));
const MePage = lazy(() => import('./pages/MePage'));

/* —— 记账 / 详情 —— */
const ManualRecordSheet = lazy(() => import('./pages/ManualRecordSheet'));
const AiAccessPage = lazy(() => import('./pages/AiAccessPage'));

/* —— 我的 / 数据（P21–P24） —— */
const WallPage = lazy(() => import('./pages/WallPage'));
const BackupPage = lazy(() => import('./pages/BackupPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const CategoryPage = lazy(() => import('./pages/CategoryPage'));
const RulePage = lazy(() => import('./pages/RulePage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));

/* —— 管理后台（v1.0.7 起并入统一代码库；v1.1.5 起入口改隐蔽路径 /flyme） —— */
const AdminPage = lazy(() => import('./pages/AdminPage'));

/* —— 兜底 —— */
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

/**
 * 路由表（模块级常量，element 引用恒定 —— 见文件头「性能」说明）。
 *
 * 已实现的页面直接挂真实组件（现在都是 lazy）；未实现的（物品详情/编辑、
 * 订阅编辑、分类管理等）暂留 Placeholder，后续迭代补齐。
 */
export const AppRoutes: AppRoute[] = [
  { path: '/onboarding/server', element: screen(ServerSetupPage) },
  // P02/P03/P04 合一：登录页内含 登录 / 注册 / 找回 三个 Tab
  { path: '/login', element: screen(LoginPage) },
  { path: '/register', element: screen(LoginPage) },
  { path: '/forgot', element: screen(LoginPage) },

  { path: '/servers', element: screen(ServerManagePage) },
  { path: '/servers/new', element: screen(ServerEditPage) },
  { path: '/servers/:id', element: screen(ServerEditPage) },

  // —— 主流程（P07–P13）——
  // 首页 = 物品 + 订阅 合一（对齐原版竞品）；旧路由全部重定向回来。
  { path: '/home', element: page(HomePage) },
  { path: '/overview', element: <Navigate to="/home" replace /> },
  { path: '/report', element: page(ReportPage) },
  { path: '/ledger', element: page(LedgerPage) },
  // ★v1.3.1：独立「AI 记一笔」页全链路移除，旧链重定向回首页
  //（对话式记录在任意页经加号「对话记一笔」/右滑手势唤起 SmartRecordDock）
  { path: '/ai', element: screen(AiAccessPage) },
  { path: '/ai/confirm', element: <Navigate to="/home" replace /> },
  { path: '/record', element: screen(ManualRecordSheet) },
  { path: '/record/:id', element: screen(ManualRecordSheet) },

  // —— 物品（P14–P16）：并入首页 HomePage；旧路由重定向 ——
  { path: '/goods', element: <Navigate to="/home" replace /> },
  { path: '/goods/new', element: <Navigate to="/home" replace /> },
  { path: '/goods/:id', element: <PlaceholderPage code="P15" title="物品详情" future="首页卡片点击弹出详情弹窗" /> },
  { path: '/goods/:id/edit', element: <PlaceholderPage code="P16" title="编辑物品" future="src/pages/GoodsEditPage.tsx" /> },

  // —— 订阅（P17–P19）：并入首页 HomePage「订阅」tab；旧路由重定向 ——
  { path: '/subs', element: <Navigate to="/home" replace /> },
  { path: '/subs/new', element: <Navigate to="/home" replace /> },
  { path: '/subs/:id', element: <PlaceholderPage code="P18" title="订阅详情" future="src/pages/SubEditPage.tsx" /> },
  { path: '/subs/:id/bills', element: <PlaceholderPage code="P19" title="订阅账单" future="src/pages/SubBillsPage.tsx" /> },

  // —— 我的 / 数据（P20–P24）——
  { path: '/me', element: page(MePage) },
  { path: '/wall', element: screen(WallPage) },
  { path: '/backup', element: screen(BackupPage) },
  { path: '/settings', element: screen(SettingsPage) },
  { path: '/profile', element: <PlaceholderPage code="P23" title="账号资料" future="src/pages/ProfilePage.tsx" /> },
  { path: '/categories', element: screen(CategoryPage) },
  { path: '/rules', element: screen(RulePage) },
  { path: '/account', element: screen(AccountPage) },

  // —— 管理后台（v1.0.7 起并入统一代码库；v1.1.5 起入口改隐蔽路径 /flyme）——
  // 界面上不再有「管理后台」按钮，需手动在地址栏输入 /#/flyme 进入（hash 路由）。
  { path: '/flyme', element: screen(AdminPage) },

  // —— 兜底（v1.1.7）：hash 路由里写了不存在的地址 → 品牌 404 页，不再空白 ——
  { path: '*', element: screen(NotFoundPage) },
];

/**
 * 路由表索引：path → element。
 * ★v1.8.1：把「按路径查页面元素」从事发时的线性 find（每次 MainShell 重渲染执行 4 次）
 * 变成一次性建表 + O(1) 查表；引用恒定，可直接喂给 useCallback。
 */
export const RouteElementByPath: ReadonlyMap<string, ReactElement> = new Map(
  AppRoutes.filter((r) => r.path !== '*').map((r) => [r.path, r.element]),
);

/** 取某个路径的页面元素（引用恒定，找不到返回 null）。 */
export function routeElementFor(path: string): ReactElement | null {
  return RouteElementByPath.get(path) ?? null;
}

/**
 * ★v1.8.2 邻页 chunk 预取：把某个 Tab 路径对应的 lazy chunk 提前 import 下来
 * （不渲染，只下载 + 解析；浏览器/Vite 会把模块缓存起来，二次 import 直接命中）。
 *
 * 为什么需要它：路由级代码分割后，邻页没挂载 = chunk 没请求；用户甩过那一页时才现下载，
 * 期间 Suspense 显示骨架 —— 在真机上就是「白屏一两秒」。这里在 idle 时把邻页 chunk
 * 提前拉热，甩过去时已在缓存里，直接有内容。
 *
 * 只覆盖主壳四大 Tab（分页器唯一会横向带出的页面）；其它页面走正常 lazy 即可。
 * 返回 Promise，失败静默（网络抖动时由页面的 RailSectionBoundary/Suspense 兜底）。
 */
const TAB_PREFETCH: Record<string, () => Promise<unknown>> = {
  '/home': () => import('./pages/HomePage'),
  '/ledger': () => import('./pages/LedgerPage'),
  '/report': () => import('./pages/ReportPage'),
  '/me': () => import('./pages/MePage'),
};

/** 已发起过预取的路径（避免重复 import 触发多余的网络/解析调度）。 */
const prefetched = new Set<string>();

export function prefetchRoute(path: string): Promise<unknown> {
  const load = TAB_PREFETCH[path];
  if (!load || prefetched.has(path)) return Promise.resolve(undefined);
  prefetched.add(path);
  try {
    return load();
  } catch {
    prefetched.delete(path);
    return Promise.resolve(undefined);
  }
}

export default AppRoutes;