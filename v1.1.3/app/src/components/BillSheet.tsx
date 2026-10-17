import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { BadgeCheck, Ban, RotateCcw, Undo2, XCircle } from 'lucide-react';
import { useDataStore, toastSuccess, toastError } from '../store';
import { useBackGuard } from '../lib/backGuard';
import { haptic } from '../lib/haptics';
import { monthLabel } from '../lib/date';
import type { Bill, Subscription } from '../types/entities';

/**
 * 订阅账单管理弹层（v1.0.21 · M3.1 账单四态最小闭环）。
 *
 * 四态：pending=待确认 / paid=已支付 / skipped=已跳过 / failed=失败（待补记）。
 * 行内操作：
 * - 待确认：标记已付 / 跳过本期 / 标记失败
 * - 失败：补记已付 / 跳过本期
 * - 已支付：登记退款（行内输入部分/全额）/ 撤销已付
 * 统计口径：成本只算 paid（扣退款），skipped/failed 不进支出。
 */

const STATUS_META: Record<Bill['status'], { label: string; color: string }> = {
  pending: { label: '待确认', color: 'var(--xu, #d97706)' },
  paid: { label: '已支付', color: 'var(--gui)' },
  skipped: { label: '已跳过', color: 'var(--ink-3)' },
  failed: { label: '失败', color: 'var(--fou)' },
};

