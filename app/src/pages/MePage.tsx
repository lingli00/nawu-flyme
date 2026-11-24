import { useEffect, useMemo, useState, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Brain,
  CircleUser,
  Cloud,
  LayoutGrid,
  Monitor,
  Settings,
  Server,
  Sparkles,
  Tags,
  ChevronRight,
  LogOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore, useAuthStore, useDataStore, useServerStore, useUiStore, currentServer, toastSuccess } from '../store';
import { getProfile } from '../api/user';
import { APP_VERSION } from '../lib/appVersion';
import { isNative } from '../net/env';
import { haptic } from '../lib/haptics';
import { BrandMark } from '../components/BrandMark';
import { useShellMode, setShellPref } from '../components/layout/MainShell';
import { Button } from '../components/ui/Button';

const STATE_LABEL: Record<string, string> = {
  valid: '已登录',
  offline: '离线模式（保留本地登录态）',
  expired: '登录已过期',
  unknown: '未登录',
};

/**
 * 功能入口分组（★v1.7.6 重构）。
 *
 * 旧版：7 个入口平铺成 2 列 4 行网格，7 是奇数 → 最后一行只有「设置」一张卡，
 * 右侧空出一格，在 896px 宽的内容区里形成明显的缺角；且 4 行高度 280px，
 * 整页 900px 高处下方留白 340px，页面重心偏上。
 * 新版：按「我有什么 → 我怎么用」分两段（内容 / 系统），4 + 3 行各自成组，
 * 缺口被组内最后一项（占满整行）吸收，不再出现缺角。
 */
const ENTRY_GROUPS: Array<{
  title: string;
  items: Array<{ to: string; Icon: LucideIcon; label: string; desc: string }>;
}> = [
  {
    title: '我的内容',
    items: [
      { to: '/wall', Icon: LayoutGrid, label: '置物墙', desc: '在役物品一览 · 生成分享卡片' },
      { to: '/categories', Icon: Tags, label: '分类管理', desc: '自定义分类' },
      { to: '/rules', Icon: Brain, label: '识别规则', desc: '教 AI 记账：关键词 → 分类' },
      { to: '/ai', Icon: Sparkles, label: 'AI 接入', desc: '生成 API Key · 接入 Muse / 任意 AI' },
    ],
  },
  {
    title: '数据与系统',
    items: [
      { to: '/backup', Icon: Cloud, label: '备份与恢复', desc: '云备份 / 覆盖恢复' },
      { to: '/servers', Icon: Server, label: '服务器管理', desc: '多服务器添加与切换' },
      { to: '/settings', Icon: Settings, label: '设置', desc: '主题 · AI · 同步 · 货币' },
    ],
  },
];

/** ★v1.0.25：会话级昵称缓存——进页先显示上次结果，后台静默刷新，杜绝名字跳动。 */
let profileNameCache = '';

