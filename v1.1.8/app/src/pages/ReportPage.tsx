import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brain, Heart, Hourglass, Snowflake, Sprout, Sparkles } from 'lucide-react';
import CategoryGlyph from '../components/CategoryGlyph';
import { cooldownExpired } from '../components/LifeSheets';
import QuickSheetHost from '../components/QuickSheets';
import { useDataStore, useSettingsStore } from '../store';
import { categoryShare, judgementBreakdown } from '../domain/stats';
import type { CategorySlice } from '../domain/stats';
import { ofMonth, sumExpense, sumIncome } from '../domain/ledger';
import { formatMoney, formatCompactMoney, formatNetMoney, round } from '../lib/money';
import { haptic } from '../lib/haptics';
import { analyze, type AnalyzeInput, type AnalyzeOutcome } from '../ai/analyzeService';
import { aiConfigOf, isAiConfigured } from '../ai/parseService';
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
    <svg viewBox="0 0 140 140" className="h-36 w-36 shrink-0 dt:h-44 dt:w-44">
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
 *
 * ★v1.0.35：新增点击反馈——每期一个透明热区，点中后落点显示圆点，
 * 下方给出该期「收入/支出/净额」明细；默认提示可点。负号修正
 * （formatNetMoney），此前 -47.59 被显示成 47.59。
 */
