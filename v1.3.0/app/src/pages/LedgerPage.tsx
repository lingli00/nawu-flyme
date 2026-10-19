import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, Heart, Leaf, PenLine, ReceiptText, ShoppingBag, Timer } from 'lucide-react';
import { CooldownSheet, MoodSheet, TimeSheet, WishSheet, cooldownExpired } from '../components/LifeSheets';
import CategoryGlyph from '../components/CategoryGlyph';
import { IconPreview, iconBaseOf } from '../components/IconPicker';
import { MoreMenuButton } from '../components/ui/MoreMenu';
import { EmptyState } from '../components/ui/EmptyState';
import { onSheetOpen } from '../lib/sheetBus';
import {
  useDataStore,
  useSettingsStore,
  useUiStore,
} from '../store';
import { groupByDay, sumExpense, sumIncome } from '../domain/ledger';
import { formatSignedMoney, formatMoney } from '../lib/money';
import { addDays, monthKey, monthLabel, nextMonth, prevMonth, relativeDayLabel, today } from '../lib/date';
import { haptic } from '../lib/haptics';
import { dailyQuote } from '../lib/dailyQuote';
import { topSuggestion } from '../lib/iconSuggest';
import type { Judgement, ValueRecord } from '../types/entities';

/** P09 生活流：按日/周/月/年粒度查看流水 + 四张生活小卡（心动清单/冷静池等）。 */

type Grain = 'day' | 'week' | 'month' | 'year';

const GRAIN_CHIPS: Array<[Grain, string]> = [
  ['day', '按日'],
  ['week', '按周'],
  ['month', '按月'],
  ['year', '按年'],
];

const JUDGEMENT_COLOR: Record<Judgement, string> = {
  gui: 'var(--gui)',
  xu: 'var(--xu)',
  fou: 'var(--fou)',
};
const JUDGEMENT_LABEL: Record<Judgement, string> = { gui: '归', xu: '需', fou: '否' };

/**
 * ★v1.3.0 生活流条目的智能图标（用户需求：生活流条目「自动匹配图标」）。
 * ValueRecord 没有 icon 字段（数据模型不加列），改为**实时推荐**：
 * note 命中品牌库（B站/网易云/iCloud…）时在分类名旁补一个品牌小图标，
 * 本地资产/内置 glyph 优先，零网络。纯 builtin 兜底不抢戏（分类 glyph 已在）。
 */
function SmartNoteIcon({ note }: { note?: string }): React.ReactNode {
  const base = useMemo(iconBaseOf, []);
  const kw = (note ?? '').trim();
  const top = useMemo(
    () => (kw.length >= 2 ? topSuggestion(kw, { kind: 'ledger', base }) : null),
    [kw, base],
  );
  if (!top || top.kind === 'builtin') return null;
  return <IconPreview icon={top.value} size={14} className="shrink-0 text-ink-2" />;
}

