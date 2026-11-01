import { enqueueWrite, getKV, removeKV, setKV } from '../storage/kv';
import { isNative } from '../net/env';
import { currentServer } from '../store/useServerStore';
import logger from './log';

/**
 * 图标本地缓存层（v1.0.15 · 「设置过一次，终身离线可用」）。
 *
 * 背景（用户实测两轮录屏定位）：
 * - App WebView(https://localhost 源) 直连 http 服务器的 <img> 加载极慢/不稳定，
 *   退出重进后 WebView 内存缓存清空 → 破图重来；
 * - 恢复备份后图标要重新走网络慢慢「缓存出来」，网络差时永远显示不出来。
 *
 * 方案（铁律）：所有网络图标的**字节**一律经统一网络层（真机 CapacitorHttp 原生通道，
 * 浏览器 fetch 同源路径）抓取 → 转 dataURL → 持久化 KV（真机 Preferences）。
 * 界面渲染只吃缓存 dataURL，不再依赖 WebView 网络栈；备份快照随身携带
 * 全部图标数据（buildSnapshot icons 字段），恢复后无需再联网找图。
 *
 * 缓存键：相对路径优先（/api/icon/img?d=…、/api/icon/proxy?u=…），
 * 与服务器域名解耦 —— 换服务器 / 跨设备恢复都能命中。
 */

/** KV 键：LRU 索引。 */
const INDEX_KEY = 'gf.icon.cache.index';
/** KV 键前缀：单图标条目（一个图标一个 key，避免单条 value 过大拖慢 Preferences）。 */
const ENTRY_PREFIX = 'gf.icon.c.';

/**
 * LRU 容量上限（条）。
 * ★v1.0.29：浏览器端 localStorage 只给 ~5MB，500 条很容易把配额吃光，
 * 导致后续业务写入 QuotaExceeded（「本地保存失败」）—— Web 上限砍到 120 条；
 * 原生 Preferences 没有这种硬配额，维持 500。
 */
const MAX_ENTRIES = isNative() ? 500 : 120;
/** 单条 dataURL 体积上限（约 300KB，超过不入缓存）。 */
const MAX_ENTRY_CHARS = 400_000;

/** LRU 索引结构（新 → 旧）。 */
interface IconIndex {
  keys: string[];
}

/* ------------------------------------------------------------------ */
/* 键归一化                                                            */
/* ------------------------------------------------------------------ */

/**
 * 图标 src → 缓存键。
 * 同服务器绝对 URL 一律剥掉 origin 存相对路径；外链保留完整 URL。
 */
export function normIconKey(src: string, base?: string): string {
  const u = (src ?? '').trim();
  if (!u) return '';
  // App 内页面源是 https://localhost，相对路径可能被误拼到 localhost —— 一并剥掉
  const LOCALHOST = /^https?:\/\/localhost(?::\d+)?/i;
  const b = (base ?? currentServer()?.url ?? '').replace(/\/+$/, '');
  if (b && u.toLowerCase().startsWith(b.toLowerCase())) {
    return u.slice(b.length) || '/';
  }
  if (LOCALHOST.test(u)) {
    return u.replace(LOCALHOST, '') || '/';
  }
  return u;
}

/* ------------------------------------------------------------------ */
/* 全局抓取并发闸（v1.0.29 · 卡死根治）                                 */
/*                                                                     */
/* 品牌图片页一次挂载上百个 favicon（订阅模式品牌 tab 甚至是全量同步     */
/* 渲染），每个未命中都会走 CapacitorHttp 抓取 + Preferences 写入。      */
/* Android 侧 SharedPreferences 是**单 XML 文件**，每次 set 全量重写——  */
/* 无闸门时几十上百个并发抓取 + 写入会把主线程 / bridge 队列打爆         */
/* （实测白屏卡死 15s+），业务数据的写入也被挤到队尾（「入库不了」）。   */
/* 全局并发上限 4：可视图标优先在队头，大图抓取最多等一小会儿。          */
/* ------------------------------------------------------------------ */

