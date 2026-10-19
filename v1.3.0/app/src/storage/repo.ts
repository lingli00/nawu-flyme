import { newId } from '../lib/id';
import logger from '../lib/log';
import { COLLECTIONS, type CollectionName, type CollectionTypeMap } from '../types/entities';
import { enqueueWrite, getKV, setKV } from './kv';
import { collectionKey } from './keys';

/**
 * 12 个本地集合的仓库。
 *
 * 写策略：内存立即更新 + **debounce 300ms 落盘**（`saveCollection` 返回的 Promise
 * 在真正写盘后才 resolve，因此 `await saveCollection(...)` 即视作已持久化）。
 *
 * ★v1.0.29 两处致命修正（「有概率入库失败」根因）：
 * 1. 旧实现 `void flushOne(name)`：一旦 setKV 抛错（原生写队列被打爆时很常见），
 *    Promise 变成 unhandled rejection，**等待它的 resolvers 永远不被调用** ——
 *    `await addGoods()` 就此永久挂起，界面无提示、弹层不关、数据看着「没存上」。
 *    → 现在落盘带 3 次重试，并且无论如何都会 resolve（写失败另有错误回调上报）。
 * 2. 所有写统一走 kv 的串行链（一次一个），不再与图标缓存抢同一份 XML 文件。
 */

/** 落盘 debounce（ms）。 */
export const WRITE_DEBOUNCE_MS = 300;

interface PendingWrite {
  timer: ReturnType<typeof setTimeout>;
  resolvers: Array<() => void>;
}

const pending = new Map<CollectionName, PendingWrite>();
const latest = new Map<CollectionName, unknown[]>();

