import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Tag } from 'lucide-react';
import { feeAmountOf, tradeNetProfit } from '../../ai/trade';
import { defaultCategoryId } from '../../ai/localParser';
import { formatMoney, round } from '../../lib/money';
import { IconPreview, iconBaseOf } from '../IconPicker';
import { topSuggestion } from '../../lib/iconSuggest';
import type { Category } from '../../types/entities';
import type { TradeDraft } from '../../types/ai';

/**
 * ★v1.3.6 二手买卖一体确认卡。
 *
 * 上半截 = 入库（名称/分类/买入金额/买入日期）；
 * 下半截 = 卖出信息（售价 / 手续费费率 / 快递费 / 额外杂费），
 * 提交后由调用方「先入库 → 再标记退役（已售出）→ 同步生活流」。
 *
 * 三条交互约定（顺手就少挨骂）：
 * 1. 卖出信息区**默认展开**，不让用户再点一次才见到关键字段；
 * 2. 手续费用户**只填费率**，金额实时算出来显示（千分之 6 → 售价 × 0.6%）；
 * 3. 底部常驻一行「净赚 = 售价 − 买入 − 手续费 − 快递 − 杂费」，
 *    用户按下确认之前就知道这笔到底赚了多少。
 *
 * IME 铁律：名称非受控（defaultValue + ref 读 DOM 真值）；数字字段受控无妨
 * （纯数字不走中文输入法组合）。
 */

/** 卡片提交给调用方的最终状态。 */
export interface TradeCardState {
  name: string;
  categoryId: string;
  buyPrice: number;
  buyDate: string;
  sellPrice: number;
  /** 千分比 */
  feeRatePermille: number;
  shippingFee: number;
  extraFee: number;
  note: string;
}

