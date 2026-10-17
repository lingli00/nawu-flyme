import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brain, CircleUser, Cloud, LayoutGrid, Monitor, Settings, Server, Smartphone, Tags, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore, useAuthStore, useServerStore, useUiStore, currentServer, toastSuccess } from '../store';
import { getProfile } from '../api/user';
import { APP_VERSION } from '../lib/appVersion';
import { isNative } from '../net/env';
import { haptic } from '../lib/haptics';
import { useShellMode, setShellPref } from '../components/layout/MainShell';
import { BrandMark } from '../components/BrandMark';

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
  const shellMode = useShellMode();

  // ★v0.7.0：昵称优先取云端 profile（session 里的 display_name 是登录时的快照，
  // 资料改完不重新登录会一直显示旧值）。拉取失败静默回落 session/邮箱。
  // ★v1.0.25：初值用会话缓存，后台刷新仅在实际变化时才写入——修复每次进页
  // 「先快照后云端名」的闪跳（录屏 156af08c）。
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
    // ★v1.0.25 PC 重构：桌面左右分栏（左 340px 账号区 / 右功能入口网格），移动端保持纵向列表
    <div className="space-y-3 dt:grid dt:grid-cols-[340px_1fr] dt:items-start dt:gap-4 dt:space-y-0">
      {/* 左列：账号卡 + 未登录提示 + 退出登录 */}
      <div className="space-y-3">
        {/* 头部：账号卡（点击头像/信息行进入账号编辑：资料 / 改密码） */}
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

        {/* 未登录提示 */}
        {!loggedIn ? (
          <p className="px-1 text-xs text-ink-3">不登录也可以离线记账；登录后才能使用云备份与多端同步。</p>
        ) : null}
      </div>

      {/* 右列：功能入口（PC 两列卡片网格）+ 网页专属入口 */}
      <div className="space-y-3">
        <ul className="overflow-hidden rounded-card border border-line bg-surface dt:grid dt:grid-cols-2 dt:gap-3 dt:overflow-visible dt:border-0 dt:bg-transparent">
          {ENTRIES.map((e, i) => (
            <li key={e.to} className="dt:rounded-card dt:border dt:border-line dt:bg-surface">
              <button
                onClick={() => {
                  void haptic('select');
                  nav(e.to);
                }}
                className={`flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-surface-2 dt:rounded-card ${
                  i > 0 ? 'border-t border-line-2 dt:border-t-0' : ''
                }`}
              >
                <span className="text-accent">
                  <e.Icon size={20} strokeWidth={1.8} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{e.label}</span>
                  <span className="block text-[11px] text-ink-3">{e.desc}</span>
                </span>
                <span className="text-ink-3">›</span>
              </button>
            </li>
          ))}
        </ul>

        {/* 网页专属入口（App 端不显示）：手机版/电脑版手动切换
            （v1.1.5 起不再提供「管理后台」按钮，后台改由隐蔽路径 /#/flyme 进入） */}
        {!isNative() ? (
          <ul className="overflow-hidden rounded-card border border-line bg-surface dt:grid dt:grid-cols-2 dt:gap-3 dt:overflow-visible dt:border-0 dt:bg-transparent">
            <li className="dt:rounded-card dt:border dt:border-line dt:bg-surface">
              <button
                onClick={() => setShellPref(shellMode === 'mobile' ? 'pc' : 'mobile')}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-surface-2 dt:rounded-card"
              >
                <span className="text-accent">
                  {shellMode === 'mobile' ? <Monitor size={20} strokeWidth={1.8} aria-hidden /> : <Smartphone size={20} strokeWidth={1.8} aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{shellMode === 'mobile' ? '电脑版网页' : '手机版网页'}</span>
                  <span className="block text-[11px] text-ink-3">
                    {shellMode === 'mobile' ? '切换到桌面布局（侧边栏宽屏版）' : '切换到移动布局（底部标签栏）'}
                  </span>
                </span>
                <span className="text-ink-3">›</span>
              </button>
            </li>
          </ul>
        ) : null}
      </div>

      {/* ★v1.0.33：退出登录移到页面最底部（此前紧贴账号卡在最上方，位置反直觉） */}
      {loggedIn ? (
        <button
          onClick={() => void logout()}
          className="w-full rounded-card border border-line bg-surface py-3 text-sm active:bg-surface-2 dt:col-span-2 dt:mx-auto dt:max-w-xs"
          style={{ color: 'var(--fou)' }}
        >
          退出登录
        </button>
      ) : null}

      <p className="pb-2 text-center text-[11px] text-ink-3 dt:col-span-2">
        纳物 · {isNative() ? 'App' : '网页版'} v{APP_VERSION}
      </p>
    </div>
  );
}
