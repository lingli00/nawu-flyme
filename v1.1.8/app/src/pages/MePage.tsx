import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brain, CircleUser, Cloud, LayoutGrid, Settings, Server, Tags, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore, useAuthStore, useServerStore, useUiStore, currentServer, toastSuccess } from '../store';
import { getProfile } from '../api/user';
import { APP_VERSION } from '../lib/appVersion';
import { isNative } from '../net/env';
import { haptic } from '../lib/haptics';
import { BrandMark } from '../components/BrandMark';
import { Sheet } from '../components/ui/Sheet';

const STATE_LABEL: Record<string, string> = {
  valid: '已登录',
  offline: '离线模式（保留本地登录态）',
  expired: '登录已过期',
  unknown: '未登录',
};

// 物品/报表入口与底栏 Tab 重复，已移除；这里只保留底栏没有的子功能
const ENTRIES: Array<{ to: string; Icon: LucideIcon; label: string; desc: string }> = [
  { to: '/wall', Icon: LayoutGrid, label: '置物墙', desc: '在役物品一览 · 生成分享卡片' },
  { to: '/backup', Icon: Cloud, label: '备份与恢复', desc: '云备份 / 覆盖恢复' },
  { to: '/categories', Icon: Tags, label: '分类管理', desc: '自定义分类' },
  { to: '/rules', Icon: Brain, label: '识别规则', desc: '教 AI 识记账：关键词 → 分类' },
  { to: '/servers', Icon: Server, label: '服务器管理', desc: '多服务器添加与切换' },
  { to: '/settings', Icon: Settings, label: '设置', desc: '主题 · AI · 同步 · 货币' },
];

/** ★v1.0.25：会话级昵称缓存——进页先显示上次结果，后台静默刷新，杜绝名字跳动。 */
let profileNameCache = '';

