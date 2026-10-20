import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import PageShell from '../components/layout/PageShell';
import PageField from '../components/ui/PageField';
import { useDataStore, useUiStore, toastSuccess, toastError } from '../store';
import { CATEGORY_ICON_GROUPS, getCategoryIcon } from '../lib/categoryIcons';
import type { Category, CategoryKind } from '../types/entities';

/** P24 分类管理：物品/订阅/记账三组分类的增删改 + 同组内上下移排序。
 *  ★v1.0.0：开放「记账分类」（生活流）管理——以前生活流只有 8 个内置分类且不可增改，
 *  买衣服/买饰品/充话费/充游戏/云服务这些日常开销无处可归；现在既能内置 24 个，
 *  也能自行新增。
 *  图标用 lucide 线性图标库（src/lib/categoryIcons.ts），旧 emoji 数据渲染时回落兜底。 */

/** 新建分类的默认图标 id。 */
const DEFAULT_CATEGORY_ICON = 'smartphone';

const KIND_LABEL: Record<CategoryKind, string> = {
  goods: '物品分类',
  sub: '订阅分类',
  ledger: '记账分类',
};

/** 新增/编辑分类的底部弹层（portal 自渲染，与 HomePage 的 GoodsFormSheet 同模式）。 */
function CategoryFormSheet({
  editing,
  initialKind,
  onClose,
}: {
  /** 传入则为编辑模式（kind 不可改）。 */
  editing?: Category;
  initialKind: CategoryKind;
  onClose: () => void;
}) {
  const categories = useDataStore((s) => s.categories);
  const addCategory = useDataStore((s) => s.addCategory);
  const updateCategory = useDataStore((s) => s.updateCategory);

  const isEdit = Boolean(editing);
  const [kind, setKind] = useState<CategoryKind>(editing?.kind ?? initialKind);
  const [name, setName] = useState(editing?.name ?? '');
  const [icon, setIcon] = useState<string>(
    // 旧 emoji 数据不回填进选择器（选择器只有 lucide id），编辑旧分类时默认给一个有效 id
    editing && getCategoryIcon(editing.icon) !== getCategoryIcon(null) ? editing.icon : DEFAULT_CATEGORY_ICON,
  );

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      toastError('请输入分类名称');
      return;
    }
    if (isEdit && editing) {
      await updateCategory(editing.id, { name: n, icon });
      toastSuccess('分类已保存');
    } else {
      // 新增：order 取同组最大值 + 1，排到该组末尾
      const siblings = categories.filter((c) => c.kind === kind);
      const maxOrder = siblings.reduce((m, c) => Math.max(m, c.order), -1);
      await addCategory({ name: n, icon, kind, order: maxOrder + 1 });
      toastSuccess('分类已新增');
    }
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={onClose}>
      <div
        className="sheet-enter mx-auto max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}
      >
        <h2 className="mb-3 text-base font-semibold">{isEdit ? '编辑分类' : '新增分类'}</h2>
        <div className="space-y-3">
          {/* 新增时可选 kind；编辑时 kind 不可改 */}
          {!isEdit ? (
            <PageField label="类型">
              <div className="flex gap-1">
                {(['goods', 'sub', 'ledger'] as CategoryKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`h-10 flex-1 rounded-btn border text-sm ${
                      kind === k ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-ink-2'
                    }`}
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </PageField>
          ) : null}

          <PageField label="名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 数码"
              enterKeyHint="done"
              className="h-11 w-full nw-input"
            />
          </PageField>

          <PageField label="图标">
            <div className="max-h-56 space-y-2 overflow-y-auto rounded-btn border border-line bg-surface-2 p-2">
              {CATEGORY_ICON_GROUPS.map((g) => (
                <div key={g.group}>
                  <p className="px-0.5 text-[11px] text-ink-3">{g.group}</p>
                  <div className="mt-1 grid grid-cols-8 gap-1.5">
                    {g.icons.map((d) => {
                      const RowIcon = d.Icon;
                      return (
                        <button
                          key={d.id}
                          type="button"
                          title={d.label}
                          aria-label={d.label}
                          onClick={() => setIcon(d.id)}
                          className={`flex h-9 items-center justify-center rounded-btn border ${
                            icon === d.id
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-transparent bg-surface text-ink-2'
                          }`}
                        >
                          <RowIcon size={18} strokeWidth={1.8} aria-hidden />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </PageField>

          <button
            onClick={() => void submit()}
            className="h-11 w-full rounded-btn bg-accent text-sm font-semibold text-white"
          >
            {isEdit ? '保存' : '新增'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 一组分类（卡片列表）。 */
function CategorySection({
  title,
  cats,
  unit,
  countOf,
  onAdd,
  onEdit,
  onMove,
  onDelete,
}: {
  title: string;
  cats: Category[];
  /** 数量单位文案：「件物品」/「个订阅」。 */
  unit: string;
  countOf: (c: Category) => number;
  onAdd: () => void;
  onEdit: (c: Category) => void;
  onMove: (c: Category, dir: -1 | 1) => void;
  onDelete: (c: Category) => void;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold text-ink-2">{title}</h2>
        <button onClick={onAdd} className="text-xs font-medium text-accent">
          ＋ 新增
        </button>
      </div>
      <ul className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface">
        {cats.length === 0 ? (
          <li className="px-3.5 py-6 text-center text-xs text-ink-3">还没有分类，点右上角新增一个</li>
        ) : (
          cats.map((c, i) => (
            <li key={c.id} className="flex items-center gap-2 px-3.5 py-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-btn bg-surface-2 text-accent">
                {(() => {
                  const RowIcon = getCategoryIcon(c.icon);
                  return <RowIcon size={18} strokeWidth={1.8} aria-hidden />;
                })()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{c.name}</p>
                <p className="text-[11px] text-ink-3">
                  {countOf(c)} {unit}
                </p>
              </div>
              <button
                onClick={() => onEdit(c)}
                className="h-8 shrink-0 rounded-btn bg-accent-soft px-2.5 text-xs font-medium text-accent"
              >
                编辑
              </button>
              <button
                onClick={() => onMove(c, -1)}
                disabled={i === 0}
                aria-label={`上移 ${c.name}`}
                className="h-8 w-8 shrink-0 rounded-btn text-ink-2 active:bg-surface-2 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                onClick={() => onMove(c, 1)}
                disabled={i === cats.length - 1}
                aria-label={`下移 ${c.name}`}
                className="h-8 w-8 shrink-0 rounded-btn text-ink-2 active:bg-surface-2 disabled:opacity-30"
              >
                ↓
              </button>
              <button
                onClick={() => onDelete(c)}
                aria-label={`删除 ${c.name}`}
                className="h-8 w-8 shrink-0 rounded-btn text-sm active:bg-surface-2"
                style={{ color: 'var(--fou)' }}
              >
                ✕
              </button>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

export default function CategoryPage() {
  const categories = useDataStore((s) => s.categories);
  const goods = useDataStore((s) => s.goods);
  const subscriptions = useDataStore((s) => s.subscriptions);
  const valueRecords = useDataStore((s) => s.valueRecords);
  const updateCategory = useDataStore((s) => s.updateCategory);
  const removeCategory = useDataStore((s) => s.removeCategory);

  const [sheet, setSheet] = useState<{ kind: CategoryKind; editing?: Category } | null>(null);

  // 两组分类各自按 order 升序（排序辅助在页面内完成，不动 store）
  const goodsCats = useMemo(
    () => categories.filter((c) => c.kind === 'goods').sort((a, b) => a.order - b.order),
    [categories],
  );
  const subCats = useMemo(
    () => categories.filter((c) => c.kind === 'sub').sort((a, b) => a.order - b.order),
    [categories],
  );
  const ledgerCats = useMemo(
    () => categories.filter((c) => c.kind === 'ledger').sort((a, b) => a.order - b.order),
    [categories],
  );

  const goodsCountOf = (c: Category) => goods.filter((g) => g.categoryId === c.id).length;
  const subCountOf = (c: Category) => subscriptions.filter((s) => s.categoryId === c.id).length;
  const ledgerCountOf = (c: Category) => valueRecords.filter((r) => r.categoryId === c.id).length;

  /** 同组内交换相邻两项的 order 值实现上/下移。 */
  const move = async (kind: CategoryKind, id: string, dir: -1 | 1) => {
    const list = categories.filter((c) => c.kind === kind).sort((a, b) => a.order - b.order);
    const idx = list.findIndex((c) => c.id === id);
    const j = idx + dir;
    if (idx === -1 || j < 0 || j >= list.length) return;
    const a = list[idx];
    const b = list[j];
    await updateCategory(a.id, { order: b.order });
    await updateCategory(b.id, { order: a.order });
  };

  /** 删除分类：先 confirm（如实描述关联物品的行为），再删除分类行本身。 */
  const del = async (c: Category) => {
    const nGoods = goodsCountOf(c);
    const nSubs = subCountOf(c);
    const nLedger = ledgerCountOf(c);
    const usedParts: string[] = [];
    if (nGoods > 0) usedParts.push(`${nGoods} 件物品`);
    if (nSubs > 0) usedParts.push(`${nSubs} 个订阅`);
    if (nLedger > 0) usedParts.push(`${nLedger} 笔流水`);
    const usage = usedParts.length > 0 ? `该分类正被 ${usedParts.join('、')}使用，删除后它们将不再归属任何分类（界面上显示为未分类）` : '该分类当前没有被物品、订阅或流水使用';
    const ok = await useUiStore.getState().confirm({
      title: `删除分类「${c.name}」？`,
      message: `${usage}。物品/订阅数据本身不会被删除。`,
    });
    if (!ok) return;
    await removeCategory(c.id);
    toastSuccess('分类已删除');
  };

  return (
    <PageShell
      title="分类管理"
      subtitle="自定义物品、订阅与生活流的分组和排序"
      right={
        <button
          onClick={() => setSheet({ kind: 'goods' })}
          className="mr-1 h-9 rounded-full bg-accent-soft px-3.5 text-xs font-medium text-accent"
        >
          ＋ 新增
        </button>
      }
    >
      <div className="space-y-4">
        <CategorySection
          title="物品分类"
          cats={goodsCats}
          unit="件物品"
          countOf={goodsCountOf}
          onAdd={() => setSheet({ kind: 'goods' })}
          onEdit={(c) => setSheet({ kind: 'goods', editing: c })}
          onMove={(c, dir) => void move('goods', c.id, dir)}
          onDelete={(c) => void del(c)}
        />
        <CategorySection
          title="订阅分类"
          cats={subCats}
          unit="个订阅"
          countOf={subCountOf}
          onAdd={() => setSheet({ kind: 'sub' })}
          onEdit={(c) => setSheet({ kind: 'sub', editing: c })}
          onMove={(c, dir) => void move('sub', c.id, dir)}
          onDelete={(c) => void del(c)}
        />
        <CategorySection
          title="记账分类（生活流）"
          cats={ledgerCats}
          unit="笔流水"
          countOf={ledgerCountOf}
          onAdd={() => setSheet({ kind: 'ledger' })}
          onEdit={(c) => setSheet({ kind: 'ledger', editing: c })}
          onMove={(c, dir) => void move('ledger', c.id, dir)}
          onDelete={(c) => void del(c)}
        />
      </div>

      {sheet ? <CategoryFormSheet editing={sheet.editing} initialKind={sheet.kind} onClose={() => setSheet(null)} /> : null}
    </PageShell>
  );
}
