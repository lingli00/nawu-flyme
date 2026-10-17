import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import PlaceholderPage from './pages/PlaceholderPage';
import ServerSetupPage from './pages/onboarding/ServerSetupPage';
import LoginPage from './pages/onboarding/LoginPage';
import ServerManagePage from './pages/ServerManagePage';
import ServerEditPage from './pages/ServerEditPage';
import HomePage from './pages/HomePage';
import ReportPage from './pages/ReportPage';
import LedgerPage from './pages/LedgerPage';
import AiPage from './pages/AiPage';
import ManualRecordSheet from './pages/ManualRecordSheet';
import MePage from './pages/MePage';
import WallPage from './pages/WallPage';
import BackupPage from './pages/BackupPage';
import SettingsPage from './pages/SettingsPage';
import CategoryPage from './pages/CategoryPage';
import RulePage from './pages/RulePage';
import AccountPage from './pages/AccountPage';
import AdminPage from './pages/AdminPage';

/**
 * 路由表（HashRouter，兼容 file:// 与 Capacitor 的 https://localhost 源）。
 *
 * 已实现的页面直接挂真实组件；未实现的（物品详情/编辑、订阅编辑、
 * 分类管理、账号资料）暂留 Placeholder，后续迭代补齐。
 * 路径本身不要改 —— PRD 与架构 §10.7 已约定为 kebab-case。
 */
export interface AppRoute {
  /** 路由路径（kebab-case，与架构 §10.7 一致） */
  path: string;
  /** 渲染元素 */
  element: ReactElement;
}

export const AppRoutes: AppRoute[] = [
  // —— 引导 / 账号（P01–P04）——
  { path: '/onboarding/server', element: <ServerSetupPage /> },
  // P02/P03/P04 合一：登录页内含 登录 / 注册 / 找回 三个 Tab
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <LoginPage /> },
  { path: '/forgot', element: <LoginPage /> },

  // —— 连接 / 服务器管理（P05–P06）——
  { path: '/servers', element: <ServerManagePage /> },
  { path: '/servers/new', element: <ServerEditPage /> },
  { path: '/servers/:id', element: <ServerEditPage /> },

  // —— 主流程（P07–P13）——
  // 首页 = 物品 + 订阅 合一（对齐原版竞品）；旧路由全部重定向回来。
  { path: '/home', element: <HomePage /> },
  { path: '/overview', element: <Navigate to="/home" replace /> },
  { path: '/report', element: <ReportPage /> },
  { path: '/ledger', element: <LedgerPage /> },
  { path: '/ai', element: <AiPage /> },
  // P11 结果确认已并入 AiPage（解析结果就地勾选确认）
  { path: '/ai/confirm', element: <Navigate to="/ai" replace /> },
  { path: '/record', element: <ManualRecordSheet /> },
  { path: '/record/:id', element: <ManualRecordSheet /> },

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
  { path: '/me', element: <MePage /> },
  { path: '/wall', element: <WallPage /> },
  { path: '/backup', element: <BackupPage /> },
  { path: '/settings', element: <SettingsPage /> },
  { path: '/profile', element: <PlaceholderPage code="P23" title="账号资料" future="src/pages/ProfilePage.tsx" /> },
  { path: '/categories', element: <CategoryPage /> },
  { path: '/rules', element: <RulePage /> },
  { path: '/account', element: <AccountPage /> },

  // —— 管理后台（v1.0.7 起并入统一代码库；服务器 /admin 直出本 SPA）——
  { path: '/admin', element: <AdminPage /> },
];

export default AppRoutes;
