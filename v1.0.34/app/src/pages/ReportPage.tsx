import { useMemo, useState } from 'react';
import { Brain, Heart, Hourglass, Snowflake, Sprout } from 'lucide-react';
import CategoryGlyph from '../components/CategoryGlyph';
import { cooldownExpired } from '../components/LifeSheets';
import QuickSheetHost from '../components/QuickSheets';
import { useDataStore, useSettingsStore } from '../store';
import { categoryShare, judgementBreakdown } from '../domain/stats';
import type { CategorySlice } from '../domain/stats';
import { ofMonth, sumExpense, sumIncome } from '../domain/ledger';
import { formatMoney, formatCompactMoney } from '../lib/money';
import { haptic } from '../lib/haptics';
import { addDays, fmtDate, lastNDays, lastNMonths, monthKey, monthLabel, nextMonth, prevMonth, relativeDayLabel, today } from '../lib/date';
import type { ValueRecord } from '../types/entities';
import type { SheetKey } from '../lib/sheetBus';

/** P08 报表：按日/月/年三态粒度看分类环图 + 趋势 + 归/需/否（全部只统计生活流记账）。 */

type Grain = 'day' | 'month' | 'year';

const GRAIN_CHIPS: Array<[Grain, string]> = [
  ['day', '按日'],
  ['month', '按月'],
  ['year', '按年'],
];

const J_META = {
  gui: { label: '归', desc: '值得的花销' },
  xu: { label: '需', desc: '必要的花销' },
  fou: { label: '否', desc: '本可避免' },
} as const;

/** 分钟 → 「3h40m / 50m」人类可读。 */
function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** 环图（自绘 SVG，stroke-dasharray 分段）。 */
function Donut({ slices, total }: { slices: CategorySlice[]; total: number }) {
  const R = 54;
  const C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <svg viewBox="0 0 140 140" className="h-36 w-36 shrink-0">
      <circle cx="70" cy="70" r={R} fill="none" stroke="var(--line)" strokeWidth="16" />
      {slices.map((s) => {
        const dash = s.ratio * C;
        const el = (
          <circle
            key={s.categoryId}
            cx="70"
            cy="70"
            r={R}
            fill="none"
            stroke={s.color}
            strokeWidth="16"
            strokeDasharray={`${Math.max(dash - 1.5, 0)} ${C}`}
            strokeDashoffset={-acc}
            transform="rotate(-90 70 70)"
          />
        );
        acc += dash;
        return el;
      })}
      <text x="70" y="64" textAnchor="middle" fontSize="10" className="fill-ink-3">
        本月支出
      </text>
      <text x="70" y="82" textAnchor="middle" fontSize="14" fontWeight="700" className="fill-ink">
        {formatCompactMoney(total)}
      </text>
    </svg>
  );
}

/**
 * v1.0.21 · M3.2 净值趋势：折线 + 面积（净额 = 收入 − 支出）。
 * 正 → var(--gui)，负 → var(--fou)；零轴虚线参考。
 * SVG 用 preserveAspectRatio="none" 撑满容器宽度，所有描边加
 * vector-effect="non-scaling-stroke"，避免横向拉伸把线宽也拉变形。
 */