const FETCH_CONCURRENCY = 4;
/** 单次抓取超时（ms）。超时即释放槽位，绝不无限占坑。 */
const FETCH_TIMEOUT_MS = 10_000;
let fetchActive = 0;
const fetchWaiters: Array<() => void> = [];

/** 排队执行一个抓取任务（FIFO 放行，退出即让位）。 */
async function withFetchSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (fetchActive >= FETCH_CONCURRENCY) {
    await new Promise<void>((release) => fetchWaiters.push(release));
  }
  fetchActive++;
  try {
    return await fn();
  } finally {
    fetchActive--;
    fetchWaiters.shift()?.();
  }
}

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

/**
 * 内存 LRU 索引（v1.0.29）：启动懒加载一次，之后写入只改内存、
 * 防抖批量写回。旧实现每写一个图标就读+写两遍索引 KV——并发下
 * 读-改-写互相覆盖（丢键），且索引高频全量重写加剧写风暴。
 */
let memIndex: string[] | null = null;
let indexDirty = false;
let indexTimer: ReturnType<typeof setTimeout> | null = null;

async function loadIndex(): Promise<string[]> {
  if (memIndex) return memIndex;
  const idx = await getKV<IconIndex>(INDEX_KEY);
  memIndex = Array.isArray(idx?.keys) ? idx.keys : [];
  return memIndex;
}

/**
 * 索引登记（LRU 头插；超容量的尾部条目连正文一起淘汰）。
 * ★索引与正文保持严格一致：`readEntry` 靠「索引里没有 = 从未缓存」跳过跨桥读，
 * 因此索引必须覆盖**所有**现存条目，否则旧图标会被判为未缓存（白重下一遍）。
 */
function indexTouch(nk: string): void {
  if (!memIndex) return;
  if (memIndex[0] !== nk) {
    const at = memIndex.indexOf(nk);
    if (at > 0) memIndex.splice(at, 1);
    memIndex.unshift(nk);
  }
  if (memIndex.length > MAX_ENTRIES) {
    for (const dead of memIndex.splice(MAX_ENTRIES)) {
      memo.delete(dead);
      writeQueue.delete(dead);
      void removeKV(ENTRY_PREFIX + dead).catch(() => undefined);
    }
  }
  scheduleIndexFlush();
}

/* ------------------------------------------------------------------ */
/* 读取备忘（v1.0.29 · 卡死根治）                                       */
/*                                                                     */
/* 品牌页一次挂载上百个 BrandImg，每个都会按候选链读 1~3 次 KV ——        */
/* 原生侧每次 get 都是一次跨桥调用，几百次叠加直接把主线程打满。         */
/* 这里做两级减免：① 内存备忘（命中不再跨桥）；② 用内存索引判存 ——     */
/* 索引里没有登记过的键，说明从未缓存过，直接跳过 KV 读。               */
/* ------------------------------------------------------------------ */
const MEMO_MAX = 400;
const memo = new Map<string, string>();

