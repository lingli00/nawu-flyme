import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import PageShell from '../components/layout/PageShell';
import CategoryManageSheet from '../components/CategoryManageSheet';
import CategoryGlyph from '../components/CategoryGlyph';
import { QuickCooldownSheet } from '../components/LifeSheets';
import { useDataStore, useSettingsStore, toastSuccess } from '../store';
import { today } from '../lib/date';
import { haptic } from '../lib/haptics';
import type { Judgement, ValueRecord } from '../types/entities';

/**
 * P12 记一笔 / P13 编辑一笔（路由 /record 与 /record/:id 复用）。
 * ★核心交互：归 / 需 / 否 三选一。
 *
 * ★修复 v1.0.0：金额与备注改为**非受控输入**（DOM 自持值，提交时 ref 读真值，
 * state 只做镜像用于按钮禁用态），与 AI 记一笔同一方案，
 * 解决 Android WebView 中文输入法下在中间插字被顶到末尾的问题。
 */
const JUDGEMENTS: Array<{ key: Judgement; label: string; desc: string; color: string }> = [
  { key: 'gui', label: '归', desc: '值得花的', color: 'var(--gui)' },
  { key: 'xu', label: '需', desc: '必要的', color: 'var(--xu)' },
  { key: 'fou', label: '否', desc: '本可避免', color: 'var(--fou)' },
];