function NetTrend({
  points,
  currency,
}: {
  points: Array<{ key: string; label: string; net: number }>;
  currency: string;
}) {
  const W = 320;
  const H = 92;
  const PAD = 8;
  const nets = points.map((p) => p.net);
  const lo = Math.min(0, ...nets);
  const hi = Math.max(0, ...nets);
  const span = hi - lo || 1;
  const stepX = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const yOf = (v: number): number => PAD + (H - PAD * 2) * ((hi - v) / span);
  const zeroY = yOf(0);
  const line = points.map((p, i) => `${(PAD + i * stepX).toFixed(1)},${yOf(p.net).toFixed(1)}`).join(' ');
  const last = nets[nets.length - 1] ?? 0;
  const color = last >= 0 ? 'var(--gui)' : 'var(--fou)';
  const total = Math.round(nets.reduce((a, b) => a + b, 0) * 100) / 100;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[92px] w-full dt:h-[136px]" style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="netTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.26" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line
          x1={PAD}
          x2={W - PAD}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--line-2)"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        <polygon points={`${PAD},${zeroY} ${line} ${W - PAD},${zeroY}`} fill="url(#netTrendFill)" />
        <polyline
          points={line}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.map((p, i) => (
          <line
            key={p.key}
            x1={PAD + i * stepX}
            x2={PAD + i * stepX}
            y1={yOf(p.net)}
            y2={zeroY}
            stroke={color}
            strokeOpacity={0.22}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="mt-1 flex justify-between px-1">
        {points.map((p) => (
          <span key={p.key} className="truncate text-[11px] text-ink-3">
            {p.label}
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-ink-3">
        <span>
          本期净额{' '}
          <b style={{ color }}>
            {last >= 0 ? '+' : ''}
            {formatMoney(last, currency)}
          </b>
        </span>
        <span>
          区间累计 <b className="text-ink-2">{formatMoney(total, currency)}</b>
        </span>
      </div>
    </div>
  );
}

/** P08 报表：分类环图 + 趋势 + 归/需/否结构（支持日/月/年三种粒度）。 */
export default function ReportPage() {
  const records = useDataStore((s) => s.valueRecords);
  const categories = useDataStore((s) => s.categories);
  const currency = useSettingsStore((s) => s.settings.currency);
  /* v1.0.24 · 生活流四集合（报表理智指数板块数据源）。 */
  const wishlist = useDataStore((s) => s.wishlist);
  const cooldowns = useDataStore((s) => s.cooldowns);
  const moods = useDataStore((s) => s.moods);
  const times = useDataStore((s) => s.times);

  const [grain, setGrain] = useState<Grain>('month');
  const [day, setDay] = useState(() => today());
  const [ym, setYm] = useState(() => monthKey());
  const [year, setYear] = useState(() => Number(monthKey().slice(0, 4)));

  /* —— 三种粒度的时间窗口（口径：只统计生活流 valueRecords，不含物品/订阅） —— */
  const windowRows = useMemo<ValueRecord[]>(() => {
    if (grain === 'day') return records.filter((r) => r.date === day);
    if (grain === 'month') return ofMonth(records, ym);
    return records.filter((r) => r.date.startsWith(String(year)));
  }, [records, grain, day, ym, year]);

  const expense = useMemo(() => sumExpense(windowRows), [windowRows]);
  const income = useMemo(() => sumIncome(windowRows), [windowRows]);

  const slices = useMemo(() => categoryShare(windowRows, categories, { type: 'expense' }), [windowRows, categories]);
  const stack = useMemo(() => judgementBreakdown(windowRows), [windowRows]);

  /** 趋势柱：按日 → 近 7 天；按月 → 近 6 个月；按年 → 该年 12 个月。 */
  const trend = useMemo(() => {
    if (grain === 'month') {
      return lastNMonths(6, `${ym}-01`).map((m) => {
        const list = ofMonth(records, m);
        return { key: m, label: monthLabel(m), expense: sumExpense(list), income: sumIncome(list) };
      });
    }
    if (grain === 'day') {
      return lastNDays(7, day).map((d) => {
        const list = records.filter((r) => r.date === d);
        return { key: d, label: fmtDate(d, 'M/D'), expense: sumExpense(list), income: sumIncome(list) };
      });
    }
    return Array.from({ length: 12 }, (_, i) => {
      const m = `${year}-${String(i + 1).padStart(2, '0')}`;
      const list = records.filter((r) => r.date.startsWith(m));
      return { key: m, label: `${i + 1}月`, expense: sumExpense(list), income: sumIncome(list) };
    });
  }, [grain, records, day, ym, year]);

  const maxBar = Math.max(...trend.map((b) => Math.max(b.expense, b.income)), 1);

  /** v1.0.21 · M3.2：净值序列（收入 − 支出），供折线图使用。 */
  const netPoints = useMemo(
    () => trend.map((b) => ({ key: b.key, label: b.label, net: Math.round((b.income - b.expense) * 100) / 100 })),
    [trend],
  );

  /** 粒度切换器的 ‹ › 步进。 */
  const step = (dir: -1 | 1) => {
    if (grain === 'day') setDay(addDays(day, dir));
    else if (grain === 'month') setYm(dir === -1 ? prevMonth(ym) : nextMonth(ym));
    else setYear((y) => y + dir);
  };

  /** v1.0.24 · 生活流统计：理智指数（时间健康度）+ 心动 + 冲动拦截 + 情绪晴雨。
   *  口径：times/moods 按 date（YYYY-MM-DD）；wishlist/cooldowns 按 createdAt（ISO）切片。 */
  const life = useMemo(() => {
    // 旧备份（v1.0.22 前）的 moods/times 没有 date 字段 → 兜底空串，绝不给 undefined 用
    const inWin = (d: string | undefined) => {
      const k = d ?? '';
      return grain === 'day' ? k === day : grain === 'month' ? k.startsWith(ym) : k.startsWith(String(year));
    };
    const ts = times.filter((t) => inWin(t.date));
    const ms = moods.filter((m) => inWin(m.date));
    const wl = wishlist.filter((w) => inWin(w.createdAt.slice(0, 10)));
    const cl = cooldowns.filter((c) => inWin(c.createdAt.slice(0, 10)));
    const guiMin = ts.filter((t) => t.meaning === 'gui').reduce((s, t) => s + t.durationMin, 0);
    const xuMin = ts.filter((t) => t.meaning === 'xu').reduce((s, t) => s + t.durationMin, 0);
    const fouMin = ts.filter((t) => t.meaning === 'fou').reduce((s, t) => s + t.durationMin, 0);
    const totalMin = guiMin + xuMin + fouMin;
    const health = totalMin > 0 ? Math.round(((guiMin + xuMin) / totalMin) * 100) : null;
    return {
      tsCount: ts.length,
      guiMin,
      xuMin,
      fouMin,
      totalMin,
      health,
      wishCount: wl.length,
      wishSum: wl.reduce((s, w) => s + (w.price ?? 0), 0),
      coolCount: cl.length,
      coolAmount: cl.reduce((s, c) => s + (c.amount ?? 0), 0),
      coolHold: cooldowns.filter((c) => cooldownExpired(c)).length,
      moodCount: ms.length,
      moodHeart: ms.filter((m) => m.inHeart).length,
      moodCrush: ms.filter((m) => m.crushed).length,
    };
  }, [grain, day, ym, year, times, moods, wishlist, cooldowns]);

  /** v1.0.30 · 生活流 chips 就地弹层：不再跳转账本页，关闭后停留在报表页。 */
  const [lifeSheet, setLifeSheet] = useState<SheetKey | null>(null);
  const openLife = (key: SheetKey): void => {
    void haptic('select');
    setLifeSheet(key);
  };

  /** ★v1.0.33：柱状图点选——此前只画柱子不给数字，手机上看不出金额。 */
  const [barKey, setBarKey] = useState<string | null>(null);
  const shownBar = useMemo(() => trend.find((b) => b.key === barKey) ?? null, [trend, barKey]);
  const currentKey = grain === 'day' ? day : grain === 'month' ? ym : '';

  /* ★v1.0.33 P0-4：中间档改用 --tint-warm 令牌（原写死 #c98a2d）。 */
  const healthTint =
    life.health === null ? 'var(--ink-3)' : life.health >= 70 ? 'var(--gui)' : life.health >= 40 ? 'var(--tint-warm)' : 'var(--fou)';

  const windowLabel =
    grain === 'day'
      ? `${relativeDayLabel(day)} · ${day}`
      : grain === 'month'
        ? monthLabel(ym, true)
        : `${year} 年`;

  const trendTitle =
    grain === 'day' ? '近 7 天趋势' : grain === 'month' ? '近 6 个月趋势' : `${year} 年逐月趋势`;

  return (
    <div className="text-ink">
      {/* 自绘 Tab 头（底栏页不带返回箭头；safe-area 由 MainShell 外层统一处理） */}
      {/* 宽度/边距全部交给 MainShell 的 main（max-w-xl px-4），页面不再自带宽度容器 */}
      <header className="page-enter flex w-full items-end justify-between pb-1 pt-2">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold leading-9">报表</h1>
          <p className="truncate text-xs text-ink-3">{windowLabel} · 仅统计生活流记账</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => step(-1)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-ink-2 active:scale-95 active:bg-surface transition-transform"
            aria-label="上一期"
          >
            ‹
          </button>
          {grain === 'day' ? (
            <input
              type="date"
              value={day}
              onChange={(e) => e.target.value && setDay(e.target.value)}
              aria-label="选择日期"
              className="h-9 w-32 rounded-btn border border-line bg-surface px-1.5 text-[11px] text-ink-2 outline-none focus:border-accent"
            />
          ) : null}
          <button
            onClick={() => step(1)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-ink-2 active:scale-95 active:bg-surface transition-transform"
            aria-label="下一期"
          >
            ›
          </button>
        </div>
      </header>
      {/* ★v1.0.25 PC 重构：12 列桌面栅格（环图5+趋势7 / 净值7+归需否5 / 生活流整行），
          间距统一交给 grid gap，卡片不再自带 mt-3。 */}
      <div className="grid grid-cols-1 gap-3 dt:grid-cols-12">
        {/* 粒度切换 chips（与首页筛选 chips 同样式） */}
        <div className="mb-1 flex gap-2 dt:col-span-12">
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

        {/* ★v1.0.33：顶部概览条——此前页头只有标题+小字，下方留白显得空落 */}
        <div className="page-enter grid grid-cols-3 gap-2 rounded-card border border-line bg-surface p-3 dt:col-span-12">
          <div className="text-center">
            <p className="text-[11px] text-ink-3">支出</p>
            <p className="tnum mt-0.5 text-base font-semibold">{formatMoney(expense, currency)}</p>
          </div>
          <div className="border-x border-line-2 text-center">
            <p className="text-[11px] text-ink-3">收入</p>
            <p className="tnum mt-0.5 text-base font-semibold">{formatMoney(income, currency)}</p>
          </div>
          <div className="text-center">
            <p className="text-[11px] text-ink-3">结余</p>
            <p className="tnum mt-0.5 text-base font-semibold" style={{ color: income - expense >= 0 ? 'var(--gui)' : 'var(--fou)' }}>
              {formatMoney(income - expense, currency)}
            </p>
          </div>
        </div>

        {/* 分类环图 */}
        <div className="page-enter rounded-card border border-line bg-surface p-4 dt:col-span-7">
          <h2 className="text-sm font-semibold dt:text-[15px]">支出分类占比</h2>
          <p className="mt-0.5 text-[11px] text-ink-3">仅统计生活流记账（物品与订阅不计入）</p>
          {slices.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-3">
              {grain === 'day' ? '今天' : grain === 'month' ? '本月' : '本年'}还没有支出记录
            </p>
          ) : (
            <div className="mt-3 flex items-center gap-4">
              <Donut slices={slices} total={expense} />
              <ul className="min-w-0 flex-1 space-y-1.5">
                {slices.slice(0, 6).map((s) => (
                  <li key={s.categoryId} className="flex items-center gap-2 text-xs">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
                      <CategoryGlyph id={s.icon} size={14} className="shrink-0 text-ink-2" />
                      {s.name}
                    </span>
                    <span className="text-ink-3">{Math.round(s.ratio * 100)}%</span>
                    <span className="w-16 text-right font-medium">{formatCompactMoney(s.amount, currency)}</span>
                  </li>
                ))}
                {slices.length > 6 ? (
                  <li className="pl-5 text-[11px] text-ink-3">其余 {slices.length - 6} 个分类…</li>
                ) : null}
              </ul>
            </div>
          )}
        </div>

        {/* 趋势与净值趋势已下移到「生活流」之后（v1.0.33 布局重排：占比/生活流前置，趋势后置） */}

        {/* 归 / 需 / 否 结构：v1.0.33 起排在「生活流」之后（占比 + 生活流状态前置） */}

        {/* v1.0.24 · 生活流板块：理智指数（时间健康度）+ 心动清单 + 冲动拦截 + 情绪晴雨（v1.0.33 与占比并排） */}
        <div className="page-enter rounded-card border border-line bg-surface p-4 dt:col-span-5">
          <div className="flex items-baseline justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Brain size={15} style={{ color: 'var(--accent)' }} />
              生活流 · 理智指数
            </h2>
            <div className="flex shrink-0 gap-1">
              {(
                [
                  ['time', '时间', Hourglass],
                  ['wish', '心动', Sprout],
                  ['mood', '情绪', Heart],
                ] as Array<[SheetKey, string, typeof Hourglass]>
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  onClick={() => openLife(key)}
                  className="flex h-7 items-center gap-1 rounded-full border border-line bg-surface-2 px-2.5 text-[11px] text-ink-2 active:scale-95"
                >
                  <Icon size={12} />
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-0.5 text-[11px] text-ink-3">统计心动清单 / 购物冷静 / 时间切片 / 情绪速写（随上方粒度切换）</p>

          {/* 主指标：时间健康度 = 归 + 需 时长占全部时间切片之比 */}
          <div className="mt-3 flex items-center gap-4 rounded-card bg-surface-2 p-3.5">
            <div className="shrink-0 text-center">
              <p className="tnum text-3xl font-bold leading-none dt:text-4xl" style={{ color: healthTint }}>
                {life.health ?? '—'}
              </p>
              <p className="mt-1 text-[11px] text-ink-3">时间健康度</p>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-ink-2">归 + 需 时长占全部时间切片的比例</p>
              {life.totalMin > 0 ? (
                <>
                  <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-surface">
                    <div style={{ width: `${(life.guiMin / life.totalMin) * 100}%`, background: 'var(--gui)' }} />
                    <div style={{ width: `${(life.xuMin / life.totalMin) * 100}%`, background: 'var(--xu)' }} />
                    <div style={{ width: `${(life.fouMin / life.totalMin) * 100}%`, background: 'var(--fou)' }} />
                  </div>
                  <p className="mt-1.5 text-[11px] text-ink-3">
                    归 {fmtMin(life.guiMin)} · 需 {fmtMin(life.xuMin)} · 否 {fmtMin(life.fouMin)}（共 {life.tsCount} 段 ·{' '}
                    {fmtMin(life.totalMin)}）
                  </p>
                </>
              ) : (
                <p className="mt-2 text-[11px] text-ink-3">本期还没有时间切片，记一段试试</p>
              )}
            </div>
          </div>

          {/* 三小卡：心动清单 / 冲动拦截 / 情绪晴雨（桌面窄栏内竖排）
              ★v1.0.33 P0-4：tint 收敛语义令牌；小号文字用 ink-2 保对比度，tint 只上图标与描边 */}
          <div className="mt-2.5 grid grid-cols-3 gap-2.5 dt:grid-cols-1">
            <div
              className="rounded-card border border-line p-3"
              style={{ borderColor: 'color-mix(in srgb, var(--tint-warm) 28%, transparent)' }}
            >
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                <Sprout size={13} style={{ color: 'var(--tint-warm)' }} />
                心动清单
              </p>
              <p className="mt-1.5 text-lg font-semibold leading-none">{life.wishCount} 件</p>
              <p className="mt-1 text-[11px] text-ink-3">合计 {formatMoney(life.wishSum, currency)}</p>
            </div>
            <div
              className="rounded-card border border-line p-3"
              style={{ borderColor: 'color-mix(in srgb, var(--tint-cool) 28%, transparent)' }}
            >
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                <Snowflake size={13} style={{ color: 'var(--tint-cool)' }} />
                冲动拦截
              </p>
              <p className="mt-1.5 text-lg font-semibold leading-none">入池 {life.coolCount} 件</p>
              <p className="mt-1 text-[11px] text-ink-3">
                到期未动 {life.coolHold} 件 · 涉及 {formatMoney(life.coolAmount, currency)}
              </p>
            </div>
            <div
              className="rounded-card border border-line p-3"
              style={{ borderColor: 'color-mix(in srgb, var(--tint-clay) 28%, transparent)' }}
            >
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                <Heart size={13} style={{ color: 'var(--tint-clay)' }} />
                情绪晴雨
              </p>
              <p className="mt-1.5 text-lg font-semibold leading-none">{life.moodCount} 次</p>
              <p className="mt-1 text-[11px] text-ink-3">
                归入心底 {life.moodHeart} · 粉碎 {life.moodCrush}
              </p>
            </div>
          </div>
        </div>

        {/* 归 / 需 / 否 */}
        <div className="page-enter rounded-card border border-line bg-surface p-4 dt:col-span-12">
          <h2 className="text-sm font-semibold dt:text-[15px]">归 / 需 / 否 结构</h2>
          <p className="mt-0.5 text-[11px] text-ink-3">仅统计生活流记账（物品与订阅不计入）</p>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-2">
            {stack.map((s) => (
              <div key={s.judgement} style={{ width: `${s.ratio * 100}%`, background: s.color }} />
            ))}
          </div>
          <ul className="mt-3 space-y-2.5 dt:grid dt:grid-cols-3 dt:gap-4 dt:space-y-0">
            {stack.map((s) => (
              <li key={s.judgement}>
                <div className="flex items-baseline justify-between text-xs">
                  <span style={{ color: s.color }}>
                    {s.label} · {J_META[s.judgement].desc}
                  </span>
                  <span>
                    <span className="font-semibold">{formatMoney(s.amount, currency)}</span>
                    <span className="ml-1.5 text-ink-3">{Math.round(s.ratio * 100)}%</span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div style={{ width: `${s.ratio * 100}%`, background: s.color }} className="h-full rounded-full" />
                </div>
              </li>
            ))}
          </ul>
          {expense === 0 ? (
            <p className="mt-2 text-[11px] text-ink-3">
              {grain === 'day' ? '今天' : grain === 'month' ? '本月' : '本年'}暂无支出，先去记一笔吧
            </p>
          ) : null}
        </div>

        {/* ★v1.0.33 · 趋势（后置）：柱顶直接给金额，点柱子看该期收/支/结余明细 */}
        <div className="page-enter rounded-card border border-line bg-surface p-4 dt:col-span-12">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold dt:text-[15px]">{trendTitle}</h2>
            <p className="text-[11px] text-ink-3">
              <span className="mr-2 inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full bg-accent" />
                支出
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: 'var(--xu)' }} />
                收入
              </span>
            </p>
          </div>
          <div className="mt-4 flex items-end justify-between gap-1.5">
            {trend.map((b) => {
              const on = barKey === b.key;
              return (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => {
                    void haptic('select');
                    setBarKey(on ? null : b.key);
                  }}
                  aria-label={`${b.label} 支出 ${formatMoney(b.expense, currency)} 收入 ${formatMoney(b.income, currency)}`}
                  className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-btn pb-1 pt-0.5 transition-colors ${
                    on ? 'bg-surface-2' : ''
                  }`}
                >
                  <span className={`tnum h-3.5 text-[11px] leading-none ${on ? 'font-semibold text-accent' : 'text-ink-3'}`}>
                    {b.expense > 0 ? formatCompactMoney(b.expense, currency) : ''}
                  </span>
                  <div className="flex h-28 w-full items-end justify-center gap-1 dt:h-40">
                    <div
                      className="w-3.5 rounded-t bg-accent transition-all dt:w-6"
                      style={{ height: `${Math.max((b.expense / maxBar) * 100, b.expense > 0 ? 3 : 0)}%` }}
                    />
                    <div
                      className="w-3.5 rounded-t transition-all dt:w-6"
                      style={{
                        height: `${Math.max((b.income / maxBar) * 100, b.income > 0 ? 3 : 0)}%`,
                        background: 'var(--xu)',
                      }}
                    />
                  </div>
                  <span
                    className={`text-[11px] ${
                      b.key === currentKey ? 'font-semibold text-accent' : on ? 'text-ink-2' : 'text-ink-3'
                    }`}
                  >
                    {b.label}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            {shownBar
              ? `${shownBar.label}：支出 ${formatMoney(shownBar.expense, currency)} · 收入 ${formatMoney(shownBar.income, currency)} · 结余 ${formatMoney(shownBar.income - shownBar.expense, currency)}`
              : '点柱子看该期收支金额'}
          </p>
        </div>

        {/* v1.0.21 · M3.2：净值趋势（收入 − 支出）；v1.0.33 起置于最后 */}
        <div className="page-enter rounded-card border border-line bg-surface p-4 dt:col-span-12">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold dt:text-[15px]">净值趋势</h2>
            <p className="text-[11px] text-ink-3">{trendTitle.replace('趋势', '')} · 收入 − 支出</p>
          </div>
          <div className="mt-3">
            <NetTrend points={netPoints} currency={currency} />
          </div>
        </div>
      </div>

      {/* v1.0.28 · 生活流 chips 就地弹层（时间/心动/情绪），关闭后停留在报表页 */}
      {lifeSheet ? <QuickSheetHost sheetKey={lifeSheet} onClose={() => setLifeSheet(null)} /> : null}
    </div>
  );
}
