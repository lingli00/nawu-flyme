import { isNative } from '../net/env';
import logger from '../lib/log';

/**
 * KV 持久化：Preferences（原生） → localStorage（Web） → 内存（兜底，测试用）。
 *
 * 说明：Android 侧底层是 `SharedPreferences`，**一个集合一个 key**，
 * 避免单条 value 过大（>1MB 会明显变慢）。
 */

interface KvDriver {
  name: 'preferences' | 'localStorage' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** 内存兜底驱动（Node 测试 / 无 Storage 环境）。 */
function createMemoryDriver(): KvDriver {
  const map = new Map<string, string>();
  return {
    name: 'memory',
    async get(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

/** localStorage 驱动（浏览器）。 */
function createLocalStorageDriver(store: Storage): KvDriver {
  /** 配额不足时自救：丢掉图标缓存（localStorage 里最大的一块），保住业务数据。 */
  const evictIconCache = (): void => {
    const kill: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k) continue;
      // 图标缓存条目 + 索引（新旧两代前缀都清）
      if (k.startsWith('gf.icon.c.') || k.startsWith('gf.icon.cache.') || k.startsWith('flyme.icon.')) kill.push(k);
    }
    for (const k of kill) {
      try {
        store.removeItem(k);
      } catch {
        /* 尽力而为 */
      }
    }
  };

  return {
    name: 'localStorage',
    async get(key) {
      return store.getItem(key);
    },
    async set(key, value) {
      try {
        store.setItem(key, value);
      } catch (e) {
        // ★v1.0.29「手机浏览提示本地保存失败」：localStorage 只给 ~5MB，
        // 图标缓存（单条最大 400KB × 500 条）一满，后续**所有**写入（含业务数据）
        // 全部 QuotaExceeded —— 表现为满屏保存失败。这里清掉图标缓存重试一次。
        const quota = e instanceof Error && /quota/i.test(e.name + e.message);
        if (!quota) throw e;
        evictIconCache();
        store.setItem(key, value);
      }
    },
    async remove(key) {
      store.removeItem(key);
    },
  };
}

/** Preferences 驱动（Capacitor 原生）。 */
function createPreferencesDriver(prefs: {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
}): KvDriver {
  return {
    name: 'preferences',
    async get(key) {
      const r = await prefs.get({ key });
      return r?.value ?? null;
    },
    async set(key, value) {
      await prefs.set({ key, value });
    },
    async remove(key) {
      await prefs.remove({ key });
    },
  };
}

let cachedDriver: KvDriver | null = null;

/** 解析当前可用驱动（结果缓存，避免每次都动态 import）。 */
export async function resolveDriver(): Promise<KvDriver> {
  if (cachedDriver) return cachedDriver;

  if (isNative()) {
    try {
      const mod = await import('@capacitor/preferences');
      cachedDriver = createPreferencesDriver(mod.Preferences as never);
      return cachedDriver;
    } catch (e) {
      logger.warn('kv', 'Preferences 不可用，回落 localStorage', e);
    }
  }

  const store = typeof globalThis !== 'undefined' ? (globalThis as { localStorage?: Storage }).localStorage : undefined;
  if (store) {
    cachedDriver = createLocalStorageDriver(store);
    return cachedDriver;
  }

  cachedDriver = createMemoryDriver();
  return cachedDriver;
}

/** 强制重设驱动（测试用）。 */
export function setDriver(driver: KvDriver | null): void {
  cachedDriver = driver;
}

/**
 * 读取并反序列化。
 * @param fallback 读取失败或缺失时的返回值
 */
export async function getKV<T>(key: string, fallback: T | null = null): Promise<T | null> {
  try {
    const driver = await resolveDriver();
    const raw = await driver.get(key);
    if (raw === null || raw === undefined || raw === '') return fallback;
    return JSON.parse(raw) as T;
  } catch (e) {
    logger.warn('kv', `读取失败：${key}`, e);
    return fallback;
  }
}

/** 写入（序列化为 JSON）。 */
export async function setKV<T>(key: string, value: T): Promise<void> {
  try {
    const driver = await resolveDriver();
    await driver.set(key, JSON.stringify(value));
  } catch (e) {
    logger.error('kv', `写入失败：${key}`, e);
    throw e;
  }
}

/** 删除。 */
export async function removeKV(key: string): Promise<void> {
  try {
    const driver = await resolveDriver();
    await driver.remove(key);
  } catch (e) {
    logger.warn('kv', `删除失败：${key}`, e);
  }
}

/**
 * 全局写串行链（v1.0.29 · 「卡死 / 偶发入库失败」根治）。
 *
 * Android 的 Preferences 底层是**单个 XML 文件**，每次 set 都是全量重写；
 * 图标缓存（可能上百条）+ 业务集合同时并发写时，原生侧排队超时/失败，
 * 表现为界面白屏卡顿，甚至业务写入丢失。
 * 铁律：所有落盘写一律排进这条链，一次只走一个。
 */
let writeChain: Promise<unknown> = Promise.resolve();

/** 排队执行一个写任务（前一个失败不影响后一个）。 */
export function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const p = writeChain.then(task, task);
  writeChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/** 存在（值非 null 即视为存在）。 */
export async function hasKV(key: string): Promise<boolean> {
  const driver = await resolveDriver();
  return (await driver.get(key)) !== null;
}

/** 读取原始字符串（调试/导出用）。 */
export async function getRawKV(key: string): Promise<string | null> {
  const driver = await resolveDriver();
  return driver.get(key);
}