/** P20 我的：登录态 + 功能入口。 */
export default function MePage() {
  const nav = useNavigate();
  const session = useAuthStore((s) => s.session);
  const sessionState = useAuthStore((s) => s.sessionState);
  const offlineMode = useAppStore((s) => s.offlineMode);
  const serverName = useServerStore((s) => s.servers.find((x) => x.id === s.currentId)?.alias);
  const loggedIn = sessionState === 'valid' && Boolean(session?.token);
  const server = currentServer();

  // ★v0.7.0：昵称优先取云端 profile（session 里的 display_name 是登录时的快照，
  // 资料改完不重新登录会一直显示旧值）。拉取失败静默回落 session/邮箱。
  // ★v1.0.25：初值用会话缓存，后台刷新仅在实际变化时才写入——修复每次进页
  // 「先快照后云端名」的闪跳（录屏 156af08c）。
  const [drawer, setDrawer] = useState(false);
  const [profileName, setProfileName] = useState(profileNameCache);
  useEffect(() => {
    if (!loggedIn || !server) {
      profileNameCache = ''; // 登出/切服务器时清缓存，避免串号
      return;
    }
    let alive = true;
    getProfile(server)
      .then((raw) => {
        const dn = typeof raw.display_name === 'string' ? raw.display_name.trim() : '';
        if (alive && dn && dn !== profileNameCache) {
          profileNameCache = dn;
          setProfileName(dn);
        }
      })
      .catch(() => {
        // 静默：昵称显示回落即可
      });
    return () => {
      alive = false;
    };
  }, [loggedIn, server]);

  const logout = async () => {
    void haptic('medium');
    const ok = await useUiStore.getState().confirm({
      title: '退出登录？',
      message: '本地数据不会被删除，退出后可重新登录同步。',
    });
    if (!ok) return;
    await useAuthStore.getState().logout();
    toastSuccess('已退出登录');
  };

  const name = profileName || session?.user?.display_name || session?.user?.email || '未登录';

  return (
    // ★v1.1.8：六个功能入口不再铺满整屏，收进「抽屉」；页面只留账号卡 + 一个入口行。
    // PC 上同样保持手机版的单列窄栏（max-w-xl 居中），不再拉成两栏大块。
    <div className="space-y-3 dt:mx-auto dt:max-w-xl">
      {/* PC 独有标题（手机端由底部标签栏指示当前页，不重复显示） */}
      <h1 className="hidden dt:block dt:pb-1 dt:text-2xl dt:font-bold">我的</h1>

      {/* 账号卡（点击进入资料 / 改密码） */}
      <div className="rounded-card border border-line bg-surface p-4">
        <button onClick={() => nav('/account')} className="flex w-full items-center gap-3 text-left">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent dt:h-14 dt:w-14">
            {loggedIn ? <CircleUser size={26} strokeWidth={1.8} aria-hidden /> : <BrandMark size={26} variant="mono" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold dt:text-lg">{name}</p>
            <p className="text-xs text-ink-3">
              {STATE_LABEL[sessionState] ?? '未登录'}
              {serverName ? ` · ${serverName}` : ' · 未连接服务器'}
              {offlineMode ? ' · 离线记账' : ''}
            </p>
          </div>
          <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
        </button>
        {session && !session.user.verified ? (
          <p className="mt-2 rounded-btn bg-accent-soft px-3 py-2 text-xs text-accent">邮箱还未验证，部分同步功能可能受限</p>
        ) : null}
        {!loggedIn ? (
          <div className="mt-3 flex gap-2">
            <button onClick={() => nav('/login')} className="h-10 flex-1 rounded-btn bg-accent text-sm font-medium text-white">
              登录
            </button>
            <button onClick={() => nav('/login')} className="h-10 flex-1 rounded-btn border border-line text-sm text-ink-2">
              注册新账号
            </button>
          </div>
        ) : null}
      </div>

      {!loggedIn ? (
        <p className="px-1 text-xs text-ink-3">不登录也可以离线记账；登录后才能使用云备份与多端同步。</p>
      ) : null}

      {/* ★v1.1.8：功能入口抽屉 —— 页面只占一行，点开才铺出六个入口（手机底部抽屉 / 桌面右抽屉） */}
      <button
        onClick={() => {
          void haptic('select');
          setDrawer(true);
        }}
        aria-haspopup="dialog"
        className="flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 text-left active:bg-surface-2 dt:hover:bg-surface-2"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent dt:h-10 dt:w-10">
          <LayoutGrid size={18} strokeWidth={1.8} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">全部功能</span>
          <span className="block text-[11px] text-ink-3">置物墙 · 备份 · 分类 · 规则 · 服务器 · 设置</span>
        </span>
        <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
      </button>

      {/* 退出登录 */}
      {loggedIn ? (
        <button
          onClick={() => void logout()}
          className="w-full rounded-card border border-line bg-surface py-3 text-sm active:bg-surface-2"
          style={{ color: 'var(--fou)' }}
        >
          退出登录
        </button>
      ) : null}

      <p className="pb-2 text-center text-[11px] text-ink-3">
        纳物 · {isNative() ? 'App' : '网页版'} v{APP_VERSION}
      </p>

      {drawer ? (
        <Sheet side="bottom" title="全部功能" onClose={() => setDrawer(false)} drawerWidth="26rem">
          <ul className="overflow-hidden rounded-card border border-line">
            {ENTRIES.map((e, i) => (
              <li key={e.to}>
                <button
                  onClick={() => {
                    setDrawer(false);
                    void haptic('select');
                    nav(e.to);
                  }}
                  className={`flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-surface-2 ${
                    i > 0 ? 'border-t border-line-2' : ''
                  }`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <e.Icon size={18} strokeWidth={1.8} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{e.label}</span>
                    <span className="block text-[11px] text-ink-3">{e.desc}</span>
                  </span>
                  <ChevronRight size={16} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      ) : null}
    </div>
  );
}
