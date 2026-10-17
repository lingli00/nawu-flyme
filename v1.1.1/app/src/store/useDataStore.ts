import { create } from 'zustand';
import { newId } from '../lib/id';
import { nowISO, today } from '../lib/date';
import { round } from '../lib/money';
import { COLLECTIONS } from '../types/entities';
import type {
  Bill,
  Category,
  Cooldown,
  CollectionName,
  Goods,
  Mood,
  Reminder,
  Subscription,
  TimeRec,
  UndoEntry,
  UsageRecord,
  ValueRecord,
  Wall,
  WishItem,
} from '../types/entities';
import { loadAllCollections, saveAllCollections, saveCollection, saveCollectionNow } from '../storage/repo';
import { useSettingsStore } from './useSettingsStore';

/**
 * 12 个本地集合 + CRUD + 撤销。
 *
 * 写策略：内存立即更新 → `repo.saveCollection`（debounce 300ms 落盘）。
 * 每次变更 `changedSinceBackup += 1`，供 `domain/backupPolicy` 做自动备份节流。
 */

/** 撤销栈最大长度。 */
const UNDO_LIMIT = 20;

interface DataState {
  goods: Goods[];
  subscriptions: Subscription[];
  bills: Bill[];
  valueRecords: ValueRecord[];
  moods: Mood[];
  times: TimeRec[];
  wishlist: WishItem[];
  cooldowns: Cooldown[];
  categories: Category[];
  usageRecords: UsageRecord[];
  reminders: Reminder[];
  walls: Wall[];

  loaded: boolean;
  /** 距上次备份的变更条数 */
  changedSinceBackup: number;
  undoStack: UndoEntry[];

  /** 冷启动：一次性读全部集合。 */
  hydrateAll: () => Promise<void>;
  /** 整体替换（恢复备份用，立即落盘）。 */
  setAllCollections: (next: Partial<Record<CollectionName, unknown[]>>) => Promise<void>;
  /** 重置变更计数（备份成功后调用）。 */
  resetChanged: () => void;
  /** 撤销最近一次变更。 */
  undo: () => Promise<boolean>;

  /* —— 生活流 —— */
  addLedger: (draft: Partial<ValueRecord> & { amount: number }) => Promise<ValueRecord>;
  addLedgerMany: (drafts: Array<Partial<ValueRecord> & { amount: number }>) => Promise<ValueRecord[]>;
  updateLedger: (id: string, patch: Partial<ValueRecord>) => Promise<void>;
  removeLedger: (id: string) => Promise<void>;

  /* —— 物品 —— */
  addGoods: (draft: Partial<Goods> & { name: string; price: number }) => Promise<Goods>;
  updateGoods: (id: string, patch: Partial<Goods>) => Promise<void>;
  removeGoods: (id: string) => Promise<void>;
  /** 「+1」：使用次数 +1，并写一条使用打卡。 */
  useGoodsOnce: (id: string) => Promise<void>;
  /** 退役（可填转卖价）。 */
  retireGoods: (id: string, sellPrice?: number) => Promise<void>;

  /* —— 订阅 —— */
  addSubscription: (draft: Partial<Subscription> & { name: string; amount: number }) => Promise<Subscription>;
  updateSubscription: (id: string, patch: Partial<Subscription>) => Promise<void>;
  removeSubscription: (id: string) => Promise<void>;
  /** 新增扣款流水。 */
  addBill: (draft: Partial<Bill> & { subId: string; amount: number }) => Promise<Bill>;
  /** 标记已扣款。 */
  markBillPaid: (id: string, paidDate?: string, refund?: number) => Promise<void>;
  /** v1.0.21 账单四态迁移：skipped/failed/pending（paid 走 markBillPaid）。 */
  setBillStatus: (id: string, status: Bill['status']) => Promise<void>;
  /** v1.0.21 退款：paid 账单记退款金额（部分/全额）。 */
  refundBill: (id: string, refund: number) => Promise<void>;

  /* —— 其它集合 —— */
  addMood: (draft: Partial<Mood> & { feeling: string; text: string }) => Promise<Mood>;
  addTime: (draft: Partial<TimeRec> & { durationMin: number }) => Promise<TimeRec>;
  addWish: (draft: Partial<WishItem> & { name: string }) => Promise<WishItem>;
  addCooldown: (draft: Partial<Cooldown> & { name: string; until: string }) => Promise<Cooldown>;
  addWall: (draft: Partial<Wall> & { text: string }) => Promise<Wall>;
  addReminder: (draft: Partial<Reminder> & { kind: Reminder['kind']; refId: string; at: string }) => Promise<Reminder>;
  /** 通用删除（按集合名 + id）。 */
  removeById: (collection: CollectionName, id: string) => Promise<void>;

