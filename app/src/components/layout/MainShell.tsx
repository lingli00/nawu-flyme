import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, ChevronLeft, ChevronRight, Home, Plus, ScrollText, Smartphone, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { APP_VERSION } from '../../lib/appVersion';
import { useMaskDismiss } from '../../lib/maskDismiss';
import { haptic } from '../../lib/haptics';
import { getSkin, type Skin } from '../../lib/skin';
import { checkAppUpdate } from '../../api/appUpdate';
import { useUiStore, currentServer } from '../../store';
import { isNative } from '../../net/env';
import { prefetchRoute } from '../../router';
import {
  markBootCheck,
  shouldBootCheck,
  dismissedVersion,
  dismissVersion,
  shouldPromptUpdate,
} from '../../lib/updatePrompt';
import { Download, X } from 'lucide-react';
/* ★v1.8.1 首包瘦身：RecordMenu 只在点「加号」时才打开，却经
   RecordMenu → QuickSheets → {HomePage, SubListPage, ManualRecordSheet, LifeSheets}
   把整棵首页/生活流依赖树（含 dayjs/lucide/AI 逻辑）静态拖进了首包 —— 这是入口
   chunk 719KB 的主因。改为 lazy：菜单未点开前不加载，首包只留一个轻量引用。 */
const RecordMenu = lazy(() => import('../RecordMenu'));
import PullToRefresh from '../ui/PullToRefresh';
import SkinBar from '../SkinBar';
import { BrandMark } from '../BrandMark';
import PaneFallback from './PaneFallback';
/* ★v1.8.1 首包瘦身：SmartRecordDock 内含全站 AI 逻辑（parseService/queryLocal/
   splitTasks/localParser/语音…），只在用户点「对话记一笔」时才需要。改为 lazy。 */
const SmartRecordDock = lazy(() => import('./SmartRecordDock'));

/**
 * 主壳（三端一码）：移动壳 = 悬浮玻璃底栏 + 微信式横向分页器；桌面壳 = 深绿侧边栏 + 宽内容区。
 *
 * ★v1.8.0 本轮 4 个实测 bug：
 *   bug1 首屏空白 / 滑动卡顿 → 首帧骨架提到 index.html、单例 root、邻页不预挂、
 *        Tab 页代码分割（各自 Suspense 骨架）、滚动停稳判定与吸附一并收敛；
 *   bug2 筛选栏冗余空白 → 内容层对齐 + 占位块由底栏实测高度驱动；
 *   bug3 底栏遮挡文字 → --nw-nav-occ 实测驱动的避让（pager 页 + 非 pager 页）；
 *   bug4 折叠很丑 → 底栏上沿的胶囊把手（可点可甩，属于底栏自身）。
 */

/**
 * 底栏占用高度口径：底栏实测高度 + 8px 间隙，写进 CSS 变量 --nw-nav-occ，
 * 供 .nw-pane-gap / .nw-page-gap 精确避让。
 * 不再用写死的 112px：底栏高度随安全区/屏宽/折叠态变化，写死值要么遮住最后一行
 * （实测 /report 遮 62px、/me 遮 80px），要么在矮屏上多出一大段空白。
 */
const NAV_GAP_PX = 20;
/**
 * ★v1.8.2 把手「轻点」的最大按住时长（ms）。
 * 超过它就只当作拖拽起点，不再触发折叠切换 —— 避免「按住想拖，结果被当成点了一下」。
 */
const DRAG_HOLD_MS = 700;

const NAV_OCC_VAR = '--nw-nav-occ';

/* ---------------- 主壳入口 ---------------- */

const TABS: Array<{ to: string; label: string; Icon: LucideIcon }> = [
  { to: '/home', label: '首页', Icon: Home },
  { to: '/ledger', label: '生活流', Icon: ScrollText },
  { to: '/report', label: '报表', Icon: BarChart3 },
  { to: '/me', label: '我的', Icon: User },
];

/** 这些路由属于主壳内页面，其余子页（详情/编辑/设置…）全屏显示。
 *  ★v1.0.35：/wall 移出——置物墙是从「我的」进入的子页，此前却是唯一
 *  带底部 TabBar 的子页，观感上不像「我的」里的小页面；移出后与其他
 *  子页（备份/分类/设置）一致：全屏 PageShell + 返回箭头。 */
const SHELL_PATHS = new Set(['/home', '/ledger', '/report', '/me']);

/**
 * 桌面上以「右侧抽屉」呈现的二级页。
 *
 * ★v1.1.8 修订：「我的」里六个功能入口点开后的页面，在**电脑网页端**改成右侧抽屉弹出
 * （原来是整页跳走，一下子铺满整个内容区）。手机端 / App 完全不受影响，仍是整页。
 * 用前缀匹配，/servers/new、/servers/:id 这类二级页也留在抽屉里。
 *
 * ★v1.7.6：把 /ai（AI 接入）与 /account（账号编辑）也纳入抽屉，与「置物墙/备份/分类/
 * 规则/服务器/设置」统一 —— 用户要求「跟页面中其他子页面一样，做成右边抽屉的效果，
 * 效果要统一」。这些页面本身都套 PageShell（自带返回栏），所以只需改这一处名单。
 */
const DRAWER_PATHS = ['/wall', '/backup', '/categories', '/rules', '/servers', '/settings', '/ai', '/account'];

function isRecordPath(p: string): boolean {
  return p === '/record' || p.startsWith('/record/');
}

function isDrawerPath(p: string): boolean {
  return DRAWER_PATHS.some((d) => p === d || p.startsWith(d + '/'));
}

/* ---------------- 壳模式偏好（手动切换手机版 / 电脑版） ---------------- */

export type ShellPref = 'auto' | 'pc' | 'mobile';
const PREF_KEY = 'gf.shellPref';
/** 底部导航收起状态（v1.1.4）。 */
const TABBAR_KEY = 'gf.tabbar.hidden';

function readPrefFromUrl(): ShellPref | null {
  try {
    const q = new URLSearchParams(window.location.search);
    const ui = q.get('ui');
    if (ui === 'pc' || ui === 'mobile') {
      localStorage.setItem(PREF_KEY, ui);
      q.delete('ui');
      const rest = q.toString();
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (rest ? '?' + rest : '') + window.location.hash,
      );
      return ui;
    }
  } catch {
    /* 隐私模式等场景忽略 */
  }
  return null;
}

