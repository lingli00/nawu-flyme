import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Receipt } from 'lucide-react';
import PageShell from '../components/layout/PageShell';
import PageField from '../components/ui/PageField';
import { Sheet } from '../components/ui/Sheet';
import IconPicker, { IconPreview } from '../components/IconPicker';
import CategoryManageSheet from '../components/CategoryManageSheet';
import BillSheet from '../components/BillSheet';
import SubCalendar from '../components/SubCalendar';
import { useDataStore, useSettingsStore, useUiStore, toastSuccess, toastError } from '../store';
import { monthlyAvg, nextRenewCountdown } from '../domain/subscription';
import { formatMoney } from '../lib/money';
import { useBackGuard } from '../lib/backGuard';
import { today } from '../lib/date';
import logger from '../lib/log';
import { haptic } from '../lib/haptics';
import type { Subscription } from '../types/entities';

/* ============================================================================
 * 铁律（踩过的坑）：
 * 1. 弹层一律 createPortal 挂 document.body（transform 动画祖先会劫持 fixed）。
 * 2. 文本输入一律非受控（defaultValue + onChange 收集，无 value prop）——
 *    安卓 WebView IME 组合输入期受控显示值与实际值不同步。
 * 图标：全部 lucide-react 单色线性图标（库见 src/lib/subIcons.ts），不出现 emoji。
 * ==========================================================================*/

const PERIOD_LABEL = { month: '月', year: '年', week: '周' } as const;

/**
 * 分类彩色底版（v1.0.18 对齐竞品彩色图标卡）：id 哈希 → 柔和色板。
 * ★v1.0.33 P0-4：色板全部改为语义令牌（原 8 个 Tailwind 亮色不在令牌体系内，
 * 且未做深色校验）；现在深浅色自动适配，色相仍保持 8 类可区分。
 */
const CAT_TINTS = [
  'var(--tint-warm)',
  'var(--tint-cool)',
  'var(--xu)',
  'var(--tint-violet)',
  'var(--tint-clay)',
  'var(--gui)',
  'var(--ink-2)',
  'var(--danger)',
];
function catTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CAT_TINTS[h % CAT_TINTS.length];
}

/** 订阅图标统一中性底版（v1.0.3 极简化：不再按 id 上彩色）。 */

/**
 * v1.0.28 · 新增订阅表单抽成独立 sheet（此前内嵌在 SubListPage JSX 里）：
 * RecordMenu 在任意页面就地弹层 + 本页新增入口共用同一组件。
 * 自带 backGuard / 分类就地管理；保存成功后关闭弹层（防重复记录）。
 */