  /* —— 分类 —— */
  addCategory: (draft: Partial<Category> & { name: string; kind: Category['kind'] }) => Promise<Category>;
  updateCategory: (id: string, patch: Partial<Category>) => Promise<void>;
  removeCategory: (id: string) => Promise<void>;
}

/** 读当前货币（默认 CNY）。 */
function defaultCurrency(): string {
  return useSettingsStore.getState().settings?.currency || 'CNY';
}

export const useDataStore = create<DataState>()((set, get) => {
  /** 推入撤销栈。 */
  const pushUndo = (label: string, collection: CollectionName, rows: unknown[]): void => {
    const entry: UndoEntry = { label, collection, rows, at: nowISO() };
    set((s) => ({ undoStack: [...s.undoStack, entry].slice(-UNDO_LIMIT) }));
  };

  /** 变更计数 +1。 */
  const bumpChanged = (n = 1): void => {
    set((s) => ({ changedSinceBackup: s.changedSinceBackup + n }));
  };

  /** 更新内存 + 落盘。 */
  const commit = async (
    collection: CollectionName,
    rows: unknown[],
    opts: { label?: string; prev?: unknown[]; bump?: boolean } = {},
  ): Promise<void> => {
    if (opts.label && opts.prev) pushUndo(opts.label, collection, opts.prev);
    set({ [collection]: rows } as unknown as Partial<DataState>);
    await saveCollection(collection, rows);
    if (opts.bump !== false) bumpChanged();
  };

  return {
    goods: [],
    subscriptions: [],
    bills: [],
    valueRecords: [],
    moods: [],
    times: [],
    wishlist: [],
    cooldowns: [],
    categories: [],
    usageRecords: [],
    reminders: [],
    walls: [],

    loaded: false,
    changedSinceBackup: 0,
    undoStack: [],

    hydrateAll: async () => {
      const all = await loadAllCollections();
      set({ ...(all as unknown as Partial<DataState>), loaded: true });
    },

    setAllCollections: async (next) => {
      const patch: Partial<DataState> = {};
      for (const name of COLLECTIONS) {
        const rows = next[name];
        if (Array.isArray(rows)) (patch as Record<string, unknown>)[name] = rows;
      }
      set({ ...patch, undoStack: [], changedSinceBackup: 0 } as unknown as Partial<DataState>);
      await saveAllCollections(next);
    },

    resetChanged: () => set({ changedSinceBackup: 0 }),

    undo: async () => {
      const stack = get().undoStack;
      const entry = stack[stack.length - 1];
      if (!entry) return false;
      set({ undoStack: stack.slice(0, -1) });
      set({ [entry.collection]: entry.rows } as unknown as Partial<DataState>);
      await saveCollectionNow(entry.collection, entry.rows);
      return true;
    },

    /* —— 生活流 —— */
    addLedger: async (draft) => {
      const row: ValueRecord = {
        id: newId(),
        type: draft.type ?? 'expense',
        amount: draft.amount ?? 0,
        currency: draft.currency ?? defaultCurrency(),
        date: draft.date ?? today(),
        categoryId: draft.categoryId ?? 'cl7',
        judgement: draft.judgement ?? (draft.type === 'income' ? 'gui' : 'xu'),
        note: draft.note,
        createdAt: nowISO(),
      };
      const prev = get().valueRecords;
      await commit('valueRecords', [row, ...prev], { label: '新增一笔', prev });
      return row;
    },

    addLedgerMany: async (drafts) => {
      const rows: ValueRecord[] = drafts.map((draft) => ({
        id: newId(),
        type: draft.type ?? 'expense',
        amount: draft.amount ?? 0,
        currency: draft.currency ?? defaultCurrency(),
        date: draft.date ?? today(),
        categoryId: draft.categoryId ?? 'cl7',
        judgement: draft.judgement ?? (draft.type === 'income' ? 'gui' : 'xu'),
        note: draft.note,
        createdAt: nowISO(),
      }));
      const prev = get().valueRecords;
      await commit('valueRecords', [...rows, ...prev], {
        label: `新增 ${rows.length} 笔`,
        prev,
      });
      return rows;
    },

    updateLedger: async (id, patch) => {
      const prev = get().valueRecords;
      const rows = prev.map((r) => (r.id === id ? { ...r, ...patch, id: r.id } : r));
      await commit('valueRecords', rows, { label: '修改一笔', prev });
    },

    removeLedger: async (id) => {
      const prev = get().valueRecords;
      await commit('valueRecords', prev.filter((r) => r.id !== id), { label: '删除一笔', prev });
    },

    /* —— 物品 —— */
    addGoods: async (draft) => {
      const ts = nowISO();
      const row: Goods = {
        id: newId(),
        name: draft.name,
        categoryId: draft.categoryId ?? 'cg0',
        tags: draft.tags ?? [],
        price: draft.price ?? 0,
        currency: draft.currency ?? defaultCurrency(),
        buyDate: draft.buyDate ?? today(),
        status: draft.status ?? 'active',
        image: draft.image,
        note: draft.note,
        extraFees: draft.extraFees ?? [],
        incomes: draft.incomes ?? [],
        sellPrice: draft.sellPrice,
        targetDailyCost: draft.targetDailyCost,
        countEnabled: draft.countEnabled ?? false,
        totalCount: draft.totalCount,
        usedCount: draft.usedCount ?? 0,
        warrantyDate: draft.warrantyDate,
        warrantyRemind: draft.warrantyRemind,
        createdAt: ts,
        updatedAt: ts,
      };
      const prev = get().goods;
      await commit('goods', [row, ...prev], { label: '新增物品', prev });
      return row;
    },

    updateGoods: async (id, patch) => {
      const prev = get().goods;
      const rows = prev.map((g) => (g.id === id ? { ...g, ...patch, id: g.id, updatedAt: nowISO() } : g));
      await commit('goods', rows, { label: '修改物品', prev });
    },

    removeGoods: async (id) => {
      const prev = get().goods;
      await commit('goods', prev.filter((g) => g.id !== id), { label: '删除物品', prev });
    },

    useGoodsOnce: async (id) => {
      const prev = get().goods;
      const rows = prev.map((g) =>
        g.id === id
          ? { ...g, usedCount: (g.usedCount ?? 0) + 1, countEnabled: true, updatedAt: nowISO() }
          : g,
      );
      await commit('goods', rows, { label: '使用 +1', prev });
      const usage: UsageRecord = { id: newId(), goodsId: id, date: today(), createdAt: nowISO() };
      const prevUsage = get().usageRecords;
      await commit('usageRecords', [usage, ...prevUsage], { bump: false });
    },

    retireGoods: async (id, sellPrice) => {
      const prev = get().goods;
      const rows = prev.map((g) =>
        g.id === id
          ? { ...g, status: 'retired' as const, sellPrice: sellPrice ?? g.sellPrice, updatedAt: nowISO() }
          : g,
      );
      await commit('goods', rows, { label: '退役物品', prev });
    },

    /* —— 订阅 —— */
    addSubscription: async (draft) => {
      const ts = nowISO();
      const start = draft.startDate ?? today();
      const row: Subscription = {
        id: newId(),
        name: draft.name,
        categoryId: draft.categoryId ?? 'cs0',
        icon: draft.icon ?? 'tv',
        currency: draft.currency ?? defaultCurrency(),
        type: draft.type ?? 'recurring',
        period: draft.period ?? 'month',
        every: draft.every ?? 1,
        amount: draft.amount ?? 0,
        startDate: start,
        nextRenewDate: draft.nextRenewDate ?? start,
        autoRenew: draft.autoRenew ?? true,
        initSpent: draft.initSpent,
        status: 'active',
        remind: draft.remind ?? { renewLead: 3 },
        createdAt: ts,
        updatedAt: ts,
      };
      const prev = get().subscriptions;
      await commit('subscriptions', [row, ...prev], { label: '新增订阅', prev });
      return row;
    },

    updateSubscription: async (id, patch) => {
      const prev = get().subscriptions;
      const rows = prev.map((s) => (s.id === id ? { ...s, ...patch, id: s.id, updatedAt: nowISO() } : s));
      await commit('subscriptions', rows, { label: '修改订阅', prev });
    },

    removeSubscription: async (id) => {
      const prev = get().subscriptions;
      await commit('subscriptions', prev.filter((s) => s.id !== id), { label: '删除订阅', prev });
      const bills = get().bills;
      await commit('bills', bills.filter((b) => b.subId !== id), { bump: false });
    },

    addBill: async (draft) => {
      const row: Bill = {
        id: newId(),
        subId: draft.subId,
        dueDate: draft.dueDate ?? today(),
        amount: draft.amount ?? 0,
        currency: draft.currency ?? defaultCurrency(),
        status: draft.status ?? 'pending',
        paidDate: draft.paidDate,
        refund: draft.refund,
        createdAt: nowISO(),
      };
      const prev = get().bills;
      await commit('bills', [row, ...prev], { label: '新增账单', prev });
      return row;
    },

    markBillPaid: async (id, paidDate, refund) => {
      const prev = get().bills;
      const rows = prev.map((b) =>
        b.id === id ? { ...b, status: 'paid' as const, paidDate: paidDate ?? today(), refund: refund ?? b.refund } : b,
      );
      await commit('bills', rows, { label: '标记已扣款', prev });
    },

    setBillStatus: async (id, status) => {
      const prev = get().bills;
      const rows = prev.map((b) =>
        b.id === id
          ? {
              ...b,
              status,
              // 非 paid 状态清掉实付日与退款（补记/撤销时重置）
              paidDate: status === 'paid' ? b.paidDate ?? today() : undefined,
              refund: status === 'paid' ? b.refund : undefined,
            }
          : b,
      );
      await commit('bills', rows, { label: '更新账单状态', prev });
    },

    refundBill: async (id, refund) => {
      const prev = get().bills;
      const rows = prev.map((b) => (b.id === id ? { ...b, refund: Math.max(0, round(refund)) } : b));
      await commit('bills', rows, { label: '登记退款', prev });
    },

    /* —— 其它集合 —— */
    addMood: async (draft) => {
      const row: Mood = {
        id: newId(),
        feeling: draft.feeling,
        text: draft.text,
        crushed: draft.crushed ?? false,
        inHeart: draft.inHeart ?? false,
        date: draft.date ?? today(),
        createdAt: nowISO(),
      };
      const prev = get().moods;
      await commit('moods', [row, ...prev], { label: '记录情绪', prev });
      return row;
    },

    addTime: async (draft) => {
      const row: TimeRec = {
        id: newId(),
        durationMin: draft.durationMin ?? 0,
        tags: draft.tags ?? [],
        meaning: draft.meaning ?? 'xu',
        date: draft.date ?? today(),
        note: draft.note,
        createdAt: nowISO(),
      };
      const prev = get().times;
      await commit('times', [row, ...prev], { label: '记录时间', prev });
      return row;
    },

    addWish: async (draft) => {
      const row: WishItem = {
        id: newId(),
        name: draft.name,
        price: draft.price,
        url: draft.url,
        note: draft.note,
        image: draft.image,
        reasons: draft.reasons,
        channel: draft.channel,
        createdAt: nowISO(),
      };
      const prev = get().wishlist;
      await commit('wishlist', [row, ...prev], { label: '加入心愿单', prev });
      return row;
    },

    addCooldown: async (draft) => {
      const row: Cooldown = {
        id: newId(),
        name: draft.name,
        until: draft.until,
        hours: draft.hours,
        untilAt: draft.untilAt,
        amount: draft.amount,
        reason: draft.reason,
        url: draft.url,
        image: draft.image,
        createdAt: nowISO(),
      };
      const prev = get().cooldowns;
      await commit('cooldowns', [row, ...prev], { label: '加入冷却期', prev });
      return row;
    },

    addWall: async (draft) => {
      const row: Wall = { id: newId(), text: draft.text, color: draft.color, createdAt: nowISO() };
      const prev = get().walls;
      await commit('walls', [row, ...prev], { label: '贴一句话', prev });
      return row;
    },

    addReminder: async (draft) => {
      const row: Reminder = {
        id: newId(),
        kind: draft.kind,
        refId: draft.refId,
        at: draft.at,
        done: draft.done ?? false,
        createdAt: nowISO(),
      };
      const prev = get().reminders;
      await commit('reminders', [row, ...prev], { label: '新增提醒', prev });
      return row;
    },

    removeById: async (collection, id) => {
      const rows = get()[collection] as unknown as Array<{ id: string }>;
      const next = (rows ?? []).filter((r) => r?.id !== id);
      await commit(collection, next, { label: '删除', prev: rows as unknown as unknown[] });
    },

    /* —— 分类 —— */
    addCategory: async (draft) => {
      const list = get().categories;
      const row: Category = {
        id: newId(),
        name: draft.name,
        icon: draft.icon ?? 'tag',
        kind: draft.kind,
        order: draft.order ?? list.length,
      };
      const prev = list;
      await commit('categories', [...prev, row], { label: '新增分类', prev });
      return row;
    },

    updateCategory: async (id, patch) => {
      const prev = get().categories;
      const rows = prev.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c));
      await commit('categories', rows, { label: '修改分类', prev });
    },

    removeCategory: async (id) => {
      const prev = get().categories;
      await commit('categories', prev.filter((c) => c.id !== id), { label: '删除分类', prev });
    },
  };
});

/** 取某个集合的当前内存数据（非 hook，供 domain 层与页面调用）。 */
export function collectionOf<K extends CollectionName>(name: K): unknown[] {
  return (useDataStore.getState()[name] as unknown as unknown[]) ?? [];
}