export default function ManualRecordSheet() {
  const nav = useNavigate();
  const { id } = useParams();
  const editing = useDataStore((s) => s.valueRecords.find((r) => r.id === id));
  const categories = useDataStore((s) => s.categories);
  const addLedger = useDataStore((s) => s.addLedger);
  const updateLedger = useDataStore((s) => s.updateLedger);
  const currency = useSettingsStore((s) => s.settings.currency);

  const [type, setType] = useState<'expense' | 'income'>(editing?.type ?? 'expense');
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? '');
  const [judgement, setJudgement] = useState<Judgement>(editing?.judgement ?? 'xu');
  const [date, setDate] = useState(editing?.date ?? today());
  const [busy, setBusy] = useState(false);

  /** 非受控输入：备注 DOM 自持值，提交时读真值；amount 仅作镜像（不回写 DOM）。 */
  const noteRef = useRef<HTMLInputElement | null>(null);
  const [amount, setAmount] = useState(editing ? String(editing.amount) : '');
  /** 就地管理记账分类（不用跳「我的」打断记一笔流程）。 */
  const [managingCats, setManagingCats] = useState(false);
  /** 「稍后」：先不买，放进冷静池（v1.0.20 对标竞品第四判定钮）。 */
  const [laterOpen, setLaterOpen] = useState(false);

  const ledgerCats = useMemo(
    () => categories.filter((c) => c.kind === 'ledger').sort((a, b) => a.order - b.order),
    [categories],
  );
  const activeCat = categoryId || ledgerCats[0]?.id || '';

  const numAmount = Number(amount);
  const valid = Number.isFinite(numAmount) && numAmount > 0 && activeCat;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const payload = {
      type,
      amount: numAmount,
      categoryId: activeCat,
      judgement,
      date,
      note: (noteRef.current?.value ?? '').trim() || undefined,
      currency,
    };
    try {
      if (editing) {
        await updateLedger(editing.id, payload);
        void haptic('medium');
        toastSuccess('已保存');
      } else {
        await addLedger(payload);
        toastSuccess('已记下这笔');
      }
      nav('/ledger', { replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell title={editing ? '编辑记录' : '记一笔'} onBack={() => nav('/ledger', { replace: true })}>
      {/* 类型切换 */}
      <div className="mb-3 flex gap-1 rounded-btn bg-surface-2 p-1">
        {([['expense', '支出'], ['income', '收入']] as const).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`h-10 flex-1 rounded-btn text-sm font-medium ${
              type === t ? 'bg-surface shadow-sm' : 'text-ink-3'
            }`}
            style={type === t ? { color: t === 'income' ? 'var(--gui)' : 'var(--ink)' } : undefined}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 金额 */}
      <div className="rounded-card border border-line bg-surface p-5 text-center">
        <p className="text-xs text-ink-3">金额（{currency}）</p>
        <input
          defaultValue={editing ? String(editing.amount) : ''}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          className="mt-1 w-full bg-transparent text-center text-4xl font-bold outline-none placeholder:text-ink-3/40"
          autoFocus
        />
      </div>

      {/* 归 / 需 / 否 —— 核心交互（+ 稍后 → 冷静池，四色判定） */}
      <p className="mb-2 mt-4 px-1 text-xs font-medium text-ink-2">这笔花得怎么样？（复盘用）</p>
      <div className="grid grid-cols-4 gap-2">
        {JUDGEMENTS.map((j) => (
          <button
            key={j.key}
            onClick={() => setJudgement(j.key)}
            className={`flex flex-col items-center rounded-card border-2 py-3 transition-colors ${
              judgement === j.key ? 'bg-surface' : 'border-line bg-surface opacity-60'
            }`}
            style={judgement === j.key ? { borderColor: j.color } : undefined}
          >
            <span className="text-xl font-bold" style={{ color: j.color }}>
              {j.label}
            </span>
            <span className="mt-0.5 text-[11px] text-ink-3">{j.desc}</span>
          </button>
        ))}
        <button
          onClick={() => setLaterOpen(true)}
          className={`flex flex-col items-center rounded-card border-2 py-3 transition-colors ${
            laterOpen ? 'border-ink-3 bg-surface' : 'border-line bg-surface opacity-60'
          }`}
        >
          <span className="text-xl font-bold text-ink-2">稍后</span>
          <span className="mt-0.5 text-[11px] text-ink-3">先放冷静池</span>
        </button>
      </div>

      {laterOpen ? (
        <QuickCooldownSheet presetName={(noteRef.current?.value ?? '').trim()} onClose={() => setLaterOpen(false)} />
      ) : null}

      {/* 分类（末尾常驻「管理」贴片：就地增删改/排序，不打断记一笔） */}
      <div className="mb-2 mt-4 flex items-center justify-between px-1">
        <p className="text-xs font-medium text-ink-2">分类</p>
        <button onClick={() => setManagingCats(true)} className="text-xs font-medium text-accent">
          管理
        </button>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {ledgerCats.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategoryId(c.id)}
            className={`flex flex-col items-center rounded-card border py-2.5 text-xs ${
              activeCat === c.id ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-ink-2'
            }`}
          >
            <CategoryGlyph id={c.icon} size={20} />
            {c.name}
          </button>
        ))}
      </div>

      {managingCats ? <CategoryManageSheet kind="ledger" onClose={() => setManagingCats(false)} /> : null}

      {/* 日期 + 备注 */}
      <div className="mt-4 space-y-3 rounded-card border border-line bg-surface p-4">
        <label className="flex items-center justify-between text-sm">
          <span className="text-ink-2">日期</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-9 rounded-btn border border-line bg-surface-2 px-2 text-sm outline-none"
          />
        </label>
        <label className="block">
          <span className="text-sm text-ink-2">备注</span>
          <input
            ref={noteRef}
            defaultValue={editing?.note ?? ''}
            placeholder="买了什么？（可选）"
            className="mt-1.5 h-10 w-full nw-input"
          />
        </label>
      </div>

      <button
        onClick={submit}
        disabled={!valid || busy}
        className="mt-4 mb-2 h-12 w-full rounded-btn bg-accent text-base font-semibold text-white active:opacity-90 disabled:opacity-40"
      >
        {busy ? '保存中…' : editing ? '保存修改' : '记下这笔'}
      </button>
    </PageShell>
  );
}

/** 供类型检查使用的辅助（保持 import 干净）。 */
export type ManualRecordDraft = Partial<ValueRecord> & { amount: number };