function NetTrend({
  points,
  currency,
  selectedKey,
  onSelect,
}: {
  points: Array<{ key: string; label: string; net: number; expense: number; income: number }>;
  currency: string;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
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
  const selected = points.find((p) => p.key === selectedKey) ?? null;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[92px] w-full dt:h-[176px]" style={{ overflow: 'visible' }}>
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
        {/* ★v1.0.35：选中期的落点 */}
        {selected ? (
          <circle
            cx={PAD + points.findIndex((p) => p.key === selected.key) * stepX}
            cy={yOf(selected.net)}
            r={4}
            fill={color}
            stroke="var(--surface)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {/* ★v1.0.35：透明点击热区（每期一列，覆盖整高） */}
        {points.map((p, i) => (
          <rect
            key={`hit-${p.key}`}
            x={PAD + Math.max(0, i * stepX - stepX / 2)}
            y={0}
            width={Math.max(stepX, W / points.length)}
            height={H}
            fill="transparent"
            className="cursor-pointer"
            onClick={() => onSelect(selectedKey === p.key ? null : p.key)}
          />
        ))}
      </svg>
      <div className="mt-1 flex justify-between px-1">
        {points.map((p) => (
          <span
            key={p.key}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(selectedKey === p.key ? null : p.key)}
            className={`cursor-pointer truncate text-[11px] ${selectedKey === p.key ? 'font-semibold text-ink-2' : 'text-ink-3'}`}
          >
            {p.label}
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-ink-3">
        <span>
          本期净额{' '}
          <b style={{ color }}>
            {formatNetMoney(last, currency)}
          </b>
        </span>
        <span>
          区间累计 <b className="text-ink-2">{formatNetMoney(total, currency)}</b>
        </span>
      </div>
      {/* ★v1.0.35：点击反馈明细（与柱状图同款交互） */}
      <p className="mt-2 rounded-btn bg-surface-2 px-3 py-2 text-[11px] text-ink-3">
        {selected
          ? `${selected.label}：收入 ${formatMoney(selected.income, currency)} · 支出 ${formatMoney(selected.expense, currency)} · 净额 ${formatNetMoney(selected.net, currency)}${selected.net < 0 ? '（花得比收得多）' : ''}`
          : '点折线或月份，看该期收/支与净额明细'}
      </p>
    </div>
  );
}

/** P08 报表：分类环图 + 趋势 + 归/需/否结构（支持日/月/年三种粒度）。 */
export default function ReportPage() {
  const nav = useNavigate();
  const records = useDataStore((s) => s.valueRecords);
  const categories = useDataStore((s) => s.categories);
  const currency = useSettingsStore((s) => s.settings.currency);
  const settings = useSettingsStore((s) => s.settings);
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

  /** v1.0.21 · M3.2：净值序列（收入 − 支出），供折线图使用。
   *  ★v1.0.35：带上 expense/income，点选折线时展示单期明细。 */
  const netPoints = useMemo(
    () => trend.map((b) => ({ key: b.key, label: b.label, net: Math.round((b.income - b.expense) * 100) / 100, expense: b.expense, income: b.income })),
    [trend],
  );

  /** ★v1.0.35：净值趋势点选（null = 未选中，显示提示文案）。 */
  const [netSel, setNetSel] = useState<string | null>(null);
  useEffect(() => {
    setNetSel(null);
  }, [grain, day, ym, year]);

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
  /** ★v1.0.35：「结余」口径解释展开态。 */
  const [netOpen, setNetOpen] = useState(false);
  useEffect(() => {
    setNetOpen(false);
  }, [grain, day, ym, year]);
  /** ★v1.0.35：净值趋势「怎么读」展开态。 */
  const [netHow, setNetHow] = useState(false);

  /** ★v1.1.3 · AI 分析（本地规则洞察 + AI 点评；粒度切换后作废重算）。 */
  const [analysis, setAnalysis] = useState<AnalyzeOutcome | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  useEffect(() => {
    setAnalysis(null);
  }, [grain, day, ym, year]);

  /** 组装分析 payload（与页面展示同源：同一份 windowRows / slices / stack / trend）。 */
  const analysisInput = (): AnalyzeInput => ({
    windowLabel,
    currency,
    income,
    expense,
    topCategories: slices.slice(0, 5).map((s) => ({ name: s.name, amount: s.amount, ratio: s.ratio })),
    judgement: stack.map((s) => ({ label: s.label, amount: s.amount, ratio: s.ratio })),
    trend: trend.map((b) => ({ label: b.label, expense: b.expense, income: b.income })),
    // v1.1.3：转卖净赚（src='goods-sale' 的收入记录）也是本期收入的一部分
    saleProfit: round(
      windowRows.filter((r) => r.src === 'goods-sale').reduce((s, r) => s + r.amount, 0),
    ),
    recordCount: windowRows.length,
  });

  const runAnalyze = async (): Promise<void> => {
    if (analyzing) return;
    setAnalyzing(true);
    try {
      const out = await analyze(analysisInput(), settings);
      setAnalysis(out);
      if (out.source === 'ai') void haptic('success');
    } finally {
      setAnalyzing(false);
    }
  };

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
      <header className="page-enter flex w-full items-end justify-between pb-1 pt-2 dt:items-center dt:pb-3">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold leading-9 dt:text-[32px] dt:leading-none">报表</h1>
          <p className="truncate text-xs text-ink-3 dt:mt-2 dt:text-[13px]">{windowLabel} · 看清钱花在哪、花得值不值</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => step(-1)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-ink-2 transition-transform active:scale-95 active:bg-surface dt:hover:bg-surface-2"
            aria-label="上一期"
          >
            ‹
          </button>
          {/* ★PC：期次做成居中的胶囊标签（手机上这段信息在副标题里，故隐藏） */}
          <span className="hidden dt:inline-flex dt:h-9 dt:min-w-[150px] dt:items-center dt:justify-center dt:rounded-full dt:border dt:border-line dt:bg-surface dt:px-4 dt:text-xs dt:font-medium">
            {windowLabel}
          </span>
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
            className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-ink-2 transition-transform active:scale-95 active:bg-surface dt:hover:bg-surface-2"
            aria-label="下一期"
          >
            ›
          </button>
        </div>
      </header>
      {/* ★v1.1.8 PC 重排：12 列桌面栅格 + dt:order 重排（手机端顺序与样式完全不变）
          —— 概览条 → 占比|生活流 → 趋势|归需否 → 净值|AI，两块一行，减少上下滚动。 */}
      <div className="grid grid-cols-1 gap-3 dt:grid-cols-12 dt:gap-4">
        {/* 粒度切换 chips（与首页筛选 chips 同样式） */}
        <div className="mb-1 flex items-center gap-2 dt:col-span-12 dt:order-1 dt:mb-0 dt:gap-2.5">
          {GRAIN_CHIPS.map(([g, label]) => (
            <button
              key={g}
              onClick={() => {
                void haptic('select');
                setGrain(g);
              }}
              className={`h-8 rounded-full border px-3.5 text-xs transition-all active:scale-95 dt:h-9 dt:px-4 dt:text-[13px] ${
                grain === g ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line bg-surface text-ink-3 dt:hover:text-ink-2'
              }`}
            >
              {label}
            </button>
          ))}
          {/* PC：这一期一共记了几笔（手机上不显示，避免多一行） */}
          <p className="ml-auto hidden text-[11px] text-ink-3 dt:block">本期 {windowRows.length} 笔流水</p>
        </div>

        {/* ★v1.0.33：顶部概览条——此前页头只有标题+小字，下方留白显得空落
            ★v1.0.35：① 结余改带符号显示（此前 -47.59 显示成 47.59，红字让人
            误读成「还剩 47.59」）；② 点「结余」展开口径解释。 */}
        <div className="page-enter rounded-card border border-line bg-surface p-3 dt:col-span-12 dt:order-2 dt:p-0">
          <div className="grid grid-cols-3 gap-2 dt:gap-0">
            <div className="text-center dt:px-7 dt:py-5 dt:text-left">
              <p className="text-[11px] text-ink-3 dt:text-xs">支出</p>
              <p className="tnum mt-0.5 text-base font-semibold dt:mt-2 dt:text-[26px] dt:leading-none">{formatMoney(expense, currency)}</p>
            </div>
            <div className="border-x border-line-2 text-center dt:px-7 dt:py-5 dt:text-left">
              <p className="text-[11px] text-ink-3 dt:text-xs">收入</p>
              <p className="tnum mt-0.5 text-base font-semibold dt:mt-2 dt:text-[26px] dt:leading-none">{formatMoney(income, currency)}</p>
            </div>
            <button
              type="button"
              onClick={() => setNetOpen((v) => !v)}
              aria-expanded={netOpen}
              className="text-center transition-opacity active:opacity-60 dt:px-7 dt:py-5 dt:text-left dt:hover:opacity-80"
            >
              <p className="text-[11px] text-ink-3 dt:text-xs">
                结余
                <span className="ml-0.5 inline-block h-3.5 w-3.5 rounded-full border border-line-2 text-[9px] leading-[13px] text-ink-3">?</span>
              </p>
              <p className="tnum mt-0.5 text-base font-semibold dt:mt-2 dt:text-[26px] dt:leading-none" style={{ color: income - expense >= 0 ? 'var(--gui)' : 'var(--fou)' }}>
                {formatNetMoney(income - expense, currency)}
              </p>
            </button>
          </div>
          {netOpen ? (
            <p className="mt-2 rounded-btn bg-surface-2 px-3 py-2 text-[11px] leading-5 text-ink-3 dt:mt-0 dt:rounded-none dt:border-t dt:border-line-2 dt:px-7 dt:py-4 dt:text-xs">
              <b className="text-ink-2">结余 = 收入 − 支出</b>＝ {formatMoney(income, currency)} − {formatMoney(expense, currency)} ＝{' '}
              {formatNetMoney(income - expense, currency)}。
              {income - expense < 0
                ? '没有收入记录时，结余就等于 −支出：红字表示「这个周期花出去的钱」，不是你还欠了多少。'
                : '绿字表示这个周期收进来的比花出去的多。'}
            </p>
          ) : null}
        </div>

        {/* 分类环图 */}
        <div className="page-enter rounded-card border border-line bg-surface p-4 dt:col-span-5 dt:order-3 dt:p-5">
          <h2 className="text-sm font-semibold dt:text-[15px]">支出分类占比</h2>
          <p className="mt-0.5 text-[11px] text-ink-3 dt:text-xs">这一期钱主要花在了哪些地方</p>
          {slices.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-3">
              {grain === 'day' ? '今天' : grain === 'month' ? '本月' : '本年'}还没有支出记录
            </p>
          ) : (
            <div className="mt-3 flex items-center gap-4 dt:mt-6 dt:gap-6">
              <Donut slices={slices} total={expense} />
              <ul className="min-w-0 flex-1 space-y-1.5 dt:space-y-2.5">
                {slices.slice(0, 6).map((s) => (
                  <li key={s.categoryId} className="flex items-center gap-2 text-xs dt:text-[13px]">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
                      <CategoryGlyph id={s.icon} size={14} className="shrink-0 text-ink-2" />
                      {s.name}
                    </span>
                    <span className="text-ink-3">{Math.round(s.ratio * 100)}%</span>
                    <span className="w-16 text-right font-medium dt:w-20">{formatCompactMoney(s.amount, currency)}</span>
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

        {/* v1.0.24 · 生活流板块：理智指数（时间健康度）+ 心动清单 + 冲动拦截 + 情绪晴雨
            ★v1.1.8 PC：整行 12 列，内层「主指标 + 三小卡」排成一行 4 格（手机仍为上下两段） */}
        <div className="page-enter rounded-card border border-line bg-surface p-4 dt:col-span-12 dt:order-5 dt:p-5">
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
          <p className="mt-0.5 text-[11px] text-ink-3 dt:text-xs">统计心动清单 / 购物冷静 / 时间切片 / 情绪速写（随上方粒度切换）</p>

          {/* PC：主指标 + 三小卡同一行；手机上这个 wrapper 是透明块，不影响原布局 */}
          <div className="dt:mt-5 dt:grid dt:grid-cols-[1.35fr_1fr_1fr_1fr] dt:gap-3">
          {/* 主指标：时间健康度 = 归 + 需 时长占全部时间切片之比 */}
          <div className="mt-3 flex items-center gap-4 rounded-card bg-surface-2 p-3.5 dt:mt-0 dt:p-4">
            <div className="shrink-0 text-center">
              {/* ★v1.1.8：无数据时「—」用大字会渲染成一条横线（像分隔符），故降字号 */}
              <p
                className={`tnum text-3xl font-bold leading-none ${life.health === null ? 'text-ink-3 dt:text-2xl' : 'dt:text-[44px]'}`}
                style={{ color: healthTint }}
              >
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

          {/* 三小卡：心动清单 / 冲动拦截 / 情绪晴雨
              ★v1.0.33 P0-4：tint 收敛语义令牌；小号文字用 ink-2 保对比度，tint 只上图标与描边
              ★v1.1.8 PC：dt:contents 让三卡成为外层 4 格栅格的直接子项（手机仍为 3 列一行） */}
          <div className="mt-2.5 grid grid-cols-3 gap-2.5 dt:mt-0 dt:gap-3 dt:contents">
            <div
              className="rounded-card border border-line p-3 dt:p-4"
              style={{ borderColor: 'color-mix(in srgb, var(--tint-warm) 28%, transparent)' }}
            >
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                <Sprout size={13} style={{ color: 'var(--tint-warm)' }} />
                心动清单
              </p>
              <p className="mt-1.5 text-lg font-semibold leading-none dt:text-xl">{life.wishCount} 件</p>
              <p className="mt-1 text-[11px] text-ink-3">合计 {formatMoney(life.wishSum, currency)}</p>
            </div>
            <div
              className="rounded-card border border-line p-3 dt:p-4"
              style={{ borderColor: 'color-mix(in srgb, var(--tint-cool) 28%, transparent)' }}
            >
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                <Snowflake size={13} style={{ color: 'var(--tint-cool)' }} />
                冲动拦截
              </p>
              <p className="mt-1.5 text-lg font-semibold leading-none dt:text-xl">入池 {life.coolCount} 件</p>
              <p className="mt-1 text-[11px] text-ink-3">
                到期未动 {life.coolHold} 件 · 涉及 {formatMoney(life.coolAmount, currency)}
              </p>
            </div>
            <div
              className="rounded-card border border-line p-3 dt:p-4"
              style={{ borderColor: 'color-mix(in srgb, var(--tint-clay) 28%, transparent)' }}
            >
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
                <Heart size={13} style={{ color: 'var(--tint-clay)' }} />
                情绪晴雨
              </p>
              <p className="mt-1.5 text-lg font-semibold leading-none dt:text-xl">{life.moodCount} 次</p>
              <p className="mt-1 text-[11px] text-ink-3">
                归入心底 {life.moodHeart} · 粉碎 {life.moodCrush}
              </p>
            </div>
          </div>
          </div>
        </div>

        {/* 归 / 需 / 否 */}
        <div className="page-enter rounded-card border border-line bg-surface p-4 dt:col-span-5 dt:order-6 dt:p-5">
          <h2 className="text-sm font-semibold dt:text-[15px]">归 / 需 / 否 结构</h2>
          <p className="mt-0.5 text-[11px] text-ink-3 dt:text-xs">回头看看哪些花得值、哪些本可避免</p>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-2 dt:mt-4">
            {stack.map((s) => (
              <div key={s.judgement} style={{ width: `${s.ratio * 100}%`, background: s.color }} />
            ))}
          </div>
          <ul className="mt-3 space-y-2.5 dt:mt-4 dt:space-y-3.5">
            {stack.map((s) => (
              <li key={s.judgement}>
                <div className="flex items-baseline justify-between text-xs dt:text-[13px]">
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

        {/* ★v1.1.3 · AI 分析：本地规则洞察 + AI 点评（未配 AI 也有洞察，配了才有点评） */}
        <div className="page-enter rounded-card border border-line bg-surface p-4 dt:col-span-12 dt:order-8 dt:p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold dt:text-[15px]">
              <Sparkles size={15} style={{ color: 'var(--accent)' }} />
              AI 分析
            </h2>
            <button
              onClick={() => void runAnalyze()}
              disabled={analyzing}
              className="h-8 rounded-full bg-accent px-3.5 text-xs font-medium text-white active:opacity-90 disabled:opacity-40"
            >
              {analyzing ? '分析中…' : analysis ? '重新分析' : '开始分析'}
            </button>
          </div>
          <p className="mt-0.5 text-[11px] text-ink-3">
            按当前粒度（{windowLabel}）聚合 · 本地规则洞察始终可用，配置 AI 后附点评
          </p>
          {analysis ? (
            <div className="mt-3 space-y-2.5 dt:mt-4 dt:max-w-[880px] dt:space-y-3">
              <ul className="space-y-1.5 dt:space-y-2">
                {analysis.local.map((t, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-5 text-ink-2 dt:text-[13px] dt:leading-6">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span className="min-w-0 flex-1">{t}</span>
                  </li>
                ))}
              </ul>
              {analysis.ai ? (
                <div className="rounded-card bg-surface-2 p-3">
                  <p className="mb-1 text-[11px] font-medium" style={{ color: 'var(--accent)' }}>
                    AI 点评
                  </p>
                  <p className="whitespace-pre-line text-xs leading-5 text-ink-2">{analysis.ai}</p>
                </div>
              ) : null}
              {analysis.reason ? <p className="text-[11px] leading-5 text-ink-3">{analysis.reason}</p> : null}
              {isAiConfigured(aiConfigOf(settings)) ? null : (
                <button onClick={() => nav('/settings')} className="text-[11px] text-accent active:opacity-60">
                  去设置里配置 AI，获得更具体的点评 ›
                </button>
              )}
            </div>
          ) : (
            <p className="mt-3 rounded-card border border-dashed border-line p-4 text-center text-xs text-ink-3">
              点「开始分析」，看看这一期花得怎么样
            </p>
          )}
        </div>

        {/* ★v1.0.33 · 趋势（后置）：柱顶直接给金额，点柱子看该期收/支/结余明细
            ★v1.1.8 PC：与「支出分类占比」并排（钱花在哪 / 钱怎么走），柱体加高 */}
        <div className="page-enter rounded-card border border-line bg-surface p-4 dt:col-span-7 dt:order-4 dt:p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold dt:text-[15px]">{trendTitle}</h2>
            <p className="text-[11px] text-ink-3 dt:text-xs">
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
                  <div className="flex h-28 w-full items-end justify-center gap-1 dt:h-44 dt:gap-1.5">
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
              ? `${shownBar.label}：支出 ${formatMoney(shownBar.expense, currency)} · 收入 ${formatMoney(shownBar.income, currency)} · 结余 ${formatNetMoney(shownBar.income - shownBar.expense, currency)}`
              : '点柱子看该期收支金额'}
          </p>
        </div>

        {/* v1.0.21 · M3.2：净值趋势（收入 − 支出）；v1.0.33 起置于最后
            ★v1.0.35：可点选每期看明细 + 「怎么读」解释（点击反馈） */}
        <div className="page-enter rounded-card border border-line bg-surface p-4 dt:col-span-7 dt:order-7 dt:p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold dt:text-[15px]">净值趋势</h2>
            <p className="text-[11px] text-ink-3">{trendTitle.replace('趋势', '')} · 收入 − 支出</p>
          </div>
          <div className="mt-3">
            <NetTrend points={netPoints} currency={currency} selectedKey={netSel} onSelect={setNetSel} />
          </div>
          <button
            type="button"
            onClick={() => setNetHow((v) => !v)}
            className="mt-2 text-[11px] text-accent active:opacity-60"
          >
            {netHow ? '收起说明' : '这张图怎么读？'}
          </button>
          {netHow ? (
            <p className="mt-1.5 rounded-btn bg-surface-2 px-3 py-2 text-[11px] leading-5 text-ink-3">
              <b className="text-ink-2">怎么读这张图：</b>每个点的位置是该期「收入 − 支出」的净额，线往下走说明花得比收得多。「本期净额」是离现在最近一期，「区间累计」是这几期净额的合计——它同样不是「你还剩多少钱」，而是这段时间的净流出入。
            </p>
          ) : null}
        </div>
      </div>

      {/* v1.0.28 · 生活流 chips 就地弹层（时间/心动/情绪），关闭后停留在报表页 */}
      {lifeSheet ? <QuickSheetHost sheetKey={lifeSheet} onClose={() => setLifeSheet(null)} /> : null}
    </div>
  );
}