function memoPut(k: string, v: string): void {
  if (v.length > MAX_ENTRY_CHARS) return;
  if (memo.has(k)) memo.delete(k);
  memo.set(k, v);
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/** ★v1.0.33：坏图自愈——历史缓存里存过镜像站的灰色/字母占位图，
 *  命中即判为未命中并顺手清掉，避免「斜杠/空白」图标永远留在用户机器上。 */
function isBadIconData(v: string): boolean {
  if (!v.startsWith('data:image/svg')) return false;
  const head = v.slice(0, 600);
  if (/<text[\s>]/i.test(head)) return true; // 字母头像占位
  if (/Times New Roman/i.test(head)) return true;
  return false;
}

async function readEntry(nk: string, idx: string[]): Promise<string | null> {
  const cached = memo.get(nk);
  if (cached !== undefined) return cached;
  if (idx.length > 0 && !idx.includes(nk)) return null;
  const v = await getKV<string>(ENTRY_PREFIX + nk);
  if (v && v.startsWith('data:')) {
    if (isBadIconData(v)) {
      void removeKV(ENTRY_PREFIX + nk).catch(() => undefined);
      return null;
    }
    memoPut(nk, v);
    return v;
  }
  return null;
}

/**
 * 同步读备忘（v1.0.30 · 白屏根治）：内存 memo 命中则**同步**返回 dataURL。
 * 品牌页第二次打开时，上百个按钮不再各自「await 查缓存 → setState → 全表重渲染」
 * （低端机上就是几百次 setState 的渲染风暴 → 主线程卡死白屏）——
 * 命中的在首次 render 就拿到图，零异步零重渲染。
 */
export function iconCacheLookupSync(keys: string[]): string | null {
  for (const k of keys) {
    const nk = normIconKey(k);
    if (!nk) continue;
    const hit = memo.get(nk);
    if (hit !== undefined) return hit;
  }
  return null;
}

function scheduleIndexFlush(): void {
  indexDirty = true;
  if (indexTimer) return;
  indexTimer = setTimeout(() => {
    indexTimer = null;
    if (!indexDirty || !memIndex) return;
    indexDirty = false;
    void setKV(INDEX_KEY, { keys: memIndex.slice(0, MAX_ENTRIES) }).catch(() => {
      /* 写回失败静默：索引丢了可重建，条目才是数据 */
    });
  }, 800);
}

/** 内存索引立即落盘（备份导出前等需要确保一致性的场景）。 */
export async function flushIconIndex(): Promise<void> {
  if (!indexDirty || !memIndex) return;
  indexDirty = false;
  if (indexTimer) {
    clearTimeout(indexTimer);
    indexTimer = null;
  }
  await setKV(INDEX_KEY, { keys: memIndex.slice(0, MAX_ENTRIES) }).catch(() => {});
}

/** 排空写入队列（导出备份 / 退出前调用，确保新抓的图已落盘）。 */
export async function flushIconWrites(): Promise<void> {
  await drainWrites();
  await flushIconIndex();
}

/**
 * 「入库失败」根因防线（v1.0.29）：Android Preferences 是**单 XML 全量重写**，
 * 一次 `flush` 几百 KB~数 MB；品牌页滚动会瞬间排入上百次 set —— 这些写操作
 * 与 addGoods / addSubscription 的持久化挤在同一条原生队列里，业务写入被推后，
 * 用户「保存后立刻退出」就会看到记录丢失。
 * 对策：图标写一律进串行队列，一次只写一条、写完再取下一条（写节流），
 * 绝不与业务写入抢并发。
 */
const WRITE_DELAY = 400;
const writeQueue = new Map<string, string>();
let writing = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWriteFlush(): void {
  if (writing || writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void drainWrites();
  }, WRITE_DELAY);
}

async function drainWrites(): Promise<void> {
  if (writing) return;
  writing = true;
  try {
    while (writeQueue.size > 0) {
      const next = writeQueue.entries().next().value as [string, string] | undefined;
      if (!next) return;
      const [k, v] = next;
      writeQueue.delete(k);
      // 与业务数据共用同一条写串行链：两者都落在同一份 Preferences XML 上
      await enqueueWrite(() => setKV(ENTRY_PREFIX + k, v)).catch((e) => {
        logger.warn('iconCache', '写入失败', e);
      });
    }
  } finally {
    writing = false;
    if (writeQueue.size > 0) scheduleWriteFlush();
  }
}

/** 按候选键顺序查缓存，命中返回 dataURL。 */
export async function iconCacheLookup(keys: string[]): Promise<string | null> {
  const idx = await loadIndex();
  for (const k of keys) {
    const nk = normIconKey(k);
    if (!nk) continue;
    const hit = await readEntry(nk, idx);
    if (hit) return hit;
  }
  return null;
}

