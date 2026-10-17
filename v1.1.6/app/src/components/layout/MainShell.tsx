import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { BarChart3, ChevronDown, ChevronUp, Home, Plus, ScrollText, Smartphone, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { APP_VERSION } from '../../lib/appVersion';
import { haptic } from '../../lib/haptics';
import RecordMenu from '../RecordMenu';
import { BrandMark } from '../BrandMark';

/**
 * 主壳（v1.0.6：三端一码，PC 网页重构完成）：
 * - 移动壳（<1024px 或偏好 mobile）：悬浮玻璃底栏（4 Tab + 中央 FAB）——手感与 App 一致。
 * - 桌面壳（≥1024px 或偏好 pc）：深绿侧边栏（原 PC 网页同款配色）+ 宽内容区。
 *   页面与 App 完全同一套源码，功能天然同步。
 * - 手动切换：setShellPref 写 localStorage（gf.shellPref），?ui=pc / ?ui=mobile 可强制；
 *   服务器端 ?ui=legacy 仍可回到旧 PC 页（仅逃生用）。
 * 图标统一 lucide 单色线性（禁彩色 emoji）。
 */

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
        window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash,
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

/* ---------------- 样式常量 ---------------- */

/** 液态玻璃面板样式（v1.0.16 对齐 iOS 26 Liquid Glass）：
 *  低不透明度 + 大半径模糊 + 高饱和 + 顶部内高光边缘 ——
 *  颜色走 CSS 变量，深浅色自适应；三端（App / 手机网页 / 电脑网页移动壳）共用。 */
export const GLASS_STYLE: CSSProperties = {
  background:
    'linear-gradient(to bottom, color-mix(in srgb, var(--surface) 52%, transparent), color-mix(in srgb, var(--surface) 66%, transparent))',
  border: '1px solid color-mix(in srgb, var(--surface) 55%, transparent)',
  boxShadow:
    'inset 0 1px 0 color-mix(in srgb, white 55%, transparent), inset 0 -1px 0 color-mix(in srgb, var(--line) 40%, transparent), 0 12px 36px rgba(0,0,0,0.14)',
  backdropFilter: 'blur(28px) saturate(180%)',
  WebkitBackdropFilter: 'blur(28px) saturate(180%)',
};

/* ---------------- 主壳入口 ---------------- */

export default function MainShell({ children }: { children: ReactNode }): JSX.Element {
  const { pathname } = useLocation();
  const mode = useShellMode();
  // ★v1.0.29：把壳层状态写到 <html data-shell>，供 `dt:` 桌面变体判断
  // （页面级桌面栅格必须感知壳层：宽屏 + 移动壳时不能套桌面栅格，否则挤成竖条）
  useEffect(() => {
    document.documentElement.dataset.shell = mode === 'desktop' ? 'pc' : 'mobile';
    return () => {
      delete document.documentElement.dataset.shell;
    };
  }, [mode]);
  // 管理后台独立全屏：不带主壳侧边栏/底栏，登录卡与内容才能真正居中
  // v1.1.5：后台入口已收为隐蔽路径 /flyme（界面不再给按钮）
  if (pathname === '/flyme' || pathname.startsWith('/flyme/')) {
    return <div className="min-h-screen bg-paper text-ink">{children}</div>;
  }
  return mode === 'desktop' ? <DesktopShell>{children}</DesktopShell> : <MobileShell>{children}</MobileShell>;
}

/* ---------------- 桌面壳：深绿侧边栏 + 宽内容 ---------------- */

function DesktopShell({ children }: { children: ReactNode }): JSX.Element {
  const { pathname } = useLocation();
  const narrow = !useMediaQuery('(min-width: 1024px)'); // 手机上强制 PC 版 → 图标窄栏
  const inShell = SHELL_PATHS.has(pathname);
  const rail = narrow ? 'w-14' : 'w-60';
  /** v1.0.22：主行动钮改开「加号动作菜单」（与移动壳 FAB 同一组件）。 */
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-paper text-ink">
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex flex-col ${rail}`}
        style={{ background: 'var(--side)', color: 'var(--side-ink)' }}
      >
        {/* 品牌（★v1.0.33 P2-12：自有字标，替代通用 Compass） */}
        <div className={`flex items-center ${narrow ? 'justify-center' : 'gap-2.5 px-5'} pt-6 pb-4`}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: 'var(--side-2)' }}>
            <BrandMark size={20} variant="mono" />
          </span>
          {!narrow ? (
            <span className="min-w-0">
              <span className="block text-base font-semibold leading-tight">纳物</span>
              <span className="block text-[11px]" style={{ color: 'var(--side-dim)' }}>
                NaWu
              </span>
            </span>
          ) : null}
        </div>

        {/* 记一笔（桌面主行动：开加号动作菜单，同移动壳 FAB） */}
        <div className={narrow ? 'px-2' : 'px-4'}>
          <button
            onClick={() => {
              void haptic('medium');
              setMenuOpen(true);
            }}
            aria-label="记一笔"
            className={`flex items-center font-medium transition-transform active:scale-95 ${narrow ? 'h-10 w-10 justify-center rounded-xl' : 'h-10 w-full justify-center gap-2 rounded-xl text-sm'}`}
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            <Plus size={18} strokeWidth={2.2} aria-hidden />
            {!narrow ? '记一笔' : null}
          </button>
        </div>

        {/* 主导航 */}
        <nav className={`mt-4 flex-1 ${narrow ? 'px-2' : 'px-3'}`}>
          {TABS.map((t) => (
            <SideItem key={t.to} {...t} narrow={narrow} />
          ))}
        </nav>

        {/* 底部：切手机版 / 版本（v1.1.5 起移除「管理后台」入口，
            后台改由隐蔽路径 /#/flyme 手动进入） */}
        <div className={`${narrow ? 'px-2' : 'px-3'} pb-4`}>
          <SideAction
            Icon={Smartphone}
            label="手机版网页"
            narrow={narrow}
            onClick={() => setShellPref('mobile')}
          />
          {!narrow ? (
            <p className="px-2 pt-3 text-[11px]" style={{ color: 'var(--side-dim)' }}>
              纳物网页版 v{APP_VERSION}
            </p>
          ) : null}
        </div>
      </aside>

      <div className="min-w-0 flex-1" style={{ paddingLeft: narrow ? 56 : 240 }}>
        {inShell ? (
          // ★v1.0.25：宽屏内容放宽到 1240px（原 5xl=1024 在 1080p+ 下留白过大，像手机页拉伸）
          <div className="mx-auto w-full max-w-[1240px] px-8 pb-20 pt-8 2xl:max-w-[1320px]">{children}</div>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-6 pb-20 pt-8">{children}</div>
        )}
      </div>

      {menuOpen ? <RecordMenu onClose={() => setMenuOpen(false)} /> : null}
    </div>
  );
}

function SideItem({ to, label, Icon, narrow }: { to: string; label: string; Icon: LucideIcon; narrow: boolean }): JSX.Element {
  return (
    <NavLink
      to={to}
      title={label}
      onClick={() => void haptic('select')}
      className={`mb-1 flex items-center rounded-xl text-sm transition-colors ${
        narrow ? 'h-10 justify-center' : 'h-11 gap-3 px-3'
      }`}
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
      className={`mb-1 flex w-full items-center rounded-xl text-sm transition-colors hover:bg-white/5 ${
        narrow ? 'h-10 justify-center' : 'h-10 gap-3 px-3'
      }`}
      style={{ color: 'var(--side-dim)' }}
    >
      <Icon size={20} strokeWidth={1.8} aria-hidden />
      {!narrow ? label : null}
    </button>
  );
}

/* ---------------- 移动壳：悬浮玻璃底栏（v1.0.4 原样保留） ---------------- */

function MobileShell({ children }: { children: ReactNode }): JSX.Element {
  const { pathname } = useLocation();
  /** v1.0.22：中央 FAB 改开「加号动作菜单」（对标竞品），不再直跳 AI 页。 */
  const [menuOpen, setMenuOpen] = useState(false);
  /** v1.1.4：底部导航可收起（阅读/看长列表时腾出空间），状态记忆到 localStorage。 */
  const [barHidden, setBarHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TABBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleBar = (): void => {
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

  if (!SHELL_PATHS.has(pathname)) {
    return <>{children}</>;
  }

  return (
    <div
      className="flex min-h-full flex-col bg-surface-2 text-ink"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <main className={`mx-auto w-full max-w-xl flex-1 px-4 pt-2 ${barHidden ? 'pb-16' : 'pb-36'}`}>
        {children}
      </main>

      {/* 收起/展开手柄：一枚小圆钮贴右侧，视觉重量低于底栏本身 */}
      <button
        onClick={toggleBar}
        aria-label={barHidden ? '显示底部导航' : '隐藏底部导航'}
        className="fixed right-3 z-30 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface/85 text-ink-3 shadow-sm backdrop-blur active:scale-95"
        style={{
          bottom: barHidden
            ? 'calc(env(safe-area-inset-bottom) + 10px)'
            : 'calc(env(safe-area-inset-bottom) + 84px)',
          transition: 'bottom .28s cubic-bezier(.32,.72,0,1)',
        }}
      >
        {barHidden ? <ChevronUp size={15} strokeWidth={2} /> : <ChevronDown size={15} strokeWidth={2} />}
      </button>

      {/* 悬浮玻璃底栏：安全区放进定位而非内边距——手势导航机型（bottom inset 可达 30-40px）
          不再把框内撑出空洞，整体抬升悬浮避开手势条 */}
      <nav
        className="fixed inset-x-3 z-30 mx-auto flex w-[calc(100%-1.5rem)] max-w-[calc(36rem-1.5rem)] items-stretch rounded-[28px] shadow-lg shadow-black/10"
        style={{
          ...GLASS_STYLE,
          bottom: 'calc(env(safe-area-inset-bottom) + 8px)',
          transform: barHidden ? 'translateY(calc(100% + 24px))' : 'none',
          opacity: barHidden ? 0 : 1,
          transition: 'transform .28s cubic-bezier(.32,.72,0,1), opacity .22s ease',
          pointerEvents: barHidden ? 'none' : 'auto',
        }}
      >
        {TABS.slice(0, 2).map((t) => (
          <Tab key={t.to} {...t} />
        ))}

        {/* 中央 FAB */}
        <div className="relative w-16 shrink-0">
          <button
            onClick={() => {
              void haptic('medium');
              setMenuOpen(true);
            }}
            aria-label="记一笔"
            className="absolute -top-7 left-1/2 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full bg-accent text-3xl font-light text-white shadow-lg shadow-accent/40 active:scale-95"
            style={{ boxShadow: '0 10px 24px color-mix(in srgb, var(--accent) 40%, transparent)' }}
          >
            ＋
          </button>
        </div>

        {TABS.slice(2).map((t) => (
          <Tab key={t.to} {...t} />
        ))}
      </nav>

      {menuOpen ? <RecordMenu onClose={() => setMenuOpen(false)} /> : null}
    </div>
  );
}

function Tab({ to, label, Icon }: { to: string; label: string; Icon: LucideIcon }): JSX.Element {
  return (
    <NavLink
      to={to}
      onClick={() => void haptic('select')}
      className={({ isActive }) =>
        `flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] ${
          isActive ? 'font-semibold text-accent' : 'text-ink-3'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`flex h-8 w-12 items-center justify-center rounded-2xl transition-all ${
              isActive ? 'scale-105 bg-accent-soft' : ''
            }`}
          >
            <Icon size={22} strokeWidth={1.8} aria-hidden />
          </span>
          {label}
        </>
      )}
    </NavLink>
  );
}
