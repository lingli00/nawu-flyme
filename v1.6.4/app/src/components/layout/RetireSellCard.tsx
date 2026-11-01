import { useMemo, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { formatMoney, round } from '../../lib/money';

/**
 * ★v1.3.7 退役转卖确认卡（含费用录入）。
 *
 * 用户反馈：手动记退役费用时，手续费只能填**固定金额**，填不了费率；
 * 而实际收的是「按成交价抽 2.1%」这种。
 *
 * 交互约定（对应需求「退役费用录入逻辑重构」）：
 * 1. 「运费」「手续费」是**固定预留**的两个常用项：没填就收起（只留「＋ 运费 / ＋ 手续费」
 *    入口），填了就展开成输入行，带一键清除；
 * 2. 手续费**只填百分比**（2.1 表示 2.1%），金额按「转卖价 × 费率」实时算出来，
 *    钱包扣多少一眼可见，不用自己按计算器；
 * 3. 其余附加费用（杂费）同一套规则：填了显示、不填隐藏；
 * 4. 底部常驻「净赚 = 转卖价 − 手续费 − 运费 − 杂费 − 买入价」，
 *    确认之前就知道这单到底赚没赚。
 *
 * 落库口径与「二手买卖一体」完全一致：费用进 `goods.extraFees`，
 * 净赚由 `syncSaleIncome` 统一算，不新增字段、不新增口径。
 */

export interface RetireCardState {
  sellPrice: number;
  /** 千分比（2.1% → 21）。 */
  feeRatePermille: number;
  shippingFee: number;
  extraFee: number;
}

/** 数字输入框的空值安全解析。 */
function numOf(v: string): number {
  const n = Number.parseFloat((v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export default function RetireSellCard({
  matchName,
  targetName,
  buyPrice,
  sellPrice,
  initial,
  onConfirm,
  onCancel,
  done,
  remaining = 0,
  onNext,
}: {
  /** 用户原话里用来定位物品的那段（找不到目标时提示用）。 */
  matchName: string;
  /** 实际匹配到的物品名（可能为空 = 没找到）。 */
  targetName?: string;
  buyPrice: number;
  sellPrice: number;
  initial: RetireCardState;
  onConfirm: (state: RetireCardState) => void;
  onCancel: () => void;
  done?: string;
  remaining?: number;
  onNext?: () => void;
}) {
  const locked = Boolean(done);

  const [price, setPrice] = useState(sellPrice > 0 ? String(sellPrice) : '');
  // 百分比：初始千分比 ÷ 10（千分之 21 = 2.1%）
  const [rate, setRate] = useState(initial.feeRatePermille > 0 ? String(round(initial.feeRatePermille / 10, 4)) : '');
  const [shipping, setShipping] = useState(initial.shippingFee > 0 ? String(initial.shippingFee) : '');
  const [extra, setExtra] = useState(initial.extraFee > 0 ? String(initial.extraFee) : '');
  // 没值时收起，点了「＋」才展开（填了就一直显示）
  const [open, setOpen] = useState({
    rate: initial.feeRatePermille > 0,
    shipping: initial.shippingFee > 0,
    extra: initial.extraFee > 0,
  });

  const priceNum = numOf(price);
  const ratePct = numOf(rate);
  const permille = round(ratePct * 10, 4);
  const feeAmount = useMemo(
    () => (priceNum > 0 && permille > 0 ? round((priceNum * permille) / 1000, 2) : 0),
    [priceNum, permille],
  );
  const shipNum = numOf(shipping);
  const extraNum = numOf(extra);
  const totalFee = round(feeAmount + shipNum + extraNum, 2);
  const netProfit = round(priceNum - (buyPrice || 0) - totalFee, 2);
  const currency = 'CNY';

  const submit = (): void => {
    onConfirm({
      sellPrice: priceNum,
      feeRatePermille: permille,
      shippingFee: shipNum,
      extraFee: extraNum,
    });
  };

  const rowCls = 'flex items-center gap-2 rounded-btn bg-surface-2 px-2.5 py-1.5';
  const inputCls =
    'w-16 shrink-0 rounded-[6px] border border-line bg-surface px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-accent disabled:opacity-60';
  const chipCls =
    'inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2.5 py-1 text-[12px] text-ink-2 active:bg-surface-2 disabled:opacity-40';

  return (
    <section
      className={`rounded-card border p-3.5 ${
        locked ? 'border-[color-mix(in_srgb,var(--gui)_45%,transparent)] bg-[color-mix(in_srgb,var(--gui)_6%,var(--surface))]' : 'border-line bg-surface'
      }`}
      aria-label="退役转卖确认"
      data-done={locked ? '1' : '0'}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">退役转卖确认</h3>
        {locked ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white"
            style={{ background: 'var(--gui)' }}
            role="status"
          >
            <Check size={12} strokeWidth={3} aria-hidden />
            已完成
          </span>
        ) : null}
      </div>

      {/* 匹配结果：这里把「用户怎么说的」和「库里的哪件」都摆出来，省得猜 */}
      <p className="text-sm leading-5 text-ink-2">
        {targetName ? (
          <>
            「{matchName}」→ 已关联「<span className="font-medium text-ink">{targetName}</span>」
          </>
        ) : (
          <span className="text-[color:var(--danger,#c0392b)]">没找到与「{matchName}」匹配的物品，请先入库</span>
        )}
      </p>

      {/* 转卖价（可改：语音偶尔把 329 听成 339，这里能直接修） */}
      <div className="mt-2.5">
        <label className="mb-1 block text-[12px] text-ink-2">转卖价</label>
        <div className={rowCls}>
          <span className="shrink-0 text-sm text-ink-2">¥</span>
          <input
            type="text"
            inputMode="decimal"
            value={price}
            disabled={locked}
            onChange={(e) => setPrice(e.target.value)}
            className={`${inputCls} w-full flex-1 text-left`}
            aria-label="转卖价"
            placeholder="0"
          />
        </div>
      </div>

      {/* 费用：填了才显示，不填就只剩一个「＋」入口 */}
      <div className="mt-2.5 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-ink-2">卖出费用</span>
          <span className="text-[11px] text-ink-2">填写才会计入净赚</span>
        </div>

        {open.shipping ? (
          <div className={rowCls}>
            <span className="w-14 shrink-0 text-sm text-ink-2">运费</span>
            <input
              type="text"
              inputMode="decimal"
              value={shipping}
              disabled={locked}
              onChange={(e) => setShipping(e.target.value)}
              className={inputCls}
              aria-label="运费"
              placeholder="0"
            />
            <span className="text-sm text-ink-2">元</span>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setShipping('');
                setOpen((o) => ({ ...o, shipping: false }));
              }}
              className="ml-auto shrink-0 rounded p-1 text-ink-2 active:bg-surface disabled:opacity-40"
              aria-label="清除运费"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        ) : null}

        {open.rate ? (
          <div className={rowCls}>
            <span className="w-14 shrink-0 text-sm text-ink-2">手续费</span>
            <input
              type="text"
              inputMode="decimal"
              value={rate}
              disabled={locked}
              onChange={(e) => setRate(e.target.value)}
              className={inputCls}
              aria-label="手续费费率（百分比）"
              placeholder="0"
            />
            <span className="shrink-0 text-sm text-ink-2">%</span>
            <span className="ml-auto shrink-0 text-[12px] tabular-nums text-ink-2">= {formatMoney(feeAmount, currency)}</span>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setRate('');
                setOpen((o) => ({ ...o, rate: false }));
              }}
              className="shrink-0 rounded p-1 text-ink-2 active:bg-surface disabled:opacity-40"
              aria-label="清除手续费"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        ) : null}

        {open.extra ? (
          <div className={rowCls}>
            <span className="w-14 shrink-0 text-sm text-ink-2">杂费</span>
            <input
              type="text"
              inputMode="decimal"
              value={extra}
              disabled={locked}
              onChange={(e) => setExtra(e.target.value)}
              className={inputCls}
              aria-label="其他附加费用"
              placeholder="0"
            />
            <span className="text-sm text-ink-2">元</span>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setExtra('');
                setOpen((o) => ({ ...o, extra: false }));
              }}
              className="ml-auto shrink-0 rounded p-1 text-ink-2 active:bg-surface disabled:opacity-40"
              aria-label="清除杂费"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        ) : null}

        {!locked && (!open.shipping || !open.rate || !open.extra) ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {!open.shipping ? (
              <button type="button" className={chipCls} onClick={() => setOpen((o) => ({ ...o, shipping: true }))}>
                <Plus size={12} aria-hidden />
                运费
              </button>
            ) : null}
            {!open.rate ? (
              <button type="button" className={chipCls} onClick={() => setOpen((o) => ({ ...o, rate: true }))}>
                <Plus size={12} aria-hidden />
                手续费
              </button>
            ) : null}
            {!open.extra ? (
              <button type="button" className={chipCls} onClick={() => setOpen((o) => ({ ...o, extra: true }))}>
                <Plus size={12} aria-hidden />
                其他费用
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 净赚预演：确认前就把账算清 */}
      <div className="mt-2.5 rounded-btn bg-surface-2 px-2.5 py-2 text-[12px] leading-5 text-ink-2">
        <div className="flex items-center justify-between">
          <span>净赚</span>
          <span className={`text-sm font-semibold tabular-nums ${netProfit > 0 ? 'text-[color:var(--ui-green,#1f8b4c)]' : 'text-ink-2'}`}>
            {netProfit > 0 ? '+' : ''}
            {formatMoney(netProfit, currency)}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-ink-2">
          转卖价 {formatMoney(priceNum, currency)} − 手续费 {formatMoney(feeAmount, currency)} − 运费 {formatMoney(shipNum, currency)}
          {' − 杂费 '}
          {formatMoney(extraNum, currency)} − 买入 {formatMoney(buyPrice || 0, currency)}
        </div>
      </div>

      {locked && done ? (
        <p className="mt-2 rounded-btn bg-surface px-2.5 py-1.5 text-[11px] leading-4 text-ink-2">{done}</p>
      ) : null}

      <div className="mt-3 flex gap-2">
        {locked ? (
          <button
            type="button"
            onClick={onNext ?? onCancel}
            className="h-10 flex-1 rounded-btn border border-line bg-surface-2 text-sm font-medium text-ink-2 active:scale-[0.99]"
          >
            {remaining > 0 ? `下一条（剩 ${remaining} 条）` : '完成'}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onCancel}
              className="h-10 flex-1 rounded-btn border border-line bg-surface-2 text-sm font-medium text-ink-2 active:scale-[0.99]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={submit}
              className="h-10 flex-[1.4] rounded-btn text-sm font-semibold text-white active:scale-[0.99]"
              style={{ background: 'var(--gui)' }}
            >
              确认保存
            </button>
          </>
        )}
      </div>
    </section>
  );
}