/**
 * 写入一条缓存并更新 LRU（索引走内存 + 防抖写回；正文走串行写队列）。
 * ★v1.0.29：本函数**立即返回**，不再把 UI 挂在几十次 Preferences 写之上。
 */
export async function iconCacheStore(src: string, dataUrl: string): Promise<void> {
  const nk = normIconKey(src);
  if (!nk || !dataUrl.startsWith('data:') || dataUrl.length > MAX_ENTRY_CHARS) return;
  memoPut(nk, dataUrl);
  await loadIndex();
  indexTouch(nk);
  writeQueue.set(nk, dataUrl);
  scheduleWriteFlush();
}

/* ------------------------------------------------------------------ */
/* 抓取（统一网络层，禁 WebView 直连）                                  */
/* ------------------------------------------------------------------ */

/**
 * 抓取一个图标 URL → dataURL（失败 null）。
 * ★maxBytes（v1.0.20）：默认 400KB（图标缓存条目上限）；商品图原图抓取显式传大值
 * （如 8MB）——魅族官网原图 500KB+ 曾被 400KB 硬上限拦截，报「图片抓取失败」。
 * 超过上限的抓取结果**不入缓存**（iconCacheStore 会自行拦截）。
 */
/**
 * 同一 URL 的重复抓取合并（v1.0.29）：列表滚动 / 预览与卡片同时挂载时
 * 同一个 src 会被请求多次，去重后只走一次网络。
 */
const inflight = new Map<string, Promise<string | null>>();

