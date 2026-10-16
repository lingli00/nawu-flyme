import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useDataStore, useSettingsStore } from '../store';
import { addDays, monthKey, monthLabel, today } from '../lib/date';
import { advanceRenewDate, nextRenewCountdown } from '../domain/subscription';
import { formatMoney } from '../lib/money';
import type { Bill, Subscription } from '../types/entities';

/**
 * v1.0.21 · M3.1 订阅日历：按月网格看「哪天扣款 / 哪天续费」。
 *
 * 事件来源两条：
 * 1) bills 里已有账单 —— 按账单状态着色；
 * 2) 订阅推算的续费日 —— 从 startDate/nextRenewDate 正向推进到目标月（无账单时也标灰点）。
 * 点某天 → 下方列该日的续费与账单明细；账单操作走父级 onOpenBills（BillSheet 四态弹层）。
 */

const BILL_COLOR: Record<Bill['status'], string> = {
  pending: 'var(--xu)',
  paid: 'var(--gui)',
  failed: 'var(--fou)',
  skipped: 'var(--ink-3)',
};

const BILL_LABEL: Record<Bill['status'], string> = {
  pending: '待确认',
  paid: '已支付',
  failed: '失败',
  skipped: '已跳过',
};

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

interface DayCell {
  date: string | null;
  bills: Bill[];
  renews: Subscription[];
}

