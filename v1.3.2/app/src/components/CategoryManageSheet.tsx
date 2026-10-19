import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import PageField from './ui/PageField';
import { useDataStore, useUiStore, toastSuccess, toastError } from '../store';
import { CATEGORY_ICON_GROUPS, getCategoryIcon } from '../lib/categoryIcons';
import type { Category, CategoryKind } from '../types/entities';
import { useBackGuard } from '../lib/backGuard';

/**
 * 可复用的分类管理弹层（portal 挂 body）。
 *
 * 为什么存在：分类管理原先只有「我的 → 分类管理」一个入口，用户在记一笔/加物品/
 * 加订阅的流程里想建个新分类就得中断操作跳走再回来，思路被打断。
 * 现在三个添加/编辑场景（记一笔、物品表单、订阅表单）都能就地唤起本弹层完成
 * 新增/编辑/删除/排序，不离开当前表单。
 *
 * 弹层内再叠一层「新增/编辑分类」小弹层（同为 portal，z-50 盖住本层 z-40）。
 */

const KIND_LABEL: Record<CategoryKind, string> = {
  goods: '物品分类',
  sub: '订阅分类',
  ledger: '记账分类',
};

const DEFAULT_CATEGORY_ICON = 'smartphone';

/** 单个分类的新增/编辑小弹层（z-50，叠在管理列表之上）。 */
function CategoryFormMini({
  kind,
  editing,
  onClose,
}: {
  kind: CategoryKind;
  editing?: Category;
  onClose: () => void;
}) {
  const categories = useDataStore((s) => s.categories);
  const addCategory = useDataStore((s) => s.addCategory);
  const updateCategory = useDataStore((s) => s.updateCategory);

  const isEdit = Boolean(editing);
  const [name, setName] = useState(editing?.name ?? '');
  const [icon, setIcon] = useState<string>(
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
      const siblings = categories.filter((c) => c.kind === kind);
      const maxOrder = siblings.reduce((m, c) => Math.max(m, c.order), -1);
      await addCategory({ name: n, icon, kind, order: maxOrder + 1 });
      toastSuccess('分类已新增');
    }
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={onClose}>
      <div
        className="sheet-enter mx-auto max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}
      >
        <h3 className="mb-3 text-base font-semibold">{isEdit ? '编辑分类' : `新增${KIND_LABEL[kind]}`}</h3>
        <div className="space-y-3">
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
            <div className="max-h-52 space-y-2 overflow-y-auto rounded-btn border border-line bg-surface-2 p-2">
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

/**
 * 分类管理弹层：某一组（kind）分类的增删改 + 排序。
 * 挂接点：ManualRecordSheet（记账）、HomePage 物品表单、SubListPage 订阅表单。
 */
export default function CategoryManageSheet({
  kind,
  onClose,
}: {
  kind: CategoryKind;
  onClose: () => void;
}) {
  useBackGuard(true, onClose);
  const categories = useDataStore((s) => s.categories);
  const goods = useDataStore((s) => s.goods);
  const subscriptions = useDataStore((s) => s.subscriptions);
  const valueRecords = useDataStore((s) => s.valueRecords);
  const updateCategory = useDataStore((s) => s.updateCategory);
  const removeCategory = useDataStore((s) => s.removeCategory);
  const { confirm } = useUiStore.getState();

  const [form, setForm] = useState<{ editing?: Category } | null>(null);

  const cats = useMemo(
    () => categories.filter((c) => c.kind === kind).sort((a, b) => a.order - b.order),
    [categories, kind],
  );

  const countOf = (c: Category): number => {
    if (kind === 'goods') return goods.filter((g) => g.categoryId === c.id).length;
    if (kind === 'sub') return subscriptions.filter((s) => s.categoryId === c.id).length;
    return valueRecords.filter((r) => r.categoryId === c.id).length;
  };
  const unit = kind === 'goods' ? '件物品' : kind === 'sub' ? '个订阅' : '笔流水';

  const move = async (id: string, dir: -1 | 1) => {
    const idx = cats.findIndex((c) => c.id === id);
    const j = idx + dir;
    if (idx === -1 || j < 0 || j >= cats.length) return;
    await updateCategory(cats[idx].id, { order: cats[j].order });
    await updateCategory(cats[j].id, { order: cats[idx].order });
  };

  const del = async (c: Category) => {
    const used = countOf(c);
    const usage =
      used > 0
        ? `该分类正被 ${used} ${unit}使用，删除后它们将显示为未分类`
        : '该分类当前没有被使用';
    const ok = await confirm({
      title: `删除分类「${c.name}」？`,
      message: `${usage}。数据本身不会被删除。`,
    });
    if (!ok) return;
    await removeCategory(c.id);
    toastSuccess('分类已删除');
  };

  return (
    <>
      {createPortal(
        <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={onClose}>
          <div
            className="sheet-enter mx-auto max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-surface p-4"
            onClick={(e) => e.stopPropagation()}
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">管理{KIND_LABEL[kind]}</h2>
              <button
                onClick={() => setForm({})}
                className="h-8 rounded-full bg-accent-soft px-3 text-xs font-medium text-accent"
              >
                ＋ 新增
              </button>
            </div>

            {cats.length === 0 ? (
              <p className="rounded-card border border-dashed border-line bg-surface-2 p-6 text-center text-xs text-ink-3">
                还没有分类，点右上角「＋ 新增」建一个
              </p>
            ) : (
              <ul className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface">
                {cats.map((c, i) => {
                  const RowIcon = getCategoryIcon(c.icon);
                  return (
                    <li key={c.id} className="flex items-center gap-2 px-3 py-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-btn bg-surface-2 text-accent">
                        <RowIcon size={18} strokeWidth={1.8} aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{c.name}</p>
                        <p className="text-[11px] text-ink-3">
                          {countOf(c)} {unit}
                        </p>
                      </div>
                      <button
                        onClick={() => setForm({ editing: c })}
                        className="h-8 shrink-0 rounded-btn bg-accent-soft px-2.5 text-xs font-medium text-accent"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => void move(c.id, -1)}
                        disabled={i === 0}
                        aria-label={`上移 ${c.name}`}
                        className="h-8 w-8 shrink-0 rounded-btn text-ink-2 active:bg-surface-2 disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => void move(c.id, 1)}
                        disabled={i === cats.length - 1}
                        aria-label={`下移 ${c.name}`}
                        className="h-8 w-8 shrink-0 rounded-btn text-ink-2 active:bg-surface-2 disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        onClick={() => void del(c)}
                        aria-label={`删除 ${c.name}`}
                        className="h-8 w-8 shrink-0 rounded-btn text-sm active:bg-surface-2"
                        style={{ color: 'var(--fou)' }}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <button
              onClick={onClose}
              className="mt-4 h-11 w-full rounded-btn border border-line text-sm text-ink-2"
            >
              完成
            </button>
          </div>
        </div>,
        document.body,
      )}
      {/* 新增/编辑分类小弹层：与管理层是 React 树上的兄弟节点，
          遮罩点击不会冒泡把管理层关掉（portal 会沿 React 树冒泡，必须兄弟化） */}
      {form ? <CategoryFormMini kind={kind} editing={form.editing} onClose={() => setForm(null)} /> : null}
    </>
  );
}