export function getShellPref(): ShellPref {
  try {
    const saved = localStorage.getItem(PREF_KEY);
    if (saved === 'pc' || saved === 'mobile') return saved;
  } catch {
    /* ignore */
  }
  return 'auto';
}

/** 切换壳偏好并广播（移动端「我的」页与桌面侧边栏共用）。 */
export function setShellPref(p: 'pc' | 'mobile' | null): void {
  try {
    if (p) localStorage.setItem(PREF_KEY, p);
    else localStorage.removeItem(PREF_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('gf:shell-pref'));
}

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = (e: MediaQueryListEvent): void => setMatch(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [query]);
  return match;
}

/** 当前壳模式：'desktop' | 'mobile'（偏好强制 > 屏宽判定）。 */
export function useShellMode(): 'desktop' | 'mobile' {
  const wide = useMediaQuery('(min-width: 1024px)');
  const [pref, setPrefState] = useState<ShellPref>(() => {
    readPrefFromUrl();
    return getShellPref();
  });
  useEffect(() => {
    const fn = (): void => setPrefState(getShellPref());
    window.addEventListener('gf:shell-pref', fn);
    return () => window.removeEventListener('gf:shell-pref', fn);
  }, []);
  const desktop = pref === 'pc' ? true : pref === 'mobile' ? false : wide;
  return desktop ? 'desktop' : 'mobile';
}

/** 桌面外观皮肤（lib/skin.ts）——只影响桌面壳材质，手机端恒为 classic 观感。 */
function useSkin(): Skin {
  const [skin, setLocal] = useState<Skin>(() => getSkin());
  useEffect(() => {
    const fn = (): void => setLocal(getSkin());
    window.addEventListener('gf:skin', fn);
    return () => window.removeEventListener('gf:skin', fn);
  }, []);
  return skin;
}

/* ---------------- 样式常量 ---------------- */

/** 液态玻璃面板样式（iOS 26 Liquid Glass）：低不透明度 + 大半径模糊 + 高饱和 + 顶部内高光边缘。 */
export const GLASS_STYLE: CSSProperties = {
  background:
    'linear-gradient(to bottom, color-mix(in srgb, var(--surface) 52%, transparent), color-mix(in srgb, var(--surface) 66%, transparent))',
  border: '1px solid color-mix(in srgb, var(--surface) 55%, transparent)',
  boxShadow:
    'inset 0 1px 0 color-mix(in srgb, white 55%, transparent), inset 0 -1px 0 color-mix(in srgb, var(--line) 40%, transparent), 0 12px 36px rgba(0,0,0,0.14)',
  backdropFilter: 'blur(28px) saturate(180%)',
  WebkitBackdropFilter: 'blur(28px) saturate(180%)',
};