/** P20 我的：登录态 + 概览 + 功能入口。 */
function MePage() {
  const nav = useNavigate();
  const session = useAuthStore((s) => s.session);
  const sessionState = useAuthStore((s) => s.sessionState);
  const offlineMode = useAppStore((s) => s.offlineMode);
  const serverName = useServerStore((s) => s.servers.find((x) => x.id === s.currentId)?.alias);
  const loggedIn = sessionState === 'valid' && Boolean(session?.token);
  const server = currentServer();
  /** ★v1.1.9：当前壳模式——只在「手机版网页」下给「切到电脑版」入口，电脑版不重复出现。 */
  const shellMode = useShellMode();

  // 概览数据：用本机已有集合做一行摘要，填补旧版页面下半部的空场
  const goods = useDataStore((s) => s.goods);
  const valueRecords = useDataStore((s) => s.valueRecords);
  const subscriptions = useDataStore((s) => s.subscriptions);

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

  // 概览：在役物品数（退役不计）、累计记账笔数、订阅数
  const overview = useMemo(() => {
    const activeGoods = goods.filter((g) => g.status !== 'retired').length;
    return [
      { label: '在役物品', value: String(activeGoods), unit: '件' },
      { label: '记账笔数', value: String(valueRecords.length), unit: '笔' },
      { label: '订阅', value: String(subscriptions.length), unit: '项' },
    ];
  }, [goods, valueRecords, subscriptions]);

  return (
    <div className="space-y-4 dt:space-y-5">
      {/* PC 独有标题 */}
      <h1 className="hidden text-2xl font-bold dt:block">我的</h1>

      {/*
        ★v1.7.6 重构：旧的 PC 布局是 [300px 左列 | 1fr 右列] 栅格，
        左列只有一张账号卡、右列是 7 格入口网格。1440 宽下右列被拉到 896px，
        7 个奇数格产生缺角，两张卡一左一右高度悬殊，视觉上像「一张大白色背板
        里面嵌了几块小卡」。新版改为：
          · PC：账号卡 + 概览条 横向并排（同一视觉层级），入口按分组单列铺开，
                每组内部 2 列、组标题做分隔 —— 不再有落单的格子；
          · 移动：完全保持原来的竖排流，不引入任何新结构。
      */}

      {/* 账号卡 + 概览 */}
      <div className="dt:grid dt:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] dt:items-stretch dt:gap-4">
        <div className="rounded-card border border-line bg-surface p-4 dt:flex dt:flex-col dt:justify-center">
          <button
            onClick={() => nav('/account')}
            className="flex w-full items-center gap-3 text-left"
          >
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
            <p className="mt-2 rounded-btn bg-accent-soft px-3 py-2 text-xs text-accent">
              邮箱还未验证，部分同步功能可能受限
            </p>
          ) : null}
          {!loggedIn ? (
            <div className="mt-3 flex items-center gap-2">
              <Button variant="primary" block onClick={() => nav('/login')}>
                登录
              </Button>
              <Button variant="outline" block onClick={() => nav('/login')}>
                注册新账号
              </Button>
            </div>
          ) : null}
        </div>

        {/* 概览条：填补旧版「账号卡旁边什么都没有」的空场，也给页面一个信息重心 */}
        <div className="mt-3 rounded-card border border-line bg-surface p-4 dt:mt-0 dt:flex dt:flex-col dt:justify-center">
          <div className="grid grid-cols-3 divide-x divide-line-2">
            {overview.map((o) => (
              <div key={o.label} className="px-3 first:pl-0 last:pr-0">
                <p className="text-micro text-ink-3">{o.label}</p>
                {/* 数字与单位放同一基线：单位更小、颜色更弱，避免大小字混排导致视觉跳动 */}
                <p className="mt-1.5 flex items-baseline gap-1">
                  <span className="tnum text-num-sm leading-none text-ink">{o.value}</span>
                  <span className="text-micro text-ink-3">{o.unit}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {!loggedIn ? (
        <p className="px-1 text-xs text-ink-3">不登录也可以离线记账；登录后才能使用云备份与多端同步。</p>
      ) : null}

      {/* 功能入口：按分组铺开，组标题承担「白色背板」原本在做但没做好的分隔职责 */}
      <div className="space-y-4 dt:space-y-5">
        {ENTRY_GROUPS.map((group) => (
          <section key={group.title}>
            <h2 className="mb-2 px-0.5 text-micro font-medium text-ink-3">{group.title}</h2>
            <ul
              className="grid grid-cols-1 gap-2.5 dt:grid-cols-2 dt:gap-3"
              /*
                旧的移动端实现是「一张卡片包住 7 行、行间用 border-t 分隔」，
                这套写法搬到 PC 双列时，border-t 会残留在网格中间形成多余线条，
                也是「整块白背板」观感的来源之一。现在移动端也用 gap 分隔的独立卡，
                PC 直接复用同一结构放大，两壳表现一致。
              */
            >
              {group.items.map((e) => (
                <li key={e.to}>
                  <button
                    onClick={() => {
                      void haptic('select');
                      nav(e.to);
                    }}
                    className="flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 text-left transition-colors active:bg-surface-2 dt:py-4 dt:hover:border-line-2 dt:hover:bg-surface-2"
                  >
                    <span className="text-accent dt:flex dt:h-10 dt:w-10 dt:shrink-0 dt:items-center dt:justify-center dt:rounded-xl dt:bg-accent-soft">
                      <e.Icon size={20} strokeWidth={1.8} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium dt:text-h3">{e.label}</span>
                      <span className="block text-micro text-ink-3">{e.desc}</span>
                    </span>
                    <ChevronRight size={16} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {/* ★v1.1.9：手机版网页专用——一键切到电脑版网页 */}
      {!isNative() && shellMode === 'mobile' ? (
        <button
          onClick={() => {
            void haptic('select');
            setShellPref('pc');
          }}
          className="flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 text-left active:bg-surface-2"
        >
          <span className="text-accent">
            <Monitor size={20} strokeWidth={1.8} aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">电脑版网页</span>
            <span className="block text-micro text-ink-3">切换到宽屏侧边栏布局（侧边栏底部可切回）</span>
          </span>
          <ChevronRight size={16} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
        </button>
      ) : null}

      {/* ★v1.0.33：退出登录在页面最底部；★v1.7.6 改为低权重文字按钮，
          不再是一个和功能入口同等体量的整块白卡（旧版整行白卡与上方入口争夺注意力） */}
      {loggedIn ? (
        <div className="flex justify-center pt-1">
          <Button variant="ghost" size="sm" icon={LogOut} onClick={() => void logout()}>
            退出登录
          </Button>
        </div>
      ) : null}

      <p className="pb-2 text-center text-micro text-ink-3">
        纳物 · {isNative() ? 'App' : '网页版'} v{APP_VERSION}
      </p>
    </div>
  );
}

/** memo: 分页器隔离，idx 变化时已挂载页不重执行 */
export default memo(MePage);