/** 弹层骨架（与 LifeSheets 同结构）。 */
function SheetFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useBackGuard(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={onClose}>
      <div
        className="sheet-enter mx-auto max-h-[86vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-4 pb-[max(env(safe-area-inset-bottom),1rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold">{title}</p>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-ink-2 active:scale-95"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** 月份分组 key。 */
function monthOf(b: Bill): string {
  return b.dueDate.slice(0, 7);
}

export default function BillSheet({ onClose }: { onClose: () => void }) {
  const bills = useDataStore((s) => s.bills);
  const subs = useDataStore((s) => s.subscriptions);
  const markBillPaid = useDataStore((s) => s.markBillPaid);
  const setBillStatus = useDataStore((s) => s.setBillStatus);
  const refundBill = useDataStore((s) => s.refundBill);

  /** 行内退款输入展开的账单 id。 */
  const [refundingId, setRefundingId] = useState<string | null>(null);
  const [refundVal, setRefundVal] = useState('');

  const subOf = (id: string): Subscription | undefined => subs.find((s) => s.id === id);

  /** 按月分组倒序；组内应付日倒序。 */
  const groups = useMemo(() => {
    const map = new Map<string, Bill[]>();
    for (const b of bills) {
      const k = monthOf(b);
      const list = map.get(k);
      if (list) list.push(b);
      else map.set(k, [b]);
    }
    const out = [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    for (const [, list] of out) list.sort((a, b) => b.dueDate.localeCompare(a.dueDate));
    return out;
  }, [bills]);

  const act = (label: string, fn: () => Promise<void>): void => {
    void haptic('select');
    void fn()
      .then(() => toastSuccess(label))
      .catch(() => toastError('操作失败，请重试'));
  };

  const confirmRefund = (b: Bill): void => {
    const v = Number(refundVal);
    if (!Number.isFinite(v) || v < 0 || v > Number(b.amount)) {
      toastError('退款金额需在 0 与账单金额之间');
      return;
    }
    setRefundingId(null);
    setRefundVal('');
    act(v === 0 ? '已清除退款' : `已登记退款 ¥${v}`, () => refundBill(b.id, v));
  };

  return (
    <SheetFrame title={`订阅账单 (${bills.length})`} onClose={onClose}>
      {groups.length === 0 ? (
        <p className="rounded-card border border-dashed border-line bg-surface-2 p-8 text-center text-xs text-ink-3">
          还没有扣款流水。订阅到期后会自动生成待确认账单。
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map(([ym, list]) => (
            <section key={ym}>
              <p className="mb-1 px-1 text-xs font-semibold text-ink-2">{monthLabel(ym)}</p>
              <ul className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface">
                {list.map((b) => {
                  const meta = STATUS_META[b.status] ?? STATUS_META.pending;
                  const sub = subOf(b.subId);
                  const refunding = refundingId === b.id;
                  return (
                    <li key={b.id} className="px-3.5 py-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{ background: `color-mix(in srgb, ${meta.color} 14%, transparent)`, color: meta.color }}
                        >
                          {meta.label}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">
                            {sub?.name ?? '已删订阅'}
                            <span className="ml-1.5 text-[11px] text-ink-3">{b.dueDate.slice(5)}</span>
                          </p>
                          {b.refund ? (
                            <p className="text-[11px]" style={{ color: 'var(--gui)' }}>
                              已退 ¥{b.refund}
                            </p>
                          ) : null}
                        </div>
                        <p className="shrink-0 text-sm font-semibold">¥{b.amount}</p>
                      </div>

                      {/* 操作行 */}
                      {!refunding ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {b.status === 'pending' ? (
                            <>
                              <OpBtn icon={BadgeCheck} label="标记已付" onClick={() => act('已标记支付', () => markBillPaid(b.id))} primary />
                              <OpBtn label="跳过本期" onClick={() => act('本期已跳过', () => setBillStatus(b.id, 'skipped'))} />
                              <OpBtn icon={XCircle} label="标记失败" onClick={() => act('已标记失败', () => setBillStatus(b.id, 'failed'))} />
                            </>
                          ) : null}
                          {b.status === 'failed' ? (
                            <>
                              <OpBtn icon={BadgeCheck} label="补记已付" onClick={() => act('已补记支付', () => markBillPaid(b.id))} primary />
                              <OpBtn label="跳过本期" onClick={() => act('本期已跳过', () => setBillStatus(b.id, 'skipped'))} />
                            </>
                          ) : null}
                          {b.status === 'paid' ? (
                            <>
                              <OpBtn icon={RotateCcw} label={b.refund ? '改退款' : '登记退款'} onClick={() => setRefundingId(b.id)} />
                              <OpBtn icon={Undo2} label="撤销已付" onClick={() => act('已撤回待确认', () => setBillStatus(b.id, 'pending'))} />
                            </>
                          ) : null}
                          {b.status === 'skipped' ? (
                            <OpBtn icon={Ban} label="恢复待确认" onClick={() => act('已恢复待确认', () => setBillStatus(b.id, 'pending'))} />
                          ) : null}
                        </div>
                      ) : (
                        /* 行内退款输入 */
                        <div className="mt-2 flex items-center gap-2">
                          <input
                            value={refundVal}
                            onChange={(e) => setRefundVal(e.target.value)}
                            inputMode="decimal"
                            placeholder={`退款金额（≤${b.amount}，0 清除）`}
                            className="h-9 min-w-0 flex-1 rounded-btn border border-line bg-surface-2 px-2.5 text-sm outline-none focus:border-accent"
                            autoFocus
                          />
                          <button
                            onClick={() => confirmRefund(b)}
                            className="h-9 shrink-0 rounded-btn bg-accent px-3.5 text-xs font-medium text-white active:opacity-90"
                          >
                            确认
                          </button>
                          <button
                            onClick={() => {
                              setRefundingId(null);
                              setRefundVal('');
                            }}
                            className="h-9 shrink-0 rounded-btn border border-line px-3 text-xs text-ink-2 active:scale-95"
                          >
                            取消
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          <p className="px-1 text-[11px] leading-4 text-ink-3/70">
            口径：订阅成本只统计「已支付」（扣除退款）；「已跳过 / 失败」不进支出。
          </p>
        </div>
      )}
    </SheetFrame>
  );
}

/** 小操作按钮。 */
function OpBtn({
  icon: Icon,
  label,
  onClick,
  primary,
}: {
  icon?: typeof BadgeCheck;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] transition-all active:scale-95 ${
        primary ? 'bg-accent text-white' : 'border border-line bg-surface-2 text-ink-2'
      }`}
    >
      {Icon ? <Icon size={11} /> : null}
      {label}
    </button>
  );
}