export function SubAddSheet({ onClose }: { onClose: () => void }): React.ReactNode {
  useBackGuard(true, onClose);
  const addSubscription = useDataStore((s) => s.addSubscription);
  const categories = useDataStore((s) => s.categories);
  /* 新增表单（文本非受控收集；关闭即卸载，无需重置） */
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState<Subscription['period']>('month');
  const [startDate, setStartDate] = useState(today());
  const [icon, setIcon] = useState('');
  const [addCatId, setAddCatId] = useState('');
  /** 就地管理订阅分类（不打断添加流程）。 */
  const [managingCats, setManagingCats] = useState(false);

  const submitAdd = async (): Promise<void> => {
    const amt = Number(amount);
    if (!name.trim() || !Number.isFinite(amt) || amt <= 0) {
      toastError('请填写名称和大于 0 的金额');
      return;
    }
    // ★v1.0.29：失败要明确提示（旧代码异常被吞，界面毫无反应 = 用户眼里的「添加不成功」）
    try {
      await addSubscription({
        name: name.trim(),
        amount: amt,
        period,
        every: 1,
        startDate,
        nextRenewDate: startDate,
        categoryId: addCatId || categories.filter((c) => c.kind === 'sub').sort((a, b) => a.order - b.order)[0]?.id,
        icon: icon || undefined,
      });
    } catch (e) {
      logger.error('sub', '添加失败', e);
      toastError('添加失败，请重试');
      return;
    }
    void haptic('medium');
    toastSuccess('已添加订阅');
    onClose();
  };

  /* v1.1.5：与「AI 记一笔」「价值记账」保持同一形态 —— 移动端整页（返回箭头 + 大标题），
     桌面端右抽屉；不再用底部小 sheet，避免同样是「添加信息」却两种观感。 */
  return (
    <>
      <Sheet side="page" title="新增订阅" onClose={onClose} guard={false} drawerWidth="32rem">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-ink-2">图标</p>
            <div className="mt-1.5">
              <IconPicker value={icon} onChange={setIcon} />
            </div>
          </div>
          <SubCatChips value={addCatId} onChange={setAddCatId} onManage={() => setManagingCats(true)} />
          <PageField label="名称">
            <input
              defaultValue={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：B 站大会员"
              className="h-11 w-full nw-input"
            />
          </PageField>
          <div className="grid grid-cols-2 gap-3">
            <PageField label="金额">
              <input
                defaultValue={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                placeholder="0.00"
                className="h-11 w-full nw-input"
              />
            </PageField>
            <PageField label="周期">
              <div className="flex gap-1">
                {(['month', 'year', 'week'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={`h-11 flex-1 rounded-btn border text-sm ${
                      period === p ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2'
                    }`}
                  >
                    {PERIOD_LABEL[p]}
                  </button>
                ))}
              </div>
            </PageField>
          </div>
          <PageField label="开始日期">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-11 w-full nw-input"
            />
          </PageField>
          <button
            onClick={() => void submitAdd()}
            disabled={!name.trim() || !Number(amount)}
            className="mt-1 h-12 w-full rounded-btn bg-accent text-base font-semibold text-white disabled:opacity-40"
          >
            添加
          </button>
        </div>
      </Sheet>
      {/* 就地管理订阅分类（不打断添加流程） */}
      {managingCats ? <CategoryManageSheet kind="sub" onClose={() => setManagingCats(false)} /> : null}
    </>
  );
}

/** 订阅图标渲染：builtin / url: / img: 三形态统一走 IconPreview（网络图标加载失败自动回落）。 */
function SubIcon({ icon, size = 18, className }: { icon?: string; size?: number; className?: string }) {
  return <IconPreview icon={icon ?? ''} size={size} className={className} />;
}

/**
 * P17 订阅管理：月均汇总 + 续费倒计时 + 归档（P2，存 settings.archivedSubIds）。
 *
 * `embedded`：由首页 HomePage「订阅」tab 内嵌渲染 —— 隐藏 PageShell 页头，
 * 只渲染列表与新增 sheet 主体；不传则保持独立子页形态（带返回箭头）。
 * `addOpen` / `onAddOpenChange`：受控的新增 sheet 开关（首页顶部 ＋ 联动用）。
 * `openEditId`：外部（AI 记一笔创建订阅后跳转）要求自动弹出的编辑目标 id，
 *   消费一次后不再重复触发。
 */
export default function SubListPage({
  embedded = false,
  addOpen,
  onAddOpenChange,
  openEditId,
}: {
  embedded?: boolean;
  addOpen?: boolean;
  onAddOpenChange?: (open: boolean) => void;
  openEditId?: string | null;
}) {
  const subs = useDataStore((s) => s.subscriptions);
  const categories = useDataStore((s) => s.categories);
  const bills = useDataStore((s) => s.bills);
  const markBillPaid = useDataStore((s) => s.markBillPaid);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const currency = useSettingsStore((s) => s.settings.currency);

  const [addingInner, setAddingInner] = useState(false);
  /** 新增 sheet 开关：外部传了 addOpen 就走受控，否则自管。 */
  const adding = addOpen ?? addingInner;
  // 注意：受控模式（父级传 addOpen）下 setAddingInner 无效，必须走统一入口 setAdding
  // v1.0.28：返回键守卫由 SubAddSheet 自带（useBackGuard(true, onClose)），此处不再重复挂
  const setAdding = (open: boolean): void => {
    setAddingInner(open);
    onAddOpenChange?.(open);
  };
  /** 正在编辑的订阅（点条目即编辑，对齐原版竞品）。 */
  const [editingSub, setEditingSub] = useState<Subscription | null>(null);
  /** v1.0.21 · M3.1：账单四态管理弹层（补记 / 退款 / 跳过 / 失败）。 */
  const [billOpen, setBillOpen] = useState(false);
  useBackGuard(billOpen, () => setBillOpen(false));
  /** openEditId 消费标记：只自动弹一次，用户手关后不因数据变化重弹。 */
  const consumedHintRef = useRef<string | null>(null);

  /* AI 记一笔创建订阅后跳转过来：自动弹出该条目的编辑 sheet（消费一次）。 */
  useEffect(() => {
    if (!openEditId || consumedHintRef.current === openEditId) return;
    const s = subs.find((x) => x.id === openEditId);
    if (s) {
      consumedHintRef.current = openEditId;
      setEditingSub(s);
    }
  }, [openEditId, subs]);

  const subCats = useMemo(
    () => categories.filter((c) => c.kind === 'sub').sort((a, b) => a.order - b.order),
    [categories],
  );

  /** 停用/归档判断（★存 settings.archivedSubIds，不写在订阅记录上）。 */
  const isArchived = (sub: Subscription): boolean => (settings.archivedSubIds ?? []).includes(sub.id);

  const active = subs.filter((s) => !isArchived(s));
  const archived = subs.filter((s) => isArchived(s));
  const pendingBills = useMemo(() => bills.filter((b) => b.status === 'pending'), [bills]);
  /** v1.0.21：扣款失败的账单（需补记或跳过），在汇总卡上给出红点提示。 */
  const failedBills = useMemo(() => bills.filter((b) => b.status === 'failed'), [bills]);

  /* —— v1.0 对标竞品的订阅汇总 —— */
  /** 分类筛选 chips（'all' = 全部订阅）。 */
  const [catFilter, setCatFilter] = useState<string>('all');

  const filtered = useMemo(() => {
    const base = catFilter === 'all' ? active : active.filter((s) => s.categoryId === catFilter);
    return [...base].sort((a, b) => nextRenewCountdown(a) - nextRenewCountdown(b));
  }, [active, catFilter]);

  const paidBills = useMemo(() => bills.filter((b) => b.status === 'paid'), [bills]);
  /** 累计花费 = 各订阅初始校准 + 已付账单 − 退款（对标竞品口径）。 */
  const totalSpent = useMemo(
    () =>
      Math.round(
        (active.reduce((acc, s) => acc + (Number(s.initSpent) || 0), 0) +
          paidBills.reduce((acc, b) => acc + (Number(b.amount) || 0) - (Number(b.refund) || 0), 0)) *
          100,
      ) / 100,
    [active, paidBills],
  );
  const ymNow = today().slice(0, 7);
  const paidThisMonth = useMemo(
    () =>
      paidBills
        .filter((b) => (b.paidDate ?? b.dueDate).slice(0, 7) === ymNow)
        .reduce((a, b) => a + (Number(b.amount) || 0), 0),
    [paidBills, ymNow],
  );
  const dueThisMonth = useMemo(
    () => pendingBills.filter((b) => b.dueDate.slice(0, 7) === ymNow).reduce((a, b) => a + (Number(b.amount) || 0), 0),
    [pendingBills, ymNow],
  );
  /** 未来 30 天要续费的（升序）。 */
  const renewSoon = useMemo(
    () =>
      active
        .filter((s) => s.type !== 'lifetime')
        .map((s) => ({ sub: s, days: nextRenewCountdown(s) }))
        .filter((x) => x.days >= 0 && x.days <= 30)
        .sort((a, b) => a.days - b.days),
    [active],
  );

  const toggleArchive = async (s: Subscription) => {
    const cur = settings.archivedSubIds ?? [];
    const next = cur.includes(s.id) ? cur.filter((x) => x !== s.id) : [...cur, s.id];
    await updateSettings({ archivedSubIds: next });
    toastSuccess(next.includes(s.id) ? '已停用（不再计入月均）' : '已恢复在用');
  };

  const subRow = (s: Subscription) => {
    const days = nextRenewCountdown(s);
    const cat = categories.find((c) => c.id === s.categoryId);
    const catName = cat?.name;
    const tint = catTint(s.categoryId ?? s.id);
    return (
      <li key={s.id} className="rounded-card border border-line bg-surface">
        <div
          onClick={() => setEditingSub(s)}
          role="button"
          className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-3 text-left active:opacity-70"
        >
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl"
            style={{ background: `color-mix(in srgb, ${tint} 16%, var(--surface))`, color: tint }}
          >
            <SubIcon icon={s.icon} size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 truncate text-sm font-medium">
              {s.name}
              {s.type === 'lifetime' ? (
                <span className="shrink-0 rounded-full bg-surface-2 px-2 text-[11px] leading-4 text-ink-3">买断</span>
              ) : null}
              {isArchived(s) ? (
                <span className="shrink-0 rounded-full bg-surface-2 px-2 text-[11px] leading-4 text-ink-3">已停用</span>
              ) : null}
            </p>
            <p className="text-[11px] text-ink-3">
              {catName ? `${catName} · ` : ''}{formatMoney(s.amount, s.currency)}/{PERIOD_LABEL[s.period]}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p
              className="text-xs font-semibold"
              style={{ color: days < 0 ? 'var(--fou)' : days <= 7 ? 'var(--gui)' : 'var(--ink)' }}
            >
              {days >= 0 ? `${days} 天后续费` : `已逾期 ${-days} 天`}
            </p>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void toggleArchive(s);
              }}
              className="text-[11px] text-ink-3"
            >
              {isArchived(s) ? '恢复' : '停用'}
            </button>
          </div>
        </div>
        {pendingBills.some((b) => b.subId === s.id) ? (
          <div className="flex items-center justify-between border-t border-line-2 px-3.5 py-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setBillOpen(true);
              }}
              className="text-xs underline-offset-2 active:underline"
              style={{ color: 'var(--xu)' }}
            >
              有待付账单 · 去处理
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                const b = pendingBills.find((x) => x.subId === s.id)!;
                void markBillPaid(b.id).then(() => toastSuccess('已标记支付'));
              }}
              className="h-7 rounded-btn bg-accent-soft px-2.5 text-[11px] font-medium text-accent"
            >
              标记已付 {formatMoney(pendingAmount(pendingBills, s.id), currency)}
            </button>
          </div>
        ) : null}
      </li>
    );
  };

  const body = (
    <>
      {/* v1.0 汇总大卡（对标竞品：累计花费 + 本月已付/待续费 + 预计月均/年化） */}
      <div className="mb-3 rounded-card border border-line bg-surface p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-ink-3">累计花费（含初始校准）</p>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">有效 {active.length} 项</span>
        </div>
        <p className="mt-1 text-3xl font-bold leading-10">{formatMoney(totalSpent, currency)}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
          <span>本月已付 <b className="text-ink-2">{formatMoney(paidThisMonth, currency)}</b></span>
          <span>本月待续费 <b className="text-ink-2">{formatMoney(dueThisMonth, currency)}</b></span>
        </div>
        <div className="mt-2.5 flex items-center justify-between rounded-btn bg-surface-2 px-3 py-2 text-xs">
          <span className="text-ink-3">
            预计月均 <b className="text-sm text-ink">{formatMoney(monthlyAvg(active), currency)}</b>
          </span>
          <span className="text-ink-3">
            预计年化 <b className="text-sm text-ink">{formatMoney(monthlyAvg(active) * 12, currency)}</b>
          </span>
        </div>
        {/* v1.0.21 · M3.1：账单流水入口（待确认 / 失败 需人工处理） */}
        <button
          onClick={() => setBillOpen(true)}
          className="mt-2.5 flex w-full items-center justify-between rounded-btn border border-line px-3 py-2 text-xs active:scale-[0.99]"
        >
          <span className="flex items-center gap-1.5 text-ink-2">
            <Receipt size={13} />
            账单流水
            <span className="text-ink-3">{bills.length} 笔</span>
          </span>
          <span className="flex items-center gap-2">
            {pendingBills.length ? (
              <b className="text-[11px]" style={{ color: 'var(--xu)' }}>
                待确认 {pendingBills.length}
              </b>
            ) : null}
            {failedBills.length ? (
              <b className="text-[11px]" style={{ color: 'var(--fou)' }}>
                失败 {failedBills.length}
              </b>
            ) : null}
            <span className="text-ink-3">›</span>
          </span>
        </button>
      </div>

      {/* 未来 30 天续费预告 */}
      {renewSoon.length > 0 ? (
        <div className="mb-3 rounded-card border border-line bg-surface px-3.5 py-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-ink-2">
              <CalendarDays size={13} className="mr-1 inline-block align-[-2px]" />
            未来 30 天 · {renewSoon.length} 项
            </p>
            <p className="text-[11px] text-ink-3">
              合计 {formatMoney(renewSoon.reduce((a, x) => a + x.sub.amount, 0), currency)}
            </p>
          </div>
          <ul className="mt-2 space-y-1.5">
            {renewSoon.slice(0, 3).map(({ sub, days }) => (
              <li key={sub.id} className="flex items-center justify-between text-xs">
                <span className="min-w-0 truncate text-ink-2">
                  {days === 0 ? '今天' : days === 1 ? '明天' : `${days} 天后`} · {sub.name}
                </span>
                <span className="ml-2 shrink-0 font-medium">{formatMoney(sub.amount, sub.currency)}</span>
              </li>
            ))}
            {renewSoon.length > 3 ? (
              <li className="text-[11px] text-ink-3">…还有 {renewSoon.length - 3} 项，见下方列表</li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {/* v1.0.21 · M3.1：续费日历（按月网格看扣款安排，点日期出明细） */}
      {active.length > 0 ? <SubCalendar onOpenBills={() => setBillOpen(true)} /> : null}

      {/* 分类筛选 chips */}
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
        {[{ id: 'all', name: '全部订阅' }, ...subCats].map((c) => (
          <button
            key={c.id}
            onClick={() => setCatFilter(c.id)}
            className={`h-8 shrink-0 rounded-full border px-3.5 text-xs transition-all active:scale-95 ${
              catFilter === c.id ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line bg-surface text-ink-3'
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-card border border-dashed border-line bg-surface p-10 text-center text-sm text-ink-3">
          {subs.length === 0 ? '还没有订阅，点右上角添加' : catFilter === 'all' ? '全部已停用' : '该分类下暂无在用订阅'}
        </div>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2 dtxl:grid-cols-3">{filtered.map(subRow)}</ul>
      )}

      {archived.length > 0 ? (
        <>
          <h3 className="mb-2 mt-4 px-1 text-xs font-semibold text-ink-3">已停用（不计入月均）</h3>
          <ul className="grid gap-2 opacity-70 md:grid-cols-2 dtxl:grid-cols-3">{archived.map(subRow)}</ul>
        </>
      ) : null}

      {/* 新增 sheet（v1.0.28 抽成独立组件；portal 挂 body 的规则在组件内保证） */}
      {adding ? <SubAddSheet onClose={() => setAdding(false)} /> : null}

      {/* 编辑 sheet（portal 挂 body；embedded 与独立访问模式都生效） */}
      {editingSub ? <SubEditSheet initial={editingSub} onClose={() => setEditingSub(null)} /> : null}

      {/* v1.0.21 · M3.1：账单四态弹层 */}
      {billOpen ? <BillSheet onClose={() => setBillOpen(false)} /> : null}
    </>
  );

  // 内嵌模式：只渲染主体（页头/新增入口由 HomePage 提供）
  if (embedded) return body;

  return (
    <PageShell
      title="订阅管理"
      right={
        <button onClick={() => setAdding(true)} className="h-9 rounded-btn bg-accent px-3 text-sm font-medium text-white">
          ＋ 订阅
        </button>
      }
    >
      {body}
    </PageShell>
  );
}

/** 小工具：取某订阅的第一笔待付账单金额。 */
function pendingAmount(bills: Array<{ subId: string; status: string; amount: number }>, subId: string): number {
  return bills.find((b) => b.subId === subId && b.status === 'pending')?.amount ?? 0;
}

/** 订阅分类选择 chips + 就地管理入口（新增/编辑表单共用；不用再跳「我的」打断流程）。 */
function SubCatChips({
  value,
  onChange,
  onManage,
}: {
  value: string;
  onChange: (id: string) => void;
  onManage: () => void;
}) {
  const categories = useDataStore((s) => s.categories);
  const subCats = useMemo(
    () => categories.filter((c) => c.kind === 'sub').sort((a, b) => a.order - b.order),
    [categories],
  );
  const active = value || subCats[0]?.id || '';
  /* v1.1.4：分类默认只铺 8 个，其余收进「更多」；当前选中的始终可见。 */
  const [expanded, setExpanded] = useState(false);
  const PREVIEW = 8;
  const shown = useMemo(() => {
    if (expanded || subCats.length <= PREVIEW) return subCats;
    const head = subCats.slice(0, PREVIEW);
    const sel = subCats.find((c) => c.id === active);
    if (sel && !head.some((c) => c.id === sel.id)) return [...head, sel];
    return head;
  }, [subCats, expanded, active]);
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-ink-2">分类</p>
        <div className="flex items-center gap-3">
          {subCats.length > PREVIEW ? (
            <button type="button" onClick={() => setExpanded((v) => !v)} className="text-xs font-medium text-ink-2">
              {expanded ? '收起' : `更多 ${subCats.length - PREVIEW} 个`}
            </button>
          ) : null}
          <button type="button" onClick={onManage} className="text-xs font-medium text-accent">
            管理
          </button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {shown.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            className={`h-8 rounded-full border px-3 text-xs transition-all active:scale-95 ${
              active === c.id ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-ink-2'
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ============================================================================
 * 订阅编辑 sheet（portal 挂 body，风格对齐 GoodsFormSheet）。
 * 保存走 updateSubscription(id, patch)；操作行含 停用/恢复 + 删除（confirm）。
 * 注：备注（note）为 App 端扩展字段 —— Subscription 实体没有该键，
 *     云快照整体恢复 collections 时该字段会丢失（settings 合并不受影响）。
 * ==========================================================================*/
function SubEditSheet({ initial, onClose }: { initial: Subscription; onClose: () => void }) {
  useBackGuard(true, onClose);
  const updateSubscription = useDataStore((s) => s.updateSubscription);
  const removeById = useDataStore((s) => s.removeById);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const { confirm } = useUiStore.getState();

  /* 文本输入非受控：defaultValue + onChange 收集（IME 铁律） */
  const [name, setName] = useState(initial.name);
  const [amount, setAmount] = useState(String(initial.amount ?? ''));
  const [period, setPeriod] = useState<Subscription['period']>(initial.period);
  const [every, setEvery] = useState(String(initial.every ?? 1));
  const [nextRenewDate, setNextRenewDate] = useState(initial.nextRenewDate);
  const [note, setNote] = useState((initial as { note?: string }).note ?? '');
  const [icon, setIcon] = useState(initial.icon ?? '');
  const [catId, setCatId] = useState(initial.categoryId ?? '');
  const [managingCats, setManagingCats] = useState(false);

  const archived = (settings.archivedSubIds ?? []).includes(initial.id);

  const submit = async (): Promise<void> => {
    const amt = Number(amount);
    const ev = Math.max(1, Math.round(Number(every) || 1));
    if (!name.trim() || !Number.isFinite(amt) || amt <= 0) {
      toastError('请填写名称和大于 0 的金额');
      return;
    }
    const patch: Partial<Subscription> & { note?: string } = {
      name: name.trim(),
      amount: amt,
      period,
      every: ev,
      nextRenewDate,
      categoryId: catId || initial.categoryId,
      icon: icon || undefined,
      note: note.trim() || undefined,
    };
    try {
      await updateSubscription(initial.id, patch);
    } catch (e) {
      logger.error('sub', '保存失败', e);
      toastError('保存失败，请重试');
      return;
    }
    void haptic('medium');
    toastSuccess('已保存');
    onClose();
  };

  /** 停用/恢复（沿用列表页逻辑：存 settings.archivedSubIds）。 */
  const toggleArchive = async (): Promise<void> => {
    const cur = settings.archivedSubIds ?? [];
    const next = cur.includes(initial.id) ? cur.filter((x) => x !== initial.id) : [...cur, initial.id];
    await updateSettings({ archivedSubIds: next });
    toastSuccess(next.includes(initial.id) ? '已停用（不再计入月均）' : '已恢复在用');
  };

  const del = async (): Promise<void> => {
    const ok = await confirm({
      title: `删除「${initial.name}」？`,
      message: '删除后不可恢复；如只是暂时不用，建议用「停用」。',
    });
    if (!ok) return;
    await removeById('subscriptions', initial.id);
    toastSuccess('已删除');
    onClose();
  };

  return (
    <>
      <Sheet side="page" title="编辑订阅" onClose={onClose} guard={false} drawerWidth="32rem">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-ink-2">图标</p>
            <div className="mt-1.5">
              <IconPicker value={icon} onChange={setIcon} />
            </div>
          </div>
          <SubCatChips value={catId} onChange={setCatId} onManage={() => setManagingCats(true)} />
          <PageField label="名称">
            <input
              defaultValue={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：B 站大会员"
              className="h-11 w-full nw-input"
            />
          </PageField>
          <div className="grid grid-cols-2 gap-3">
            <PageField label="金额">
              <input
                defaultValue={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                placeholder="0.00"
                className="h-11 w-full nw-input"
              />
            </PageField>
            <PageField label="周期">
              <div className="flex gap-1">
                {(['week', 'month', 'year'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={`h-11 flex-1 rounded-btn border text-sm transition-all active:scale-95 ${
                      period === p ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2'
                    }`}
                  >
                    {PERIOD_LABEL[p]}
                  </button>
                ))}
              </div>
            </PageField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <PageField label="每隔（几个周期扣一次）">
              <input
                defaultValue={every}
                onChange={(e) => setEvery(e.target.value.replace(/[^\d]/g, ''))}
                inputMode="numeric"
                placeholder="1"
                className="h-11 w-full nw-input"
              />
            </PageField>
            <PageField label="下次续费日期">
              <input
                type="date"
                value={nextRenewDate}
                onChange={(e) => setNextRenewDate(e.target.value)}
                className="h-11 w-full nw-input"
              />
            </PageField>
          </div>
          <PageField label="备注（可选）">
            <input
              defaultValue={note}
              onChange={(e) => setNote(e.target.value)}
              className="h-10 w-full nw-input"
            />
          </PageField>

          {/* 操作行：停用/恢复 + 删除 */}
          <div className="flex gap-2">
            <button
              onClick={() => void toggleArchive()}
              className="h-10 flex-1 rounded-btn border border-line text-xs text-ink-2 active:scale-95 transition-transform"
            >
              {archived ? '恢复在用' : '停用（不计月均）'}
            </button>
            <button
              onClick={() => void del()}
              className="h-10 flex-1 rounded-btn border border-line text-xs active:scale-95 transition-transform"
              style={{ color: 'var(--fou)' }}
            >
              删除
            </button>
          </div>

          <button
            onClick={() => void submit()}
            disabled={!name.trim() || !Number(amount)}
            className="h-12 w-full rounded-btn bg-accent text-base font-semibold text-white active:scale-[0.98] transition-transform disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </Sheet>
      {/* 就地管理订阅分类（遮罩点击不穿透：管理层与编辑层是兄弟节点） */}
      {managingCats ? <CategoryManageSheet kind="sub" onClose={() => setManagingCats(false)} /> : null}
    </>
  );
}