/** 数字输入框的空值安全解析。 */
function numOf(v: string): number {
  const n = Number.parseFloat((v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export default function TradeRecordCard({
  initial,
  categories,
  onConfirm,
  onCancel,
  done,
  remaining = 0,
  onNext,
}: {
  initial: TradeDraft;
  categories: Category[];
  onConfirm: (state: TradeCardState) => void;
  onCancel: () => void;
  /** 非空即完成态（卡片不消失、字段只读）。 */
  done?: string;
  remaining?: number;
  onNext?: () => void;
}) {
  const locked = Boolean(done);
  const goodsCats = useMemo(
    () => categories.filter((c) => c.kind === 'goods').sort((a, b) => a.order - b.order),
    [categories],
  );

  const [categoryId, setCategoryId] = useState(
    initial.categoryId || defaultCategoryId(categories, 'goods'),
  );
  const [buyPrice, setBuyPrice] = useState(initial.buyPrice ? String(initial.buyPrice) : '');
  const [buyDate, setBuyDate] = useState(initial.buyDate);
  const [sellPrice, setSellPrice] = useState(initial.sellPrice ? String(initial.sellPrice) : '');
  /**
   * 费率（千分比）。用户直接说了手续费金额时（如「手续费 3.4 元」），
   * 反推一个等值费率，保证「只填费率」的交互形态统一。
   */
  const [rate, setRate] = useState(() => {
    if (initial.feeRatePermille > 0) return String(initial.feeRatePermille);
    if (initial.feeAmount > 0 && initial.sellPrice > 0) {
      return String(round((initial.feeAmount / initial.sellPrice) * 1000, 4));
    }
    return '';
  });
  const [shipping, setShipping] = useState(initial.shippingFee ? String(initial.shippingFee) : '');
  const [extra, setExtra] = useState(initial.extraFee ? String(initial.extraFee) : '');
  const [sellOpen, setSellOpen] = useState(true);

  /** 名称：非受控 + ref（中文输入法组合期 change 会漏发）。 */
  const nameRef = useRef<HTMLInputElement | null>(null);
  const noteRef = useRef<HTMLInputElement | null>(null);
  const [nameText, setNameText] = useState(initial.name);
  const iconBase = useMemo(iconBaseOf, []);

  const sellNum = numOf(sellPrice);
  const buyNum = numOf(buyPrice);
  const rateNum = numOf(rate);
  const shipNum = numOf(shipping);
  const extraNum = numOf(extra);
  const feeAmount = feeAmountOf(sellNum, rateNum);
  const netProfit = tradeNetProfit({
    buyPrice: buyNum,
    sellPrice: sellNum,
    feeRatePermille: rateNum,
    feeAmount,
    shippingFee: shipNum,
    extraFee: extraNum,
  });

  const iconTop = useMemo(() => {
    const kw = (nameText ?? '').trim();
    if (kw.length < 2) return null;
    const cat = goodsCats.find((c) => c.id === categoryId);
    return topSuggestion(kw, { kind: 'goods', base: iconBase, categoryIcon: cat?.icon });
  }, [nameText, categoryId, goodsCats, iconBase]);

  const submit = (): void => {
    onConfirm({
      name: (nameRef.current?.value ?? nameText).trim(),
      categoryId: categoryId || defaultCategoryId(categories, 'goods'),
      buyPrice: buyNum,
      buyDate,
      sellPrice: sellNum,
      feeRatePermille: rateNum,
      shippingFee: shipNum,
      extraFee: extraNum,
      note: (noteRef.current?.value ?? '').trim(),
    });
  };

  const inputCls =
    'h-9 min-w-0 flex-1 rounded-btn border border-line bg-surface-2 px-2 text-sm outline-none focus:border-accent disabled:opacity-60';

  return (
    <section
      className={`rounded-2xl border p-3.5 transition-colors ${
        locked
          ? 'border-[color-mix(in_srgb,var(--gui)_45%,transparent)] bg-[color-mix(in_srgb,var(--gui)_6%,var(--surface))]'
          : 'border-line bg-surface'
      }`}
      aria-label="二手买卖识别预览"
      data-done={locked ? '1' : '0'}
      data-kind="trade"
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          二手买卖
          <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
            买入 + 卖出
          </span>
        </h3>
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
      {locked && done ? (
        <p className="mb-2.5 rounded-btn bg-surface px-2.5 py-1.5 text-[11px] leading-4 text-ink-2">{done}</p>
      ) : null}

      {/* —— 入库信息 —— */}
      <p className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-ink-3">
        <Tag size={11} strokeWidth={2} aria-hidden />
        入库信息
      </p>
      <div className="space-y-2">
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">名称</span>
          <input
            ref={nameRef}
            disabled={locked}
            defaultValue={initial.name}
            onInput={(e) => setNameText(e.currentTarget.value)}
            placeholder="物品名"
            enterKeyHint="done"
            className={inputCls}
          />
          {iconTop ? (
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-btn border border-line bg-surface-2"
              title={`智能匹配 · ${iconTop.label}`}
            >
              <IconPreview icon={iconTop.value} size={18} />
            </span>
          ) : null}
        </label>
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">小类</span>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            disabled={locked}
            className={inputCls}
          >
            {goodsCats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">买入</span>
          <span className="text-sm text-ink-3">¥</span>
          <input
            disabled={locked}
            value={buyPrice}
            onChange={(e) => setBuyPrice(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0"
            inputMode="decimal"
            enterKeyHint="done"
            className={inputCls}
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">时间</span>
          <input
            disabled={locked}
            type="date"
            value={buyDate}
            onChange={(e) => setBuyDate(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>

      {/* —— 卖出信息（默认展开） —— */}
      <button
        type="button"
        onClick={() => setSellOpen((v) => !v)}
        className="mt-3 flex w-full items-center justify-between rounded-btn bg-surface-2 px-2.5 py-1.5 text-[11px] font-medium text-ink-2 active:opacity-80"
        aria-expanded={sellOpen}
        aria-controls="trade-sell-body"
      >
        <span className="flex items-center gap-1.5">
          卖出信息
          {sellNum > 0 ? <span className="text-accent">¥{sellNum}</span> : <span className="text-ink-3">待填</span>}
        </span>
        <ChevronDown
          size={13}
          strokeWidth={2}
          aria-hidden
          className={`transition-transform ${sellOpen ? 'rotate-180' : ''}`}
        />
      </button>

      <div id="trade-sell-body" className={sellOpen ? 'mt-2 space-y-2' : 'hidden'}>
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">售价</span>
          <span className="text-sm text-ink-3">¥</span>
          <input
            disabled={locked}
            value={sellPrice}
            onChange={(e) => setSellPrice(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0"
            inputMode="decimal"
            enterKeyHint="done"
            className={inputCls}
          />
        </label>

        {/* 手续费：用户只填费率，金额自动算 */}
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">费率</span>
          <span className="shrink-0 text-[11px] text-ink-3">千分之</span>
          <input
            disabled={locked}
            value={rate}
            onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="6"
            inputMode="decimal"
            enterKeyHint="done"
            aria-label="手续费费率（千分之）"
            className={inputCls}
          />
          <span className="tnum w-20 shrink-0 text-right text-[11px] text-ink-2">
            手续费 {formatMoney(feeAmount, 'CNY')}
          </span>
        </label>

        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">快递费</span>
          <span className="text-sm text-ink-3">¥</span>
          <input
            disabled={locked}
            value={shipping}
            onChange={(e) => setShipping(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0"
            inputMode="decimal"
            enterKeyHint="done"
            className={inputCls}
          />
        </label>

        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">杂费</span>
          <span className="text-sm text-ink-3">¥</span>
          <input
            disabled={locked}
            value={extra}
            onChange={(e) => setExtra(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0"
            inputMode="decimal"
            enterKeyHint="done"
            aria-label="额外杂费"
            className={inputCls}
          />
        </label>
      </div>

      <label className="mt-2 flex items-center gap-2">
        <span className="w-12 shrink-0 text-[11px] text-ink-3">备注</span>
        <input
          ref={noteRef}
          disabled={locked}
          defaultValue={initial.note ?? ''}
          placeholder="原文摘要"
          className={inputCls}
        />
      </label>

      {/* —— 结算条：确认前就告诉用户赚多少 —— */}
      <div className="mt-2.5 flex items-center justify-between rounded-btn bg-surface-2 px-2.5 py-2">
        <span className="text-[11px] text-ink-3">
          净赚 = 售价 − 买入 − 手续费 − 快递 − 杂费
        </span>
        <span
          className={`tnum text-sm font-semibold ${netProfit >= 0 ? 'text-ink' : 'text-ink-3'}`}
          data-testid="trade-net"
        >
          {netProfit >= 0 ? '' : '−'}
          {formatMoney(Math.abs(netProfit), 'CNY')}
        </span>
      </div>
      {locked ? null : (
        <p className="mt-1.5 text-[11px] leading-4 text-ink-3">
          提交后先入物品库（带买入金额），再自动标记为「已退役（已售出）」；净赚记入生活流收入。
        </p>
      )}

      {locked ? (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={onNext ?? onCancel}
            className="h-10 flex-1 rounded-btn border border-line bg-surface-2 text-sm font-medium text-ink-2 active:scale-[0.99]"
          >
            {remaining > 0 ? `下一条（剩 ${remaining} 条）` : '完成'}
          </button>
        </div>
      ) : (
        <div className="mt-2.5 flex gap-2">
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
            disabled={buyNum <= 0 || sellNum <= 0}
            className="h-10 flex-[2] rounded-btn bg-accent text-sm font-semibold text-white active:opacity-90 disabled:opacity-40"
          >
            入库并标记已售出
          </button>
        </div>
      )}
    </section>
  );
}