/** 分区级错误兜底：某个页面 chunk 拉不下来 / 渲染抛错时只坏这一块，壳与底栏仍在。 */
export class RailSectionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="nw-pane-fallback" data-full="true">
          <p className="px-2 text-center text-sm text-ink-2">这一页没加载成功</p>
          <button
            type="button"
            onClick={() => this.setState({ failed: false })}
            className="mx-auto mt-3 rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-white active:scale-95"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function MainShell({
  children,
  tabPane,
}: {
  children: ReactNode;
  /** 给分页器注入「按路径渲染整页」的能力（App 传 AppRoutes 里的元素）。 */
  tabPane?: (path: string) => ReactNode;
}): JSX.Element {
  const { pathname } = useLocation();
  const mode = useShellMode();
  // 把壳层状态写到 <html data-shell>，供 dt: 桌面变体判断
  useEffect(() => {
    document.documentElement.dataset.shell = mode === 'desktop' ? 'pc' : 'mobile';
    return () => {
      delete document.documentElement.dataset.shell;
    };
  }, [mode]);

  // 启动静默检查更新（仅 App；12h 节流）：命中就写进全局 store，由 UpdatePromptBar 提示
  useEffect(() => {
    if (!isNative()) return;
    const p = window.location.hash.replace(/^#/, '').split('?')[0];
    if (p === '/flyme' || p.startsWith('/flyme/')) return;
    if (!shouldBootCheck()) return;
    markBootCheck();
    // 延迟 3 秒：别跟启动加载、数据水合抢网络与 CPU
    const t = window.setTimeout(() => {
      void checkAppUpdate(currentServer())
        .then((target) => {
          if (target) useUiStore.getState().setPendingUpdate(target);
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearTimeout(t);
  }, [pathname]);
  // 管理后台独立全屏：不带主壳侧边栏/底栏，登录卡与内容才能真正居中
  if (pathname === '/flyme' || pathname.startsWith('/flyme/')) {
    return <div className="min-h-screen bg-paper text-ink">{children}</div>;
  }
  // 对话式智能记录入口：全局悬浮气泡（后台 /flyme 不带）
  return (
    <>
      <UpdatePromptBar />
      {mode === 'desktop' ? (
        <DesktopShell>{children}</DesktopShell>
      ) : (
        <MobileShell tabPane={tabPane}>{children}</MobileShell>
      )}
      <Suspense fallback={null}>
        <SmartRecordDock mode={mode} />
      </Suspense>
    </>
  );
}

/* ---------------- 桌面壳：深绿侧边栏 + 宽内容 ---------------- */

function DesktopShell({ children }: { children: ReactNode }): JSX.Element {
  const { pathname } = useLocation();
  const nav = useNavigate();
  const narrow = !useMediaQuery('(min-width: 1024px)');
  const inShell = SHELL_PATHS.has(pathname);
  const drawerPage = !inShell && isDrawerPath(pathname);
  const skin = useSkin();
  const rail = narrow ? 'w-14' : 'w-60';
  /** 主行动钮开「加号动作菜单」（与移动壳同一组件）。 */
  const [menuOpen, setMenuOpen] = useState(false);
  /** 玻璃皮肤下侧栏是浮起的圆角卡（离左边 12px），内容区要多让出这 12px。 */
  const sideWidth = narrow ? 56 : 240;
  const contentLeft = skin === 'glass' && !narrow ? sideWidth + 12 : sideWidth;

  /** 遮罩点击：只有「按下与抬起都在遮罩空白处」才关闭（见 lib/maskDismiss.ts）。 */
  const maskDismiss = useMaskDismiss(() => nav('/me'));

  /** 抽屉页：Esc 关闭（走回 /me，不依赖历史栈）。 */
  useEffect(() => {
    if (!drawerPage) return;
    const fn = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') nav('/me');
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [drawerPage, nav]);

  return (
    <div className="flex min-h-screen bg-paper text-ink">
      <aside
        className={'fixed inset-y-0 left-0 z-30 flex flex-col ' + rail}
        style={{ background: 'var(--side)', color: 'var(--side-ink)' }}
      >
        {/* 品牌（自有字标） */}
        <div className={'flex items-center ' + (narrow ? 'justify-center' : 'gap-2.5 px-5') + ' pt-6 pb-4'}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: 'var(--side-2)' }}>
            <BrandMark size={20} variant="mono" />
          </span>
          {!narrow ? (
            <span className="min-w-0">
              <span className="block text-base font-semibold leading-tight">纳物</span>
              <span className="block text-micro" style={{ color: 'var(--side-dim)' }}>
                NaWu
              </span>
            </span>
          ) : null}
        </div>

        {/* 记一笔（桌面主行动：开加号动作菜单，同移动壳） */}
        <div className={narrow ? 'px-2' : 'px-4'}>
          <button
            onClick={() => {
              void haptic('medium');
              setMenuOpen(true);
            }}
            aria-label="记一笔"
            className={
              'flex items-center bg-accent font-medium text-white transition-transform active:scale-95 ' +
              (narrow ? 'h-10 w-10 justify-center rounded-xl' : 'h-10 w-full justify-center gap-2 rounded-xl text-sm')
            }
          >
            <Plus size={18} strokeWidth={2.2} aria-hidden />
            {!narrow ? '记一笔' : null}
          </button>
        </div>

        {/* 主导航 */}
        <nav className={'mt-4 flex-1 ' + (narrow ? 'px-2' : 'px-3')}>
          {TABS.map((t) => (
            <SideItem key={t.to} {...t} narrow={narrow} />
          ))}
        </nav>

        {/* 底部：切手机版 / 版本 */}
        <div className={(narrow ? 'px-2' : 'px-3') + ' pb-4'}>
          <SideAction Icon={Smartphone} label="手机版网页" narrow={narrow} onClick={() => setShellPref('mobile')} />
          {!narrow ? (
            <p className="px-2 pt-3 text-micro" style={{ color: 'var(--side-dim)' }}>
              纳物网页版 v{APP_VERSION}
            </p>
          ) : null}
        </div>
      </aside>

      <div className="min-w-0 flex-1" style={{ paddingLeft: contentLeft }}>
        {inShell ? (
          <div className="nw-main">{children}</div>
        ) : drawerPage ? (
          <div
            className="nw-drawer-mask nw-glass-mask fixed inset-0 z-40 flex justify-end"
            style={{ left: contentLeft }}
            {...maskDismiss}
          >
            <div
              className="nw-drawer-enter ml-auto flex h-full w-full flex-col overflow-y-auto bg-surface"
              style={{
                maxWidth: 'var(--nw-drawer-w, 32rem)',
                boxShadow: '-18px 0 48px rgba(0,0,0,0.18)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {children}
            </div>
          </div>
        ) : isRecordPath(pathname) ? (
          <div className="mx-auto w-full max-w-3xl px-6 pb-20 pt-8">
            <div className="nw-pop-card overflow-hidden rounded-card border border-line bg-surface shadow-sm">
              {children}
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-6 pb-20 pt-8">{children}</div>
        )}
      </div>

      {menuOpen ? (
        <Suspense fallback={null}>
          <RecordMenu onClose={() => setMenuOpen(false)} />
        </Suspense>
      ) : null}
      <SkinBar />
    </div>
  );
}

function SideItem({ to, label, Icon, narrow }: { to: string; label: string; Icon: LucideIcon; narrow: boolean }): JSX.Element {
  return (
    <NavLink
      to={to}
      title={label}
      onClick={() => void haptic('select')}
      className={
        'mb-1 flex items-center rounded-xl text-sm transition-colors ' + (narrow ? 'h-10 justify-center' : 'h-11 gap-3 px-3')
      }
      style={({ isActive }) => ({
        background: isActive ? 'var(--side-2)' : 'transparent',
        color: isActive ? 'var(--side-ink)' : 'var(--side-dim)',
        fontWeight: isActive ? 600 : 400,
      })}
    >
      <Icon size={20} strokeWidth={1.8} aria-hidden />
      {!narrow ? label : null}
    </NavLink>
  );
}

function SideAction({ Icon, label, narrow, onClick }: { Icon: LucideIcon; label: string; narrow: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={label}
      className={
        'mb-1 flex w-full items-center rounded-xl text-sm transition-colors hover:bg-white/5 ' +
        (narrow ? 'h-10 justify-center' : 'h-10 gap-3 px-3')
      }
      style={{ color: 'var(--side-dim)' }}
    >
      <Icon size={20} strokeWidth={1.8} aria-hidden />
      {!narrow ? label : null}
    </button>
  );
}

/* ---------------- 移动壳：微信式横向分页器（四页签） ---------------- */

/**
 * ★v1.3.4 横滑第二次重做（用户反馈：手机上根本滑不动、没有「停在中途」的手感）。
 *
 * 为什么 v1.3.3 的写法在真机上失效：那一版用 pointer 事件 + 手动 translate。
 * 鼠标拖动是好的，但手指一碰，浏览器在判定「这是滚动手势」后会立刻派发
 * `pointercancel`（实测只走到 19.5px 就被取消），拖动状态随即作废 ——
 * 所以 App / 手机网页里四页纹丝不动。
 *
 * 现在把「跟手」交还给浏览器原生横向滚动：
 * - track 是 `overflow-x:auto` + `scroll-snap-type: x mandatory`：
 *   手指移多少跟多少（1:1），**可以停在两页中间**（无极悬停），松手才吸附；
 * - 每屏一个吸附点（`scroll-snap-align:start`），再加 `scroll-snap-stop: always`，
 *   一次最多翻一页，甩得再快也不会连跳——与微信的分页手感一致；
 * - 纵向滚动仍归每页自己的 `overflow-y:auto`，横竖不抢手势；
 * - 滚动停下后（`scrollend`，老内核回落 120ms 防抖）才把路由切到当前页，
 *   底栏高亮跟着走；点底栏则把 track 瞬时对齐到目标页。
 *
 * 每页各自滚动，切回来时滚动位置还在——这也是微信的行为。
 */

/** 滚动停止的兜底判定时长（ms）：scrollend 不可用的老内核靠这个防抖。 */
const SETTLE_MS = 120;

/** 左右滑动引导的「已看过」标记（看过一次后不再打扰）。 */
const SWIPE_GUIDE_KEY = 'gf.swipeGuide.seen';
/** 引导气泡自动消失时长（ms）。 */
const SWIPE_GUIDE_MS = 6000;

function MobileShell({
  children,
  tabPane,
}: {
  children: ReactNode;
  /** 由 App 注入：按路由路径取页面元素（避免主壳反向 import 页面造成循环依赖）。 */
  tabPane?: (path: string) => ReactNode;
}): JSX.Element {
  const { pathname } = useLocation();
  const nav = useNavigate();
  /** v1.1.4：底部导航可收起，状态记忆到 localStorage。 */
  const [barHidden, setBarHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TABBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleBar = (): void => {
    lastToggleRef.current = Date.now();
    void haptic('select');
    setBarHidden((v) => {
      const next = !v;
      try {
        localStorage.setItem(TABBAR_KEY, next ? '1' : '0');
      } catch {
        /* 隐私模式忽略 */
      }
      return next;
    });
  };

  /** 同 toggleBar，但直接给目标值（把手拖拽用：方向已决定开/关）。 */
  const setBarHiddenPersist = (hidden: boolean): void => {
    setBarHidden((prev) => {
      if (prev === hidden) return prev;
      try {
        localStorage.setItem(TABBAR_KEY, hidden ? '1' : '0');
      } catch {
        /* 隐私模式忽略 */
      }
      return hidden;
    });
  };

  /** 当前 Tab 索引（不在四大页时为 0）。 */
  const rawIdx = TABS.findIndex((t) => t.to === pathname);
  const idx = rawIdx < 0 ? 0 : rawIdx;

  /**
   * ★v1.8.2 「跟手滑动」恢复：只预挂「当前页 + 左右邻页」（不是全部四页）。
   *   idx=0 → [0,1]；idx=3 → [2,3]；其余 → [idx-1, idx, idx+1]。
   *
   * 为什么只挂邻页而不是全挂：旧版（v1.8.0）为了修「一次滑动重渲染四页卡几秒」把邻页全删了，
   * 结果滑动时邻页是纯空白 section —— 用户拖到 50% 只能看到「一半当前页 + 一半空白」。
   * 真正的问题是「一次重渲染触发四页全部重执行」，解法是 React.memo 隔离（见 4 个页面组件），
   * 不是不渲染。现在既保留邻页真实内容，又靠 memo 把重渲染限制在「新挂载的那一页」。
   *
   * 为什么邻页有内容就「跟手」：track 是原生横向滚动（.nw-pager-track 的 scroll-snap），
   * pane 按 flex:0 0 100% 排布，浏览器原生滚动天然 1:1 跟手、可停在两页中间 —— 不需要
   * （也不能）改回 JS 手动 translate（真机会被 pointercancel 打断，见文件头注释）。
   */
  /**
   * ★v1.8.5 「访问过就保持挂载」：修「快速甩回旧页空白」。
   *
   * v1.8.2 只挂「当前 + 邻页」→ 从第 4 页甩回第 1 页时，途经的第 3/2 页从没挂载过、
   * 现挂现渲染 → 空白一两秒（用户实测）。而 4 个页面都被 React.memo 包了，
   * 一次 idx 变化**不会**让已挂载页重执行渲染 —— 所以「访问过的页一直留着」几乎零成本。
   *
   * 规则：当前页 + 邻页（滑过去时有内容跟手）∪ 历史上访问过的所有页（甩回来立即有内容）。
   * 首次进入时 visited 只有首页，行为与之前一致，不增加首屏挂载成本。
   */
  const visitedRef = useRef<Set<number>>(new Set<number>([idx]));
  useEffect(() => {
    visitedRef.current.add(idx);
  }, [idx]);
  const shouldMount = useCallback(
    (i: number): boolean => {
      if (visitedRef.current.has(i)) return true;
      if (i === idx) return true;
      if (idx === 0) return i === 1;
      if (idx === TABS.length - 1) return i === idx - 1;
      return i === idx - 1 || i === idx + 1;
    },
    [idx],
  );

  /**
   * ★v1.8.2 邻页 chunk 预取：挂载后 idle 时把左右邻页的 lazy chunk 提前拉热。
   * 不渲染、只下载 + 解析；甩过去时模块已在缓存里，Suspense 不再白屏一两秒。
   * 用 requestIdleCallback（无则回落 setTimeout 300ms），不跟首屏的水合/首帧抢主线程。
   */
  useEffect(() => {
    /**
     * ★v1.8.5 修「快速甩回旧页空白」：**首次挂载就把全部 4 个 Tab chunk 预取**，
     * 而不是只预取邻页、也不是每次 idx 变化才跑。
     *
     * 用户场景：从第 1 页连续甩到第 4 页没问题（邻页一直有预取），
     * 但反过来从第 4 页甩回第 1 页时，途经的第 3/2 页既没挂载、也没预取（idx 快速跳变，
     * 邻页预取根本跟不上）→ 那两页 chunk 冷启动 → 空白一两秒。
     *
     * 4 个 Tab chunk 合计才 ~140KB（Home 80 + Report 32 + Ledger 18 + Me 8），
     * 首屏 idle 时一次全拉下来成本极低，换来「任何方向、多快甩过去都不空白」。
     * 用 requestIdleCallback（无则 setTimeout 800ms）避开首屏水合与首帧。
     */
    const run = (): void => {
      for (const t of TABS) void prefetchRoute(t.to);
    };
    type IdleCb = (cb: () => void, opts?: { timeout: number }) => number;
    const ric = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback;
    if (typeof ric === 'function') {
      const id = ric(run, { timeout: 1500 });
      const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      return () => {
        if (typeof cic === 'function') cic(id);
      };
    }
    const t = window.setTimeout(run, 800);
    return () => window.clearTimeout(t);
    // 只跑一次：全量预取后所有 Tab chunk 都在缓存里，与 idx 无关。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 下拉刷新：四大 Tab 页顶部下拉 → 触发一次同步（未登录时引擎自动短路）。 */
  const handlePullRefresh = useCallback(async (): Promise<void> => {
    try {
      const m = await import('../../sync/engine');
      await Promise.race([
        m.syncNow('pull-refresh'),
        new Promise<void>((r) => window.setTimeout(r, 6000)),
      ]);
    } catch {
      /* 失败由引擎状态与 Toast 呈现，这里不打扰 */
    }
  }, []);

  /* ---------- 滑动引导：新用户首次进入四大页时出现一次 ---------- */

  const [guideOpen, setGuideOpen] = useState(false);

  const dismissGuide = (): void => {
    setGuideOpen(false);
    try {
      localStorage.setItem(SWIPE_GUIDE_KEY, '1');
    } catch {
      /* 隐私模式忽略 */
    }
  };

  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(SWIPE_GUIDE_KEY) === '1';
    } catch {
      seen = false;
    }
    if (seen) return;
    // 延迟一拍：等页面进入动画结束再浮现，避免和新页面一起「炸」出来
    const t = window.setTimeout(() => setGuideOpen(true), 800);
    return () => window.clearTimeout(t);
  }, []);

  // 出现后 6 秒自动收起（用户已经在看别的了，别一直挂着）
  useEffect(() => {
    if (!guideOpen) return;
    const t = window.setTimeout(() => dismissGuide(), SWIPE_GUIDE_MS);
    return () => window.clearTimeout(t);
  }, [guideOpen]);

  /* ---------- 分页器：原生横向滚动 + 吸附 ---------- */

  const trackRef = useRef<HTMLDivElement | null>(null);
  /** 手指是否还在屏上：拖动中不改路由，免得和手指抢滚动位置。 */
  const touching = useRef(false);
  /** 滚动停止的合并定时器（scrollend 的兜底）。 */
  const settleTimer = useRef(0);
  const idxRef = useRef(idx);
  idxRef.current = idx;

  /** 把路由切到「滚动停下来的那一页」；滚动未停或手指还在屏上时不动。 */
  const commitRef = useRef<() => void>(() => undefined);
  commitRef.current = (): void => {
    const el = trackRef.current;
    if (!el || touching.current) return;
    const w = el.clientWidth || 1;
    const i = Math.max(0, Math.min(TABS.length - 1, Math.round(el.scrollLeft / w)));
    if (i === idxRef.current) return;
    const target = TABS[i];
    if (!target) return;
    dismissGuide();
    void haptic('select');
    nav(target.to);
  };

  /**
   * ★v1.8.0 性能：邻页不再预挂（原 idx±1 的 setMounted 已删除）。
   *
   * 旧实现首页一出来就在同步 effect 里把左右邻页加进 mounted，等于冷启动就要构建
   * HomePage/LedgerPage/ReportPage/MePage 四棵页面树（含图表、长列表、store 订阅、
   * 图片签名），滑动时每个 pane 都要参与布局与重排 —— **实测正是「连续滑动后定格
   * 10 帧」的来源**（录屏 13s–22s 画面完全静止）。
   * 现在同屏只挂当前页：第 2 页起在 0.28s 吸附动画结束后、路由切换的这一帧才挂载，
   * 不再在启动期与滑动期重复付出 4× 的挂载/布局成本。
   */

  /** 路由变化 → track 瞬时对齐到目标页（点底栏、返回、深链都走这里）。
   *
   * ★v1.8.0：补了第二重的「回弹自愈」——
   * 吸附动画把 scrollLeft 写回「路由所在页」时会再触发一次 scroll，
   * 若那一刻手指刚落、touching 已置 false，兜底定时器就会把粘性目标页的判定
   * 当作一次新的滑动（表现为「滑到一半弹回去」，jsdom 单测里曾直接吞掉一次切页）。
   * 先把 scrollLeft 对齐再清标记，下一帧的重算不会把目标页判错。 */
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const w = el.clientWidth;
    if (!w) return;
    const target = idx * w;
    if (Math.abs(el.scrollLeft - target) > 1) el.scrollLeft = target;
    // ★v1.8.4 路由切换后把指示块也归位到整数页（避免点底栏后卡在半格）
    setScrollProgress(idx);
  }, [idx]);

  /** 旋转 / 键盘 / 窗口尺寸变化后重新对齐，避免停在两页中间。 */
  useEffect(() => {
    const onResize = (): void => {
      const el = trackRef.current;
      if (!el || !el.clientWidth) return;
      el.scrollLeft = idxRef.current * el.clientWidth;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /** 滚动结束判定：新内核走 scrollend，老内核靠 onScroll 的防抖兜底。 */
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const end = (): void => commitRef.current();
    el.addEventListener('scrollend', end);
    return () => el.removeEventListener('scrollend', end);
  }, []);

  /** 合并式「滚动停稳后再判定」：动画中不断有 scroll 事件，定时器会被反复重置。 */
  const scheduleCommit = (ms: number = SETTLE_MS): void => {
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => commitRef.current(), ms);
  };

  /**
   * ★v1.8.4 底栏「液态玻璃」高亮块跟手滑动。
   *
   * 用户要求：切换 Tab 时高亮块要跟着页面滚动一起平移（滑到哪、它就滚到哪；暂停它也停），
   * 而不是松手才硬切过去。
   *
   * 用 `scrollLeft / clientWidth` 得到**连续的浮点页索引**（0.0 ~ 3.0，含小数），
   * 底栏据此把指示块 `translateX(progress * tabW)` —— 与原生滚动同帧，天然一致。
   * 用 state 存是因为底栏是独立子树，必须经渲染把位移传给指示块；
   * 为免每帧都 setState 抖动，值变化 < 0.001 才跳过。
   */
  const [scrollProgress, setScrollProgress] = useState(idx);
  const onTrackScroll = (): void => {
    const el = trackRef.current;
    if (el && el.clientWidth) {
      const p = el.scrollLeft / el.clientWidth;
      setScrollProgress((prev) => (Math.abs(prev - p) < 0.001 ? prev : p));
    }
    scheduleCommit();
  };

  useEffect(
    () => () => {
      if (settleTimer.current) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  /* ---------- bug3：底栏占用高度实测（写进 --nw-nav-occ） ---------- */

  const navRef = useRef<HTMLElement | null>(null);
  /** 折叠态底栏的底边距：只把把手那 10px 露在屏幕底下沿（手势条区域之内）。 */
  /**
   * ★v1.8.1 折叠态位移（修用户反馈「往下沉一点有什么用」）：
   *
   * 旧值 `calc(env(safe-area-inset-bottom) - 12px)` 在 `env()` 为 0 时等于 **-12px** ——
   * 72px 高的底栏只下移 12px，还剩 60px 挂在屏幕里，**内容照样被挡**，等于没折叠。
   *
   * 正确做法：把整个底栏**推出视口**，只留把手的上半截露在屏幕底沿（可点击/可上甩）。
   * `--nw-nav-h` 是底栏实测高度（见 navOcc 的 read()），未测得时回落到 72px。
   * 露出的部分 = GRIP_REVEAL：把手 22px 高、居中在底栏上沿 -10px 处，
   * 因此底栏要下沉 (navH - 10) 才让把手的下沿停在屏幕底边之上一点点。
   */
  const GRIP_REVEAL = 14; // 折叠后把手露出的高度（px）
  const collapsedBottom = `calc(-1 * max(0px, var(--nw-nav-h, 72px) - ${GRIP_REVEAL}px))`;
  /**
   * 占用高度 = 底栏实测高度 + 8px 间隙。用 ResizeObserver 跟随安全区/字重/旋转变化。
   *
   * 不再依赖写死的 112px（那个值在 390×844 上多了 20px，在矮屏上又不够）；
   * 默认 0：底栏还没量到时 gap 按 0 计算，绝不会凭空多出一段可滑空白。
   */
  const [navOcc, setNavOcc] = useState(0);
  /** 底栏实测高度（px）——折叠位移用，与 navOcc（占用高度，折叠时为 0）分开。 */
  const [navH, setNavH] = useState(72);
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const read = (): void => {
      const h = Math.round(el.getBoundingClientRect().height);
      // 底栏实测高度单独记一份：折叠位移（collapsedBottom）要用它算「推出视口」的距离。
      setNavH((prev) => (prev === h ? prev : h));
      setNavOcc((prev) => {
        // ★v1.8.1：折叠态占用**归零**（旧值留了 10px 幽灵空格）。
        // 折叠后底栏已整体推出视口，页面底部不该再为它留任何空间。
        const next = barHidden ? 0 : h + NAV_GAP_PX;
        return prev === next ? prev : next;
      });
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [barHidden]);

  const occStyle: CSSProperties = useMemo(
    () =>
      ({
        [NAV_OCC_VAR]: navOcc + 'px',
        '--nw-nav-h': navH + 'px',
      }) as CSSProperties,
    [navOcc, navH],
  );

  /* ---------- bug4：底栏上沿「胶囊把手」——可点、可甩 ---------- */

  /** 拖动中的位移（>0 = 被往下拽，即收起方向）。0 表示静止（用 CSS transition 归位）。 */
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  /**
   * 拖拽会话（可变对象，不经渲染）：id = 当前按下的 pointerId（-1 表示未按下）；
   * moved = 本次手势是否已越过 3px 阈值。用 ref 而非 state：pointerup 里必须读到
   * 「本手势的」位移，不能依赖尚未提交的 setState（曾因此让一次正常拖拽判空）。
   */
  const dragStart = useRef<{ y: number; id: number; moved: boolean }>({ y: 0, id: -1, moved: false });
  /** 本次手势已构成拖拽 → 吞掉随后那一次尾巴 click。 */
  const draggedRef = useRef(false);
  /** 按下时刻（ms）——用于区分「轻点」与「长按后拖拽」。 */
  const t0Ref = useRef(0);
  /** touch 通道的按下信息（与 pointer 独立）。 */
  const touchStartRef = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);
  /** 最近一次「切换折叠」的时刻（ms）——pointer / touch 双通道去重。 */
  const lastToggleRef = useRef(0);

  /** 每次 pointermove / 松手读到的 dy（不依赖渲染闭包，避免 setState 异步导致判定漏读）。 */
  const dragDyRef = useRef(0);

  const onGripDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const st = dragStart.current;
    st.y = e.clientY;
    st.id = e.pointerId;
    st.moved = false;
    t0Ref.current = Date.now();
    draggedRef.current = false;
    dragDyRef.current = 0;
    /**
     * ★v1.8.2 不在 pointerdown 里 `setPointerCapture`。
     *
     * 真机（Capacitor Android WebView）实测：一旦捕获指针，浏览器就不再向该元素派发
     * `click` —— 于是把手「点了完全没反应」（用户的报障原话）。
     * 现在改为：不捕获，靠下面 onGripUp 自己判断「短按且没移动 = 点击」，
     * 移动超过阈值才算拖拽。这样点击与拖拽互不干扰，也不依赖 click 事件。
     */
  };

  const onGripMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const st = dragStart.current;
    if (st.id !== e.pointerId) return;
    // 折叠态只能往上甩（展开），展开态只能往下甩（收起）
    const raw = e.clientY - st.y;
    const dy = barHidden ? Math.min(0, raw) : Math.max(0, raw);
    dragDyRef.current = dy;
    if (Math.abs(dy) > 3 && !st.moved) {
      st.moved = true;
      draggedRef.current = true;
      setDragging(true);
    }
    if (st.moved) setDragY(dy);
  };

  /** 按「当前测得的位移」决定收/展：松手与 pointercancel 共用（cancel 不提交）。 */
  const endGripDrag = (commit: boolean): void => {
    const st = dragStart.current;
    const dy = dragDyRef.current;
    const moved = st.moved;
    st.id = -1;
    setDragging(false);
    setDragY(0);
    dragDyRef.current = 0;
    if (!commit || !moved) return;
    void haptic('select');
    // 阈值 18px：一次轻甩就该生效，但不会被误触。
    // 方向即语义：展开态往下甩 → 收起；折叠态往上甩 → 展开；位移不够则什么都不做。
    if (barHidden && dy <= -18) setBarHiddenPersist(false);
    else if (!barHidden && dy >= 18) setBarHiddenPersist(true);
    // 让紧随其后的 click 不要再翻转一次（窗口比 transition 略长，避免尾巴点击）
    window.setTimeout(() => {
      draggedRef.current = false;
    }, 340);
  };

  const onGripUp = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const st = dragStart.current;
    if (st.id !== e.pointerId) return;
    const moved = st.moved;
    const held = Date.now() - t0Ref.current;
    endGripDrag(true);
    /**
     * ★v1.8.2 点击自己判定（不依赖 onClick，见 onGripDown 的说明）。
     * 条件：没变成拖拽（位移 <3px）且按住时长 < DRAG_HOLD_MS —— 就是一次正常轻点。
     * 这样「点一下收起 / 再点一下弹出」在真机上一定生效。
     */
    if (!moved && held < DRAG_HOLD_MS) {
      toggleBar();
    }
  };
  const onGripCancel = (): void => endGripDrag(false);

  /* ★v1.8.3 touch 通道：真机 WebView 里 pointer 事件可能不派发，touch 一定派发。
     这里独立做一次「轻点即切换」，用 toggleStampRef 与 pointer 通道去重（同一次点击只翻一次）。 */
  const onGripTouchStart = (e: React.TouchEvent<HTMLButtonElement>): void => {
    const t = e.touches[0];
    if (!t) return;
    touchStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now(), moved: false };
  };
  const onGripTouchEnd = (e: React.TouchEvent<HTMLButtonElement>): void => {
    const st = touchStartRef.current;
    touchStartRef.current = null;
    if (!st) return;
    // 用 changedTouches 判断是否有移动（松手时 touches 为空）
    const ct = e.changedTouches[0];
    const moved = ct ? Math.hypot(ct.clientX - st.x, ct.clientY - st.y) > 6 : st.moved;
    const held = Date.now() - st.t;
    // 去重：pointer 通道刚翻过（<350ms），这次 touch 不再翻
    const sinceLast = Date.now() - lastToggleRef.current;
    if (!moved && held < DRAG_HOLD_MS && sinceLast > 350) {
      lastToggleRef.current = Date.now();
      toggleBar();
    }
  };

  if (!SHELL_PATHS.has(pathname)) {
    /**
     * bug3：非分页器页面（设置/备份/分类/规则/服务器/AI 接入/账号/置物墙…）
     * 在移动壳里也会被悬浮底栏压住 —— 这些页由 PageShell 自己滚动，拿不到 pager 里的
     * .nw-pane-gap。这里在文档流末尾补同款占位块（高度 === 底栏实测高度，折叠态缩到 10px）。
     */
    return (
      <div className="nw-shell-page" style={occStyle}>
        {children}
        <div className="nw-page-gap" aria-hidden />
      </div>
    );
  }

  // bug3：底部避让由「底栏实测高度」驱动的 .nw-pane-gap 承担（见下方 JSX 与 index.css）。
  return (
    <div className="nw-pager-shell flex flex-col overflow-hidden bg-surface-2 text-ink" style={occStyle}>
      {/* 分页器本体：四页并排、原生横向滚动；拖到哪停到哪，松手吸附到最近一页 */}
      <main className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={trackRef}
          className="nw-pager-track"
          onScroll={onTrackScroll}
          onTouchStart={() => {
            touching.current = true;
          }}
          onTouchEnd={() => {
            touching.current = false;
            // 抬指瞬间吸附动画才刚开始，多等一拍（260ms）让 scroll 事件把定时器重置
            scheduleCommit(SETTLE_MS * 2 + 20);
          }}
          onTouchCancel={() => {
            touching.current = false;
            scheduleCommit(SETTLE_MS * 2 + 20);
          }}
        >
          {TABS.map((t, i) => (
            <section
              key={t.to}
              className="nw-pager-pane"
              aria-hidden={i !== idx}
              // 非当前页不参与无障碍树与点击（视觉上仍在，滑动时看得到）
              style={i === idx ? undefined : { pointerEvents: 'none' }}
            >
              {/* ★v1.8.2：挂载「当前页 + 左右邻页」（见 shouldMount / 上方注释）。
                  不再有 4× 的挂载/布局成本（原来启动期就挂了四棵页面树）。
                  ★下拉刷新层也在门控之内：它自带一层 div + 指示器文案，
                  挂在邻页上等于冷启动仍构建四棵页面树（v1.8.0 bug1 回归）。
                  占位块 .nw-pane-gap 是 .nw-pane-body 的 flex 子项（撑满一屏 / 内容超出时退回
                  最小高度），必须留在 .nw-pane-body 里，所以跟着一起进门控。
                  ★tabPane 与 children 都画在同一棵信封里：旧实现把 children 直接放在
                  Tab 之外，那时它跟着 MainShell 每次路由变化重渲染（路由探针/页面才能看到
                  新的 pathname）；门控之后 children 只在 Tab 内，若与 tabPane 分两条路径，
                  相邻 Tab 切换（React 复用了外层 section）时 children 不重渲染 → 路由探针
                  读数卡在首页。tabPane 只在首页内容为空的真实路径树里用，信封不会多出一层。 */}
              {shouldMount(i) ? (
                <PullToRefresh className="nw-pane-body px-4 pt-2" onRefresh={handlePullRefresh}>
                  <RailSectionBoundary>
                    <Suspense fallback={<PaneFallback />}>
                      {/* ★v1.8.0：tabPane 与 children 是**互斥**的两条渲染路径，绝不能同时画：
                          · 非测试场景：App 同时传了 <Routes>(=children) 和 tabPane(renderTabPane)，
                            两者都渲染会让同一个页面画两遍（实测 pane 文本 "下拉刷新/home/home"）；
                          · 测试场景：测试只传 children=<PathProbe> 探针，靠它读 pathname。
                          所以这里二选一：有 tabPane 就用 tabPane，没有才用 children。
                          漏掉 children 会让路由探针整棵消失（v1.8.0 实测 9 条用例全返回 ''）。 */}
                      {tabPane ? tabPane(t.to) : children}
                    </Suspense>
                  </RailSectionBoundary>
                  <div className="nw-pane-gap" data-compact={barHidden ? 'true' : undefined} aria-hidden />
                </PullToRefresh>
              ) : null}
            </section>
          ))}
        </div>
      </main>

      {/* 左右滑动引导：一枚轻量气泡，只对没滑过的新用户出现一次；不拦截触摸。 */}
      {guideOpen && !barHidden ? (
        <div
          className="nw-swipe-hint pointer-events-none fixed inset-x-0 z-20 flex justify-center"
          style={{ bottom: 'calc(env(safe-area-inset-bottom) + 88px)' }}
          role="status"
        >
          <span
            className="flex items-center gap-1 rounded-full border px-3 py-1.5 text-micro font-semibold text-accent shadow-lg backdrop-blur"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent) 32%, transparent)',
              background: 'color-mix(in srgb, var(--accent-soft) 88%, var(--surface))',
            }}
          >
            <ChevronLeft size={13} strokeWidth={2.4} className="nw-swipe-l" aria-hidden />
            左右滑动切换页面
            <ChevronRight size={13} strokeWidth={2.4} className="nw-swipe-r" aria-hidden />
          </span>
        </div>
      ) : null}

      {/* 悬浮玻璃底栏：安全区放进定位而非内边距，整体抬升悬浮避开手势条。
          bug4：折叠不再另设浮在右侧的小圆钮，而是底栏自己上沿的一条胶囊把手：
          把手是底栏的一部分（同层、同玻璃材质），可点、可向下甩（收起）/向上甩（展开）。
          结构上把手是 nav 的**相邻兄弟**（包在 .nw-tabbar-wrap 里）：
          底栏本体仍只有四个页签，语义干净（nav 里没有多余按钮）。 */}
      <div
        className="nw-tabbar-wrap"
        data-hidden={barHidden ? 'true' : undefined}
        style={
          {
            // 把手与底栏一起做折叠动效：位移/底距都挂在这个外层
            bottom: (barHidden ? collapsedBottom : 'calc(env(safe-area-inset-bottom) + 8px)') as string,
            transform: barHidden || dragY === 0 ? 'none' : 'translateY(' + dragY + 'px)',
            transition: dragging
              ? 'none'
              : 'transform .3s cubic-bezier(.32,.72,0,1), bottom .3s cubic-bezier(.32,.72,0,1)',
          } as CSSProperties
        }
      >
        <button
          type="button"
          className="nw-tabbar-grip"
          aria-label={barHidden ? '显示底部导航' : '隐藏底部导航'}
          aria-expanded={!barHidden}
          /* ★v1.8.2 不再用 onClick：点击已在 onGripUp 里判定并 toggleBar，
             保留 onClick 会导致「一次点击翻两次」（收起又立刻展开）。 */
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripCancel}
          /* ★v1.8.3 双通道：Capacitor WebView 里 pointer 事件在部分 ROM 上不稳，
             touch 事件则一定派发。用 touch 起止独立判定「轻点切换」，与 pointer 拖拽并存
             （两者都调 toggleBar 时用时间戳去重，避免同一次点击翻两次）。 */
          onTouchStart={onGripTouchStart}
          onTouchEnd={onGripTouchEnd}
        >
          {barHidden ? <span className="nw-tabbar-grip-dot" aria-hidden /> : null}
        </button>
        <nav
          ref={navRef}
          className="nw-tabbar relative flex items-stretch rounded-[28px] shadow-lg shadow-black/10"
          style={GLASS_STYLE as CSSProperties}
        >
          {/* ★v1.8.4 液态玻璃高亮块：宽度 = 1/4 栏宽，位置随 scrollProgress 连续平移。
              它与页面横滑同帧联动 —— 滑到一半它就滚到两格之间，暂停它也停，松手吸附后归位。 */}
          <span
            aria-hidden
            className="nw-tab-indicator"
            style={{
              width: `${100 / TABS.length}%`,
              transform: `translateX(${scrollProgress * 100}%)`,
            }}
          />
          {TABS.map((t) => (
            <Tab key={t.to} {...t} />
          ))}
        </nav>
      </div>
    </div>
  );
}