export default function SubCalendar({ onOpenBills }: { onOpenBills?: () => void }) {
  const subs = useDataStore((s) => s.subscriptions);
  const bills = useDataStore((s) => s.bills);
  const settings = useSettingsStore((s) => s.settings);
  const currency = settings.currency;
  const archived = settings.archivedSubIds ?? [];

  const [ym, setYm] = useState(() => monthKey());
  const [sel, setSel] = useState<string | null>(null);

  const active = useMemo(() => subs.filter((s) => !archived.includes(s.id)), [subs, archived]);

  /** 该月每一天的事件（账单 + 推算续费）。 */
  const cells = useMemo<DayCell[]>(() => {
    const map = new Map<string, DayCell>();
    const cellOf = (d: string): DayCell => {
      let c = map.get(d);
      if (!c) {
        c = { date: d, bills: [], renews: [] };
        map.set(d, c);
      }
      return c;
    };
    for (const b of bills) {
      if (b.dueDate.slice(0, 7) === ym) cellOf(b.dueDate).bills.push(b);
    }
    const first = `${ym}-01`;
    const last = `${ym}-31`; // 上界只用于字符串比较，实际天数由 daysIn 控制
    const [yy, mm] = ym.split('-').map(Number);
    const daysIn = new Date(yy, mm, 0).getDate();
    for (const s of active) {
      if (s.type === 'lifetime') continue;
      let d = [s.startDate, s.nextRenewDate].filter(Boolean).sort()[0] || s.startDate;
      if (!d) continue;
      let guard = 0;
      while (d < first && guard++ < 800) d = advanceRenewDate(d, s.period, s.every);
      while (d.slice(0, 7) === ym && Number(d.slice(8)) <= daysIn && guard++ < 800) {
        if (d >= first && d <= last) cellOf(d).renews.push(s);
        d = advanceRenewDate(d, s.period, s.every);
      }
    }
    // 网格：周一起（补齐前置空格）
    const dow = (new Date(`${ym}-01T00:00:00`).getDay() + 6) % 7;
    const out: DayCell[] = Array.from({ length: dow }, () => ({ date: null, bills: [], renews: [] }));
    for (let i = 1; i <= daysIn; i++) {
      const d = `${ym}-${String(i).padStart(2, '0')}`;
      out.push(map.get(d) ?? { date: d, bills: [], renews: [] });
    }
    return out;
  }, [bills, active, ym]);

  const todayStr = today();
  const selected = sel ? cells.find((c) => c.date === sel) ?? null : null;
  const monthHasEvent = cells.some((c) => c.date && (c.bills.length || c.renews.length));

  const shift = (dir: -1 | 1): void => {
    const [yy, mm] = ym.split('-').map(Number);
    const t = new Date(yy, mm - 1 + dir, 1);
    setYm(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`);
    setSel(null);
  };

  return (
    <div className="mb-3 rounded-card border border-line bg-surface px-3.5 py-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-ink-2">续费日历</p>
        <div className="flex items-center gap-1">
          <button
            onClick={() => shift(-1)}
            aria-label="上个月"
            className="flex h-7 w-7 items-center justify-center rounded-full text-ink-3 active:bg-surface-2"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="min-w-[62px] text-center text-xs text-ink-2">{monthLabel(ym, true)}</span>
          <button
            onClick={() => shift(1)}
            aria-label="下个月"
            className="flex h-7 w-7 items-center justify-center rounded-full text-ink-3 active:bg-surface-2"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-7 gap-y-1 text-center">
        {WEEK.map((w) => (
          <span key={w} className="pb-1 text-[11px] text-ink-3">
            {w}
          </span>
        ))}
        {cells.map((c, i) => {
          if (!c.date) return <span key={`pad-${i}`} />;
          const isToday = c.date === todayStr;
          const dots = [
            ...c.bills.map((b) => BILL_COLOR[b.status]),
            ...c.renews
              .filter((s) => !c.bills.some((b) => b.subId === s.id))
              .map(() => 'var(--accent)'),
          ].slice(0, 3);
          return (
            <button
              key={c.date}
              onClick={() => setSel(sel === c.date ? null : c.date)}
              className={`mx-auto flex h-9 w-8 flex-col items-center justify-center rounded-lg text-[11px] transition-all active:scale-95 ${
                sel === c.date ? 'bg-accent-soft font-semibold text-accent' : isToday ? 'bg-surface-2 font-semibold text-ink' : 'text-ink-2'
              }`}
            >
              {Number(c.date.slice(8))}
              <span className="mt-0.5 flex h-1.5 items-center gap-[2px]">
                {dots.map((color, k) => (
                  <span key={k} className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      {selected ? (
        selected.bills.length + selected.renews.length === 0 ? (
          <p className="mt-2 rounded-btn bg-surface-2 px-3 py-2 text-[11px] text-ink-3">
            {(sel ?? '').slice(5)} 没有扣款安排
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5 rounded-btn bg-surface-2 px-3 py-2">
            {selected.renews.map((s) => (
              <li key={`r-${s.id}`} className="flex items-center justify-between text-xs">
                <span className="min-w-0 truncate text-ink-2">
                  {s.name}
                  <span className="ml-1 text-[11px] text-ink-3">续费</span>
                </span>
                <span className="ml-2 shrink-0 font-medium">{formatMoney(s.amount, s.currency || currency)}</span>
              </li>
            ))}
            {selected.bills.map((b) => {
              const s = subs.find((x) => x.id === b.subId);
              return (
                <li key={`b-${b.id}`} className="flex items-center justify-between text-xs">
                  <span className="min-w-0 truncate text-ink-2">
                    {s?.name ?? '已删订阅'}
                    <span className="ml-1 text-[11px]" style={{ color: BILL_COLOR[b.status] }}>
                      {BILL_LABEL[b.status]}
                    </span>
                  </span>
                  <span className="ml-2 shrink-0 font-medium">{formatMoney(b.amount, currency)}</span>
                </li>
              );
            })}
            {onOpenBills ? (
              <li>
                <button onClick={onOpenBills} className="text-[11px] font-medium text-accent">
                  去账单里处理 ›
                </button>
              </li>
            ) : null}
          </ul>
        )
      ) : (
        <p className="mt-2 text-[11px] text-ink-3">
          {monthHasEvent ? '点日期看当天安排' : '本月暂无扣款安排'}
          {active.length ? ` · 最近一次 ${Math.min(...active.map((s) => Math.abs(nextRenewCountdown(s))))} 天内` : ''}
        </p>
      )}
    </div>
  );
}

/** 供外部复用：某日之后的第 n 天（与日历内部一致，避免各处手写 Date 运算）。 */
export function plusDays(date: string, n: number): string {
  return addDays(date, n);
}