/** 月份键升序去重（某年出现过的月份）。 */
function monthKeysOf(rows: ValueRecord[]): string[] {
  return [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
}

export default function LedgerPage() {
  const nav = useNavigate();
  const records = useDataStore((s) => s.valueRecords);
  const categories = useDataStore((s) => s.categories);
  const removeLedger = useDataStore((s) => s.removeLedger);
  const undo = useDataStore((s) => s.undo);
  const currency = useSettingsStore((s) => s.settings.currency);

  const [grain, setGrain] = useState<Grain>('month');
  const [day, setDay] = useState(today());
  const [ym, setYm] = useState(monthKey());
  const [year, setYear] = useState(() => Number(monthKey().slice(0, 4)));
  /** 本周窗口（周一 ~ 周日）。 */
  const [weekStart, setWeekStart] = useState(() => {
    const dow = (new Date().getDay() + 6) % 7; // 周一=0
    return addDays(today(), -dow);
  });

  const catOf = (id: string) => categories.find((c) => c.id === id);

  /* —— 四种粒度的时间窗口（全部只统计生活流 valueRecords） —— */
  const inDay = useMemo(() => records.filter((r) => r.date === day), [records, day]);
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const inWeek = useMemo(
    () => records.filter((r) => r.date >= weekStart && r.date <= weekEnd),
    [records, weekStart, weekEnd],
  );
  const inMonth = useMemo(() => records.filter((r) => r.date.startsWith(ym)), [records, ym]);
  const inYear = useMemo(() => records.filter((r) => r.date.startsWith(String(year))), [records, year]);

  /** 按年视图：该年出现过的月份（升序），渲染时倒序展示。 */
  const yearMonths = useMemo(() => monthKeysOf(inYear), [inYear]);

  const activeRows = grain === 'day' ? inDay : grain === 'week' ? inWeek : grain === 'month' ? inMonth : inYear;
  const expense = useMemo(() => sumExpense(activeRows), [activeRows]);
  const income = useMemo(
    () => activeRows.filter((r) => r.type === 'income').reduce((acc, r) => acc + (r.amount || 0), 0),
    [activeRows],
  );

  /* —— v1.0 价值账本大卡（永远看今天，对标竞品生活流首屏） —— */
  const todayRows = useMemo(() => records.filter((r) => r.date === today()), [records]);
  const todayExpense = useMemo(() => sumExpense(todayRows), [todayRows]);
  const todayIncome = useMemo(
    () => todayRows.filter((r) => r.type === 'income').reduce((acc, r) => acc + (r.amount || 0), 0),
    [todayRows],
  );
  const byJudgement = useMemo(() => {
    const acc: Record<Judgement, number> = { gui: 0, xu: 0, fou: 0 };
    for (const r of todayRows) {
      if (r.type === 'expense') acc[r.judgement] += r.amount || 0;
    }
    return acc;
  }, [todayRows]);
  /** 健康度：非「否」支出占比；今日无支出 → 100%。 */
  const health = todayExpense > 0 ? Math.round((1 - byJudgement.fou / todayExpense) * 100) : 100;
  const jPct = (j: Judgement): number => (todayExpense > 0 ? Math.round((byJudgement[j] / todayExpense) * 100) : 0);

  /** 粒度切换器的 ‹ › 步进。 */
  const step = (dir: -1 | 1) => {
    if (grain === 'day') setDay(addDays(day, dir));
    else if (grain === 'week') setWeekStart(addDays(weekStart, dir * 7));
    else if (grain === 'month') setYm(dir === -1 ? prevMonth(ym) : nextMonth(ym));
    else setYear((y) => y + dir);
  };

  const windowLabel =
    grain === 'day'
      ? `${relativeDayLabel(day)} · ${day}`
      : grain === 'week'
        ? `${weekStart.slice(5).replace('-', '/')} ~ ${weekEnd.slice(5).replace('-', '/')}`
        : grain === 'month'
          ? monthLabel(ym, true)
          : `${year} 年`;

  const del = async (id: string, label: string) => {
    // ★v1.0.33：删除先确认（此前点一下直接删）；保留撤销兜底
    const ok = await useUiStore.getState().confirm({
      title: `删除「${label}」这笔记录？`,
      message: '删除后还可用提示条里的「撤销」找回。',
    });
    if (!ok) return;
    void haptic('medium');
    await removeLedger(id);
    useUiStore.getState().toast(`已删除「${label}」`, 'info', { actionLabel: '撤销', onAction: () => void undo() });
  };

  /* —— v1.0.20 四张生活小卡（对标竞品生活流首页）—— */
  const moods = useDataStore((s) => s.moods);
  const times = useDataStore((s) => s.times);
  const wishlist = useDataStore((s) => s.wishlist);
  const cooldowns = useDataStore((s) => s.cooldowns);
  const [wishOpen, setWishOpen] = useState(false);
  const [coolOpen, setCoolOpen] = useState(false);
  /** v1.0.21 · M3.3：情绪 / 时间两张卡也做落库闭环。 */
  const [moodOpen, setMoodOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);

  /* 加号菜单（RecordMenu）跨页打开生活流 sheet：sessionStorage 标志消费一次。 */
  useEffect(() => {
    try {
      if (sessionStorage.getItem('gf.open.wish')) {
        sessionStorage.removeItem('gf.open.wish');
        setWishOpen(true);
      }
      if (sessionStorage.getItem('gf.open.cooldown')) {
        sessionStorage.removeItem('gf.open.cooldown');
        setCoolOpen(true);
      }
      if (sessionStorage.getItem('gf.open.mood')) {
        sessionStorage.removeItem('gf.open.mood');
        setMoodOpen(true);
      }
      if (sessionStorage.getItem('gf.open.time')) {
        sessionStorage.removeItem('gf.open.time');
        setTimeOpen(true);
      }
    } catch {
      /* 忽略 */
    }
  }, []);

  /* v1.0.22：同路由时加号菜单走 sheetBus 信号即时开层（不依赖 navigate 重装）。 */
  useEffect(() => onSheetOpen('wish', () => setWishOpen(true)), []);
  useEffect(() => onSheetOpen('cooldown', () => setCoolOpen(true)), []);
  useEffect(() => onSheetOpen('mood', () => setMoodOpen(true)), []);
  useEffect(() => onSheetOpen('time', () => setTimeOpen(true)), []);

  const wishTotal = useMemo(() => wishlist.reduce((a, w) => a + (w.price || 0), 0), [wishlist]);
  const coolingSoon = useMemo(() => cooldowns.filter((c) => cooldownExpired(c)).length, [cooldowns]);
  const totalMin = useMemo(() => times.reduce((a, t) => a + (t.durationMin || 0), 0), [times]);

  /* ★v1.0.33 P0-4：四卡 tint 收敛到语义令牌（原 #EC4899/#3B82F6/#F59E0B/#10B981 彩虹化）。
     情绪=陶土、时间=需蓝（归需否价值语言）、心动=琥珀、冷静=青瓷，与产品方法论同构。 */
  const lifeCards = [
    {
      key: 'mood',
      Icon: Heart,
      tint: 'var(--tint-clay)',
      title: '情绪',
      main: moods.length > 0 ? `${moods.length} 条心情` : '还没记录',
      sub: moods.length > 0 ? (moods[0]?.crushed ? '最新：粉碎' : '最新：归入心底') : '记下每一次心动与后悔',
      onClick: () => setMoodOpen(true),
    },
    {
      key: 'time',
      Icon: Timer,
      tint: 'var(--xu)',
      title: '时间',
      main: times.length > 0 ? `${Math.round(totalMin / 60)} 小时` : '还没记录',
      sub: times.length > 0 ? `${times.length} 段时光` : '时间花在哪，生活就在哪',
      onClick: () => setTimeOpen(true),
    },
    {
      key: 'wish',
      Icon: ShoppingBag,
      tint: 'var(--tint-warm)',
      title: '心动清单',
      main: wishlist.length > 0 ? `${wishlist.length} 件想要` : '清单空空',
      sub: wishTotal > 0 ? `合计 ¥${wishTotal.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}` : '心动的先记下来',
      onClick: () => setWishOpen(true),
    },
    {
      key: 'cool',
      Icon: CalendarClock,
      tint: 'var(--tint-cool)',
      title: '冷静池',
      main: cooldowns.length > 0 ? `${cooldowns.length} 件在冷静` : '没有在冷静的',
      sub: coolingSoon > 0 ? `${coolingSoon} 件已到期，去看看` : '冲动消费前先放 7 天',
      onClick: () => setCoolOpen(true),
    },
  ];

  /** 按日分组的流水列表（按日 / 按月共用）。 */
  const renderDayGroups = (rows: ValueRecord[]) => {
    const groups = groupByDay(rows);
    if (groups.length === 0) {
      return (
        <EmptyState
          className="dt:col-span-2"
          icon={Leaf}
          title={`这个${grain === 'day' ? '天' : '月'}还没有记录`}
          actionLabel="试试 AI 记一笔"
          onAction={() => nav('/ai')}
        />
      );
    }
    return groups.map((g) => (
      <section key={g.date}>
        <div className="flex items-baseline justify-between px-1 py-1.5">
          <h3 className="text-xs font-semibold text-ink-2">{relativeDayLabel(g.date)}</h3>
          <p className="text-[11px] text-ink-3">
            {g.income > 0 ? `收 ${formatMoney(g.income, currency)} · ` : ''}支 {formatMoney(g.expense, currency)}
          </p>
        </div>
        <ul className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface">
          {g.rows.map((r) => {
            const cat = catOf(r.categoryId);
            return (
              <li key={r.id} className="flex items-center gap-3 px-3.5 py-3.5">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-base font-bold"
                  style={{ color: JUDGEMENT_COLOR[r.judgement] }}
                >
                  {JUDGEMENT_LABEL[r.judgement]}
                </span>
                <button onClick={() => nav(`/record/${r.id}`)} className="min-w-0 flex-1 text-left">
                  <p className="flex items-center gap-1 truncate text-sm">
                    {cat ? (
                      <>
                        <CategoryGlyph id={cat.icon} size={14} className="shrink-0 text-ink-2" />
                        {cat.name}
                      </>
                    ) : (
                      '未分类'
                    )}
                    <SmartNoteIcon note={r.note} />
                    {r.note ? <span className="text-ink-3"> · {r.note}</span> : null}
                  </p>
                  <p className="text-[11px] text-ink-3">
                    {r.type === 'income' ? '收入' : '支出'} · {r.judgement === 'gui' ? '值得' : r.judgement === 'xu' ? '必要' : '本可避免'}
                  </p>
                </button>
                <div className="flex items-center gap-1">
                  <div className="text-right">
                    <p
                      className="text-sm font-semibold"
                      style={{ color: r.type === 'income' ? 'var(--gui)' : 'var(--ink)' }}
                    >
                      {formatSignedMoney(r.amount, r.type, r.currency)}
                    </p>
                  </div>
                  {/* ★v1.0.33 P1-8：11px 文字删除按钮（~32px 触达）退役，
                      删除收进 ⋯ 菜单（44px 触达）；确认弹窗 + 撤销逻辑不变 */}
                  <MoreMenuButton
                    items={[{ key: 'del', label: '删除这笔记录', danger: true, onSelect: () => del(r.id, r.note || cat?.name || '记录') }]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    ));
  };

  /** 按年视图：每月一节（月份汇总 + 该月流水）。 */
  const renderYearGroups = () => {
    if (yearMonths.length === 0) {
      return (
        <EmptyState
          className="dt:col-span-2"
          icon={Leaf}
          title={`${year} 年还没有记录`}
          actionLabel="试试 AI 记一笔"
          onAction={() => nav('/ai')}
        />
      );
    }
    return [...yearMonths].reverse().map((m) => {
      const rows = inYear.filter((r) => r.date.startsWith(m));
      return (
        <section key={m}>
          <div className="flex items-baseline justify-between px-1 py-1.5">
            <h3 className="text-xs font-semibold text-ink-2">{monthLabel(m)}</h3>
            <p className="text-[11px] text-ink-3">
              {sumIncome(rows) > 0 ? `收 ${formatMoney(sumIncome(rows), currency)} · ` : ''}支 {formatMoney(sumExpense(rows), currency)}
            </p>
          </div>
          {renderDayGroups(rows)}
        </section>
      );
    });
  };

  return (
    <div className="space-y-3">
      {/* 大字标题 + 手动记一笔（与首页/报表页顶栏同风格） */}
      <header className="flex items-center justify-between pb-3 pt-2">
        <h1 className="text-3xl font-bold leading-9">生活流</h1>
        <button onClick={() => nav('/record')} className="h-9 rounded-full bg-accent-soft px-3.5 text-xs font-medium text-accent">
          <PenLine size={14} className="mr-1 inline-block align-[-2px]" />
          手动记一笔
        </button>
      </header>

      {/* v1.0 价值账本大卡（今日：支出 / 健康度 / 归需否三色条 / 同期收入） */}
      <div className="rounded-card border border-line bg-surface p-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <ReceiptText size={15} className="text-ink-2" />
            价值账本 · 今日
          </p>
          <span className="text-xs font-semibold" style={{ color: 'var(--gui)' }}>
            ↗ 健康度 {health}%
          </span>
        </div>
        <div className="mt-1.5 flex items-end justify-between">
          <div>
            <p className="text-[11px] text-ink-3">今日支出</p>
            <p className="text-2xl font-bold leading-8">{formatMoney(todayExpense, currency)}</p>
          </div>
          <p className="pb-1 text-[11px] text-ink-3">同期收入 {formatMoney(todayIncome, currency)}</p>
        </div>
        {/* 归 / 需 / 否 三色分布条 */}
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-surface-2">
          {(['gui', 'xu', 'fou'] as Judgement[]).map((j) => (
            <span key={j} style={{ width: `${jPct(j)}%`, background: JUDGEMENT_COLOR[j], transition: 'width .3s' }} />
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-ink-3">
          {(['gui', 'xu', 'fou'] as Judgement[]).map((j) => (
            <span key={j} className="flex items-center gap-1">
              <i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: JUDGEMENT_COLOR[j] }} />
              {JUDGEMENT_LABEL[j]} {formatMoney(byJudgement[j], currency)}
              <span className="hidden sm:inline">· {j === 'gui' ? '投资' : j === 'xu' ? '生存' : '浪费'}</span>
            </span>
          ))}
        </div>
        {todayExpense === 0 ? (
          /* ★v1.0.35：固定占位语换成每日一言（按日期轮换，全端一致） */
          <p className="mt-2.5 rounded-btn bg-surface-2 px-3 py-2 text-xs text-ink-3">
            <span className="mr-1.5 rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-medium text-accent">每日一言</span>
            {dailyQuote().text}
            {dailyQuote().from ? <span className="ml-1.5 opacity-80">—— {dailyQuote().from}</span> : null}
          </p>
        ) : byJudgement.fou > 0 ? (
          <p className="mt-2.5 rounded-btn bg-surface-2 px-3 py-2 text-xs" style={{ color: 'var(--fou)' }}>
            今日有 {formatMoney(byJudgement.fou, currency)}「否」支出，占 {jPct('fou')}%
          </p>
        ) : null}
      </div>

      {/* v1.0.20 四张生活小卡（情绪/时间/心动清单/冷静池，全部可点开管理） */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {lifeCards.map(({ key, Icon, tint, title, main, sub, onClick }) => {
          const clickable = typeof onClick === 'function';
          return (
            <button
              key={key}
              onClick={onClick}
              disabled={!clickable}
              className={`rounded-card border border-line bg-surface p-3 text-left transition-all ${
                clickable ? 'active:scale-[0.98]' : 'cursor-default'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-lg"
                  style={{ background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint }}
                >
                  <Icon size={13} />
                </span>
                <p className="text-xs font-medium">{title}</p>
              </div>
              <p className="mt-1.5 truncate text-sm font-semibold">{main}</p>
              <p className="mt-0.5 truncate text-[11px] text-ink-3">{sub}</p>
            </button>
          );
        })}
      </div>

      {/* 粒度切换 chips（与首页筛选 chips 同样式） */}
      <div className="flex gap-2">
        {GRAIN_CHIPS.map(([g, label]) => (
          <button
            key={g}
            onClick={() => {
                void haptic('select');
                setGrain(g);
              }}
            className={`h-8 rounded-full border px-3.5 text-xs transition-all active:scale-95 ${
              grain === g ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line bg-surface text-ink-3'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 时间窗口切换 */}
      <div className="flex items-center justify-between rounded-card border border-line bg-surface px-3 py-2">
        <button onClick={() => step(-1)} className="h-8 w-8 rounded-btn text-ink-2" aria-label="上一期">
          ‹
        </button>
        <div className="text-center">
          <p className="text-sm font-semibold">{windowLabel}</p>
          <p className="text-[11px] text-ink-3">
            支出 {formatMoney(expense, currency)} · 收入 {formatMoney(income, currency)}
          </p>
        </div>
        {grain === 'day' ? (
          <input
            type="date"
            value={day}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            aria-label="选择日期"
            className="h-8 w-32 rounded-btn border border-line bg-surface-2 px-1.5 text-[11px] text-ink-2 outline-none focus:border-accent"
          />
        ) : (
          <button onClick={() => step(1)} className="h-8 w-8 rounded-btn text-ink-2" aria-label="下一期">
            ›
          </button>
        )}
      </div>

      {/* 流水列表（只统计生活流记账）；桌面端按日分节排两栏，手机端不变 */}
      <div className="space-y-3 dt:grid dt:grid-cols-2 dt:items-start dt:gap-x-5 dt:space-y-0">
        {grain === 'year' ? renderYearGroups() : renderDayGroups(activeRows)}
      </div>

      {/* 心动清单 / 冷静池管理弹层 */}
      {wishOpen ? <WishSheet onClose={() => setWishOpen(false)} /> : null}
      {coolOpen ? <CooldownSheet onClose={() => setCoolOpen(false)} /> : null}
      {moodOpen ? <MoodSheet onClose={() => setMoodOpen(false)} /> : null}
      {timeOpen ? <TimeSheet onClose={() => setTimeOpen(false)} /> : null}
    </div>
  );
}