function Tab({ to, label, Icon }: { to: string; label: string; Icon: LucideIcon }): JSX.Element {
  return (
    <NavLink
      to={to}
      onClick={() => void haptic('select')}
      className={({ isActive }) =>
        'flex flex-1 flex-col items-center gap-0.5 py-2.5 text-micro ' +
        (isActive ? 'font-semibold text-accent' : 'text-ink-3')
      }
    >
      {({ isActive }) => (
        <>
          {/* ★v1.8.4 高亮背景交给底栏统一的 .nw-tab-indicator 滑动块，这里只保留图标/文字变色，
              避免「每格自己一块背景」与滑动指示块叠加出现两块。 */}
          <span className="flex h-8 w-12 items-center justify-center rounded-2xl">
            <Icon size={22} strokeWidth={1.8} aria-hidden />
          </span>
          <span className={isActive ? 'text-accent' : undefined}>{label}</span>
        </>
      )}
    </NavLink>
  );
}

/* ---------------- 全局更新提醒条 ---------------- */

function UpdatePromptBar(): JSX.Element | null {
  const pendingUpdate = useUiStore((s) => s.pendingUpdate);
  const nav = useNavigate();
  const [dismissed, setDismissed] = useState<string>(() => dismissedVersion());

  if (!pendingUpdate || !shouldPromptUpdate(pendingUpdate, dismissed)) return null;

  return (
    <div
      className="fixed inset-x-3 z-40 mx-auto flex max-w-md justify-center"
      style={{ top: 'calc(env(safe-area-inset-top) + 10px)' }}
      role="status"
      aria-label="发现新版本提醒"
    >
      <div
        className="flex w-full items-center gap-2 rounded-2xl border border-accent/30 bg-surface/95 py-2 pl-3 pr-1.5 shadow-lg backdrop-blur"
        style={{ borderColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' }}
      >
        <Download size={15} strokeWidth={2} className="shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-caption text-ink">
          发现新版本 <span className="font-semibold">v{pendingUpdate.version}</span>
          {pendingUpdate.patch ? '（增量包，下载更快）' : ''}
        </span>
        <button
          type="button"
          onClick={() => {
            void haptic('select');
            nav('/settings');
          }}
          className="h-7 shrink-0 rounded-full bg-accent px-3 text-micro font-semibold text-white active:opacity-90"
        >
          去更新
        </button>
        <button
          type="button"
          onClick={() => {
            dismissVersion(pendingUpdate.version);
            setDismissed(pendingUpdate.version);
          }}
          aria-label="关闭更新提醒"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-3 active:bg-surface-2"
        >
          <X size={13} strokeWidth={2.2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