export function fetchIconAsDataUrl(src: string, maxBytes: number = MAX_ENTRY_CHARS): Promise<string | null> {
  const url = (src ?? '').trim();
  if (!url || (!/^https?:\/\//i.test(url) && !url.startsWith('/'))) return Promise.resolve(null);
  const ck = `${maxBytes}|${url}`;
  const dup = inflight.get(ck);
  if (dup) return dup;
  const p = withFetchSlot(() => fetchIconAsDataUrlInner(url, maxBytes));
  inflight.set(ck, p);
  void p.catch(() => undefined).then(() => inflight.delete(ck));
  return p;
}

async function fetchIconAsDataUrlInner(url: string, maxBytes: number): Promise<string | null> {

  if (isNative()) {
    try {
      const mod = await import('@capacitor/core');
      const res = await mod.CapacitorHttp.request({
        url,
        method: 'GET',
        responseType: 'arraybuffer',
        connectTimeout: 8000,
        readTimeout: 10000,
      });
      const status = Number(res.status ?? 0);
      if (status < 200 || status >= 300) return null;
      const b64 = typeof res.data === 'string' ? res.data : '';
      if (!b64 || b64.length > maxBytes) return null;
      const headers = (res.headers ?? {}) as Record<string, string | string[]>;
      const rawType = Array.isArray(headers['Content-Type'])
        ? headers['Content-Type'][0]
        : headers['Content-Type'] ?? headers['content-type'] ?? '';
      const type = /svg|image|icon/i.test(String(rawType)) ? String(rawType).split(';')[0] : 'image/png';
      return `data:${type};base64,${b64}`;
    } catch (e) {
      logger.debug('iconCache', '原生抓取失败', url, e);
      return null;
    }
  }

  // 浏览器：同源路径直接 fetch（服务端图标接口同源；带 CORS 的代理也行）
  // ★v1.0.30 必须带超时：图标代理偶发挂起（弱网/服务器排队），无超时会永久占住
  // 并发闸的 4 个槽位 —— 之后**所有**图标抓取无限排队，页面上一半按钮永远空白。
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const abs = url.startsWith('/') ? `${window.location.origin}${url}` : url;
    const res = await fetch(abs, { credentials: 'omit', ...(ctrl ? { signal: ctrl.signal } : {}) });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > maxBytes) return null;
    return await new Promise<string | null>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 按候选链抓取首个成功者并入库。
 * @returns 成功的 dataURL（同时已写入缓存），全败 null
 */
export async function iconCacheFetchAndStore(chain: string[], base?: string): Promise<string | null> {
  for (const src of chain) {
    const data = await fetchIconAsDataUrl(src);
    if (data) {
      await iconCacheStore(src, data);
      // 兜底：整条链的键都指向同一份图（查任意候选键都命中）
      for (const k of chain) {
        if (k !== src) await iconCacheStore(k, data);
      }
      void base;
      return data;
    }
  }
  return null;
}

/** 后台预热一批图标 src（搜索结果全量缓存用，失败静默）。
 *  ★v1.0.30 并行 + 去重：并发闸已限流 4，串行 await 反而让一次挂起堵死整条预热；
 *  同 URL 由 inflight 去重，重复调用无代价。 */
export async function warmIconCache(srcs: string[], base?: string): Promise<void> {
  void base;
  const list = [...new Set(srcs.map((s) => (s ?? '').trim()).filter(Boolean))].slice(0, 24);
  await Promise.all(
    list.map(async (src) => {
      if (await iconCacheLookup([src])) return;
      const data = await fetchIconAsDataUrl(src);
      if (data) await iconCacheStore(src, data);
    }),
  );
}

/* ------------------------------------------------------------------ */
/* 备份导出 / 恢复导入                                                  */
/* ------------------------------------------------------------------ */

/** 当前索引快照（导出用，先排空写队列保证完整性）。 */
async function readyIndex(): Promise<string[]> {
  await flushIconWrites();
  return loadIndex();
}

/** 导出全部图标缓存（备份快照 icons 字段）。 */
export async function iconCacheExport(): Promise<Record<string, string>> {
  const keys = await readyIndex();
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = memo.get(k) ?? (await getKV<string>(ENTRY_PREFIX + k));
    if (v && v.startsWith('data:') && v.length <= MAX_ENTRY_CHARS) out[k] = v;
  }
  return out;
}

/**
 * ★v1.0.19 备份瘦身：只导出**被数据实际引用**的缓存条目。
 * refKeys = collectUrlRefKeys() 的归一化键集合；不传则退化为全量导出。
 * 单条仍受 MAX_ENTRY_CHARS 限制——备份只带「在用的图标」，不再随身携带整个搜索缓存。
 */
export async function iconCacheExportReferenced(refKeys?: Set<string>): Promise<Record<string, string>> {
  if (!refKeys) return iconCacheExport();
  const keys = await readyIndex();
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (!refKeys.has(k)) continue;
    const v = memo.get(k) ?? (await getKV<string>(ENTRY_PREFIX + k));
    if (v && v.startsWith('data:') && v.length <= MAX_ENTRY_CHARS) out[k] = v;
  }
  return out;
}

/** 从备份合并导入图标缓存（不清空现有）。@returns 导入条数 */
export async function iconCacheImport(rec: unknown): Promise<number> {
  if (!rec || typeof rec !== 'object') return 0;
  const idx = await loadIndex();
  void idx;
  const entries = Object.entries(rec as Record<string, unknown>).filter(
    (e): e is [string, string] =>
      typeof e[0] === 'string' && !!e[0] && typeof e[1] === 'string' && e[1].startsWith('data:') && e[1].length <= MAX_ENTRY_CHARS,
  );
  if (entries.length === 0) return 0;
  const seen = new Set<string>();
  for (const [k, v] of entries.slice(0, MAX_ENTRIES)) {
    if (seen.has(k)) continue;
    seen.add(k);
    writeQueue.set(k, v);
    memoPut(k, v);
    indexTouch(k);
  }
  scheduleWriteFlush();
  void idx;
  return seen.size;
}