/** 落盘失败回调 hook（由 App 启动装配成 toast）。 */
let writeErrorHook: ((name: CollectionName, e: unknown) => void) | null = null;
export function onRepoWriteError(fn: (name: CollectionName, e: unknown) => void): void {
  writeErrorHook = fn;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 真正落盘：串行 + 重试 3 次；失败只上报，**不向上抛**
 * （内存态已更新，抛出去只会让调用方永久卡住，用户体验更差）。
 */
async function persist(name: CollectionName, rows: unknown[]): Promise<void> {
  await enqueueWrite(async () => {
    let lastErr: unknown = null;
    for (let i = 0; i < 3; i++) {
      try {
        await setKV(collectionKey(name), rows);
        return;
      } catch (e) {
        lastErr = e;
        await delay(120 * (i + 1));
      }
    }
    logger.error('repo', `落盘失败：${name}`, lastErr);
    try {
      writeErrorHook?.(name, lastErr);
    } catch {
      /* hook 自身异常不能影响主流程 */
    }
  });
}

/** 真正写盘（内部用）：无论如何都会释放等待者。 */
async function flushOne(name: CollectionName): Promise<void> {
  const rec = pending.get(name);
  pending.delete(name);
  const rows = latest.get(name);
  latest.delete(name);
  try {
    if (rows !== undefined) await persist(name, rows);
  } catch {
    /* persist 已内部兜底 */
  } finally {
    rec?.resolvers.forEach((r) => r());
  }
}

/**
 * 写入集合（debounce 300ms）。
 * @returns 在真正落盘后 resolve 的 Promise
 */
export function saveCollection<T>(name: CollectionName, rows: T[]): Promise<void> {
  latest.set(name, rows as unknown[]);
  const existing = pending.get(name);
  if (existing) clearTimeout(existing.timer);

  return new Promise<void>((resolve) => {
    const resolvers = existing ? existing.resolvers : [];
    resolvers.push(resolve);
    const timer = setTimeout(() => {
      void flushOne(name);
    }, WRITE_DEBOUNCE_MS);
    pending.set(name, { timer, resolvers });
  });
}

/** 立即写入（跳过 debounce，冷启动/恢复备份等关键路径用）。失败同样不向上抛。 */
export async function saveCollectionNow<T>(name: CollectionName, rows: T[]): Promise<void> {
  const existing = pending.get(name);
  if (existing) {
    clearTimeout(existing.timer);
    pending.delete(name);
  }
  latest.delete(name);
  try {
    await persist(name, rows as unknown[]);
  } catch {
    /* 已兜底 */
  }
  existing?.resolvers.forEach((r) => r());
}

/** 把挂起的写入全部落盘（App 切后台 / 退出前调用）。 */
export async function flushAll(): Promise<void> {
  const names = [...pending.keys()];
  for (const name of names) await flushOne(name);
}

/** 读取集合（缺失/损坏返回空数组）。 */
export async function loadCollection<T>(name: CollectionName): Promise<T[]> {
  const rows = await getKV<T[]>(collectionKey(name), null);
  if (!Array.isArray(rows)) return [];
  return rows;
}

/** 一次性读取全部 12 个集合（冷启动并发读）。 */
export async function loadAllCollections(): Promise<{
  [K in CollectionName]: CollectionTypeMap[K][];
}> {
  const entries = await Promise.all(
    COLLECTIONS.map(async (name) => [name, await loadCollection(name)] as const),
  );
  const out = {} as { [K in CollectionName]: CollectionTypeMap[K][] };
  for (const [name, rows] of entries) {
    (out as Record<string, unknown[]>)[name] = rows;
  }
  return out;
}

/** 一次性写入全部 12 个集合（恢复备份用）。 */
export async function saveAllCollections(
  data: Partial<{ [K in CollectionName]: unknown[] }>,
): Promise<void> {
  await Promise.all(
    COLLECTIONS.map((name) => {
      const rows = data[name];
      return rows ? saveCollectionNow(name, rows) : Promise.resolve();
    }),
  );
}

/* ----------------------------------------------------------------------------
 * 泛型 CRUD（纯函数式：读 → 改 → 写）
 * --------------------------------------------------------------------------*/

/** 集合 CRUD 接口。 */
export interface Crud<T extends { id: string }> {
  list(): Promise<T[]>;
  findById(id: string): Promise<T | undefined>;
  insert(row: T | Omit<T, 'id'>): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<T | undefined>;
  remove(id: string): Promise<void>;
  replaceAll(rows: T[]): Promise<void>;
}

/**
 * 取得某个集合的 CRUD 句柄。
 *
 * @example
 * const goods = crud<Goods>('goods');
 * await goods.insert({ name: '跑鞋', price: 899 } as Goods);
 */
export function crud<T extends { id: string }>(name: CollectionName): Crud<T> {
  return {
    async list(): Promise<T[]> {
      return loadCollection<T>(name);
    },
    async findById(id: string): Promise<T | undefined> {
      const rows = await loadCollection<T>(name);
      return rows.find((r) => r?.id === id);
    },
    async insert(row: T | Omit<T, 'id'>): Promise<T> {
      const rows = await loadCollection<T>(name);
      const full = (row as T).id ? (row as T) : ({ ...(row as object), id: newId() } as T);
      const next = [full, ...rows];
      await saveCollection(name, next);
      return full;
    },
    async update(id: string, patch: Partial<T>): Promise<T | undefined> {
      const rows = await loadCollection<T>(name);
      let updated: T | undefined;
      const next = rows.map((r) => {
        if (r?.id !== id) return r;
        updated = { ...r, ...patch } as T;
        return updated;
      });
      if (!updated) return undefined;
      await saveCollection(name, next);
      return updated;
    },
    async remove(id: string): Promise<void> {
      const rows = await loadCollection<T>(name);
      const next = rows.filter((r) => r?.id !== id);
      await saveCollection(name, next);
    },
    async replaceAll(rows: T[]): Promise<void> {
      await saveCollectionNow(name, rows);
    },
  };
}

/** 调试用：打印各集合条数。 */
export async function debugCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of COLLECTIONS) {
    out[name] = (await loadCollection(name)).length;
    logger.debug('repo', `${name}: ${out[name]}`);
  }
  return out;
}
