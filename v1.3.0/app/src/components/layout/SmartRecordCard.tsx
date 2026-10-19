import { useMemo, useRef, useState } from 'react';
import type { SwitchableKind } from '../../ai/convert';
import { defaultCategoryId } from '../../ai/localParser';
import { IconPreview, iconBaseOf } from '../IconPicker';
import { topSuggestion } from '../../lib/iconSuggest';
import type { Category } from '../../types/entities';

/**
 * ★v1.2.0 智能记录确认卡片（PRD 3.3）。
 *
 * 两种工作模式共用：弹卡片 → 用户确认。
 * - 直接确认（分类未动）→ 正常模式，不触发学习；
 * - 改了大类或小类再确认 → 学习模式，沉淀为本地规则（由调用方落库）。
 *
 * ★IME 铁律：名称/金额/时间/备注 全部非受控（defaultValue + ref 读 DOM 真值），
 * submit 不依赖 onChange 收集（Android WebView 输入法组合期 onChange 不触发）。
 * 大类 chip 与小类下拉是原生点击/选择，无 IME 参与，保持受控。
 */

/** 卡片承载的编辑状态。 */
export interface RecordCardState {
  kind: SwitchableKind;
  categoryId: string;
  name: string;
  amount: number;
  date: string;
  note: string;
}

/** 大类 chip 展示顺序（PRD：物品 / 订阅 / 生活流）。 */
const KIND_CHIPS: Array<{ kind: SwitchableKind; label: string }> = [
  { kind: 'goods', label: '物品' },
  { kind: 'sub', label: '订阅' },
  { kind: 'ledger', label: '生活流' },
];

export default function SmartRecordCard({
  initial,
  categories,
  onConfirm,
  onCancel,
}: {
  initial: RecordCardState;
  categories: Category[];
  onConfirm: (state: RecordCardState) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<SwitchableKind>(initial.kind);
  const [categoryId, setCategoryId] = useState(initial.categoryId);
  // 非受控字段：提交时读 DOM 真值
  const nameRef = useRef<HTMLInputElement | null>(null);
  const amountRef = useRef<HTMLInputElement | null>(null);
  const dateRef = useRef<HTMLInputElement | null>(null);
  const noteRef = useRef<HTMLInputElement | null>(null);
  /** ★v1.3.0 名称的镜像 state（只驱动智能图标预览，提交仍读 DOM 真值）。 */
  const [nameText, setNameText] = useState(initial.name);
  const iconBase = useMemo(iconBaseOf, []);
  /** 智能匹配预览（本地品牌资产 → 内置 glyph → 代理 → 分类默认）。 */
  const iconTop = useMemo(() => {
    const kw = nameText.trim();
    if (kw.length < 2) return null;
    const cat = categories.find((c) => c.id === categoryId);
    return topSuggestion(kw, { kind, base: iconBase, categoryIcon: cat?.icon });
  }, [nameText, kind, categoryId, categories, iconBase]);

  const cats = useMemo(
    () => categories.filter((c) => c.kind === kind).sort((a, b) => a.order - b.order),
    [categories, kind],
  );

  /** 切换大类：小类尽量按「同名分类」跟过去（数码在物品/生活流都有），否则取默认。 */
  const switchKind = (next: SwitchableKind): void => {
    if (next === kind) return;
    const cur = categories.find((c) => c.id === categoryId);
    const sameName = cur
      ? categories.find((c) => c.kind === next && c.name === cur.name)
      : undefined;
    setKind(next);
    setCategoryId(sameName?.id ?? defaultCategoryId(categories, next));
  };

  const submit = (): void => {
    onConfirm({
      kind,
      categoryId: categoryId || defaultCategoryId(categories, kind),
      name: (nameRef.current?.value ?? '').trim(),
      amount: Number.parseFloat((amountRef.current?.value ?? '').trim()) || 0,
      date: (dateRef.current?.value ?? '').trim(),
      note: (noteRef.current?.value ?? '').trim(),
    });
  };

  return (
    <section
      className="rounded-card border border-line bg-surface p-4"
      aria-label="识别记录预览"
    >
      <h3 className="mb-3 text-sm font-semibold">识别记录预览</h3>

      {/* 大类选择器（可点击切换） */}
      <div className="mb-3 flex items-center gap-1.5">
        <span className="text-[11px] text-ink-3">大类</span>
        {KIND_CHIPS.map(({ kind: k, label }) => (
          <button
            key={k}
            type="button"
            onClick={() => switchKind(k)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] leading-5 transition-colors ${
              kind === k ? 'border-accent bg-accent text-white' : 'border-line-2 text-ink-2 active:bg-surface-2'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="space-y-2.5">
        {/* 小类下拉 */}
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">小类</span>
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded-btn border border-line bg-surface-2 px-2 text-sm outline-none focus:border-accent"
          >
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {/* 名称（★v1.3.0：右侧附智能匹配图标预览——命中品牌时亮，纯预览不落库） */}
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">名称</span>
          <input
            ref={nameRef}
            defaultValue={initial.name}
            onInput={(e) => setNameText(e.currentTarget.value)}
            placeholder="名称"
            enterKeyHint="done"
            className="h-9 min-w-0 flex-1 rounded-btn border border-line bg-surface-2 px-2 text-sm outline-none focus:border-accent"
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

        {/* 金额 */}
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">金额</span>
          <span className="text-sm text-ink-3">¥</span>
          <input
            ref={amountRef}
            defaultValue={initial.amount ? String(initial.amount) : ''}
            placeholder="0"
            inputMode="decimal"
            enterKeyHint="done"
            className="h-9 min-w-0 flex-1 rounded-btn border border-line bg-surface-2 px-2 text-sm outline-none focus:border-accent"
          />
        </label>

        {/* 时间 */}
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">时间</span>
          <input
            ref={dateRef}
            type="date"
            defaultValue={initial.date}
            className="h-9 min-w-0 flex-1 rounded-btn border border-line bg-surface-2 px-2 text-sm outline-none focus:border-accent"
          />
        </label>

        {/* 备注（自动填充原文，可改） */}
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-ink-3">备注</span>
          <input
            ref={noteRef}
            defaultValue={initial.note}
            placeholder="原文摘要"
            className="h-9 min-w-0 flex-1 rounded-btn border border-line bg-surface-2 px-2 text-sm outline-none focus:border-accent"
          />
        </label>
      </div>

      <p className="mt-2.5 text-[11px] leading-4 text-ink-3">
        改动大类或小类后确认，系统会自动学会这条归类规则（存在本机）。
      </p>

      <div className="mt-3 flex gap-2">
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
          className="h-10 flex-[2] rounded-btn bg-accent text-sm font-semibold text-white active:opacity-90"
        >
          确认保存
        </button>
      </div>
    </section>
  );
}
