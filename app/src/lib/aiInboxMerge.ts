import { COLLECTIONS, type CollectionName } from '../types/entities';
import { normalizeImageRef } from './goodsIcon';

/**
 * ★v1.6.6 · 把「云端待入账」事件合并进本机集合。
 *
 * 服务端事件 payload 支持四类操作（见 GF_Ai::mergeIntoPayload）：
 *   <集合名>: 行数组        按 id upsert（新记录放最前）
 *   patches: {集合: [{id,patch}]}  局部更新
 *   deletes: {集合: [id…]}   删除
 *   replace: {集合: 行数组}  整组替换
 *
 * 这里与服务端保持完全同口径，保证「云端快照」与「本机」结果一致。
 * 只返回发生变化的集合，交给 setAllCollections 做 patch，绝不整仓覆盖。
 *
 * ★v1.7.7 **schema 兜底（归一化层）**：AI API 直写数据库的数据经常缺字段 ——
 * 线上 19 条物品里 11 条没有 `extraFees` / `tags` / `incomes`，`image.ref`
 * 还是裸 base64（没有 `data:image/…` 前缀），打开详情就整树崩、图片也不显示。
 * 现在**合并进来的每一行**都先过一遍 normalizeRow：必填数组一律
 * `Array.isArray(x) ? x : []`，必填字符串/数字给默认值，`image` 统一成
 * `{source, ref}` 且 ref 补全 dataURL 前缀。无论 API 写进来什么，
 * 进前端 store 之前一定是合法形态（服务端修复见 NawuAI.php，这里是前端最后一道闸）。
 */
type Row = Record<string, unknown>;

export interface MergeEventLike {
  id: number;
  records: Record<string, unknown>;
}

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCollection = (name: string): name is CollectionName => (COLLECTIONS as readonly string[]).includes(name);
const rowId = (r: Row): string => (r.id === undefined || r.id === null ? '' : String(r.id));

/* ======================================================================
 * ★v1.7.7 归一化原语
 * ==================================================================== */

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asNumber = (v: unknown, fallback = 0): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
};

/** 字符串数组（去空串、去非字符串项）。 */
function asStringArray(v: unknown): string[] {
  return asArray<unknown>(v).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

/** 物品图片归一：对象 / 字符串 / undefined 三种入参都收敛成 `{source, ref}`（ref 补 dataURL 前缀）。
 *  ⚠️ 已知 source（含历史遗留的 `url` / `web` / `system`）一律保留原值 —— 归一化只做
 *  「补缺失 + 修 ref 格式」，不负责改语义，免得把老数据的含义洗掉。 */
function normalizeGoodsImage(v: unknown): { source: string; ref: string } | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') {
    const ref = normalizeImageRef(v);
    if (!ref) return undefined;
    if (ref.startsWith('brand:')) return { source: 'brand', ref };
    if (/^https?:\/\//i.test(ref) || ref.startsWith('url:')) return { source: 'web', ref };
    if (ref.startsWith('data:')) return { source: 'local', ref };
    return { source: 'builtin', ref };
  }
  if (!isRow(v)) return undefined;
  const rawRef = asString(v.ref).trim();
  if (!rawRef) return undefined;
  const ref = normalizeImageRef(rawRef);
  const knownSource = asString(v.source).trim();
  if (knownSource) return { source: knownSource, ref };
  if (ref.startsWith('brand:')) return { source: 'brand', ref };
  if (ref.startsWith('data:')) return { source: 'local', ref };
  if (/^https?:\/\//i.test(ref) || ref.startsWith('url:')) return { source: 'web', ref };
  return { source: 'builtin', ref };
}

/** 附加费用：`[{name, amount}]`（剔掉非对象 / 全空行）。 */
function normalizeFees(v: unknown): Array<{ name: string; amount: number }> {
  return asArray<unknown>(v)
    .filter(isRow)
    .map((f) => ({ name: asString(f.name), amount: asNumber(f.amount) }))
    .filter((f) => f.name !== '' || f.amount !== 0);
}

/* ======================================================================
 * ★v1.7.7 集合 → 行归一化
 * ==================================================================== */

/** 缺失判定（null / undefined / 空串）。 */
const missing = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** 物品：tags / extraFees / incomes 必填数组，status 默认 active，currency 默认 CNY，image 归一。
 *  ⚠️ 只补「缺失 or 类型非法」的字段，原本合法的值一律原样保留（归一化不是改写）。 */
function normalizeGoods(r: Row): Row {
  const image = normalizeGoodsImage(r.image);
  const out: Row = { ...r };
  // 合法字符串数组原样保留（含去重/trim 都不做），只在类型非法时补齐
  if (!Array.isArray(r.tags)) out.tags = [];
  out.extraFees = Array.isArray(r.extraFees) ? r.extraFees.filter(isRow) : [];
  out.incomes = Array.isArray(r.incomes) ? r.incomes.filter(isRow) : [];
  if (missing(out.status)) out.status = 'active';
  if (missing(out.currency)) out.currency = 'CNY';
  if (missing(out.price)) out.price = 0;
  if (image) out.image = image;
  else delete out.image;
  return out;
}

/** 生活流：type / date / amount / currency / judgement 兜底（缺 date 用今天，绝不给 undefined）。
 *  ⚠️ 只补「缺失 + 类型非法」的字段：局部更新（patch）里没带的字段由外层
 *  `{...旧行, ...patch}` 保留原值，这里若把无值强行写成 0/今天，就会把原有数据冲掉。 */
function normalizeValueRecord(r: Row): Row {
  const out: Row = { ...r };
  if (out.type !== 'income' && out.type !== 'expense') out.type = 'expense';
  if (r.judgement !== 'gui' && r.judgement !== 'xu' && r.judgement !== 'fou') out.judgement = 'xu';
  if (missing(out.currency)) out.currency = 'CNY';
  if (missing(out.date)) out.date = todayISO();
  if (missing(out.categoryId)) out.categoryId = 'cl7';
  const image = normalizeGoodsImage(r.image);
  if (image) out.image = image;
  else delete out.image;
  return out;
}

/** 本地当天日期 `'YYYY-MM-DD'`（不引 dayjs，保持本文件零依赖）。 */
function todayISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 订阅：period / every / type / remind / currency 兜底（remind 必填对象）。 */
function normalizeSubscription(r: Row): Row {
  const out: Row = { ...r };
  if (out.period !== 'year' && out.period !== 'week' && out.period !== 'month') out.period = 'month';
  if (out.type !== 'lifetime' && out.type !== 'recurring') out.type = 'recurring';
  if (missing(out.every)) out.every = 1;
  if (missing(out.amount)) out.amount = 0;
  if (missing(out.currency)) out.currency = 'CNY';
  if (typeof out.autoRenew !== 'boolean') out.autoRenew = true;
  if (!isRow(out.remind)) out.remind = { renewLead: 3 };
  if (missing(out.status)) out.status = 'active';
  return out;
}

/** 账单：dueDate / status / amount / currency 兜底。 */
function normalizeBill(r: Row): Row {
  const out: Row = { ...r };
  if (missing(out.dueDate)) out.dueDate = todayISO();
  if (out.status !== 'paid' && out.status !== 'skipped' && out.status !== 'failed' && out.status !== 'pending') {
    out.status = 'pending';
  }
  if (missing(out.amount)) out.amount = 0;
  if (missing(out.currency)) out.currency = 'CNY';
  return out;
}

/** 时间记录：tags / meaning / durationMin 兜底。 */
function normalizeTimeRec(r: Row): Row {
  const out: Row = { ...r };
  if (!Array.isArray(out.tags)) out.tags = [];
  if (out.meaning !== 'gui' && out.meaning !== 'fou' && out.meaning !== 'xu') out.meaning = 'xu';
  if (missing(out.durationMin)) out.durationMin = 0;
  return out;
}

/** 心愿单：reasons 是可选数组，但若给成非数组必须清成数组（页面会 `.slice`）。 */
function normalizeWishItem(r: Row): Row {
  return Array.isArray(r.reasons) ? { ...r, reasons: asStringArray(r.reasons) } : r;
}

/**
 * 单行归一化入口（未列出的集合原样返回 —— 未知字段一律保留，不做白名单裁剪，
 * 避免把 AA 端自定义字段洗掉）。
 */
export function normalizeRow(name: CollectionName, row: Row): Row {
  switch (name) {
    case 'goods':
      return normalizeGoods(row);
    case 'valueRecords':
      return normalizeValueRecord(row);
    case 'subscriptions':
      return normalizeSubscription(row);
    case 'bills':
      return normalizeBill(row);
    case 'times':
      return normalizeTimeRec(row);
    case 'wishlist':
      return normalizeWishItem(row);
    default:
      return row;
  }
}

/**
 * 局部更新 patch 归一化：只对 patch 里**出现过的键**做兜底，
 * 不能把整行 normalize（否则会把没改的字段也补一遍，与服务端口径不一致）。
 */
function normalizePatch(name: CollectionName, patch: Row): Row {
  if (name === 'goods') {
    const out: Row = { ...patch };
    if ('tags' in out) out.tags = asStringArray(out.tags);
    if ('extraFees' in out) out.extraFees = normalizeFees(out.extraFees);
    if ('incomes' in out) out.incomes = asArray<unknown>(out.incomes).filter(isRow);
    if ('image' in out) {
      const image = normalizeGoodsImage(out.image);
      if (image) out.image = image;
      else delete out.image;
    }
    if ('currency' in out) out.currency = asString(out.currency).trim() || 'CNY';
    if ('status' in out && out.status !== 'retired' && out.status !== 'favorite') out.status = 'active';
    return out;
  }
  if (name === 'valueRecords') {
    const out: Row = { ...patch };
    if ('image' in out) {
      const image = normalizeGoodsImage(out.image);
      if (image) out.image = image;
      else delete out.image;
    }
    if ('currency' in out) out.currency = asString(out.currency).trim() || 'CNY';
    return out;
  }
  return patch;
}

/** 统计若干事件一共涉及多少行记录（含增删改）。 */
export function countInboxRows(events: MergeEventLike[]): number {
  let n = 0;
  for (const ev of events) {
    const r = ev.records ?? {};
    for (const name of COLLECTIONS) {
      if (Array.isArray(r[name])) n += r[name].length;
    }
    for (const group of [r.patches, r.deletes]) {
      if (group && typeof group === 'object') {
        for (const v of Object.values(group as Record<string, unknown>)) {
          if (Array.isArray(v)) n += v.length;
        }
      }
    }
  }
  return n;
}

export function mergeInboxEvents(
  base: Record<string, unknown>,
  events: MergeEventLike[],
): Partial<Record<CollectionName, unknown[]>> {
  const changed = new Set<CollectionName>();
  const working: Record<string, Row[]> = {};

  /** 惰性取一份可写副本；只有真正需要写入的集合才会进 changed。
   *  ★v1.7.7：副本里的**历史行**同样过一遍归一化 —— 之前合并进来的脏数据
   *  （缺 extraFees 的 AI 行）在下次合并时被顺手修好，不用等用户删了重录。 */
  const col = (name: string): Row[] | null => {
    if (!isCollection(name)) return null;
    if (!working[name]) {
      const b = base[name];
      working[name] = Array.isArray(b) ? b.filter(isRow).map((r) => normalizeRow(name, { ...r })) : [];
      changed.add(name);
    }
    return working[name];
  };

  for (const ev of events) {
    const records = ev.records ?? {};

    // ① 顶层集合：按 id upsert
    for (const name of COLLECTIONS) {
      const rows = records[name];
      if (!Array.isArray(rows)) continue;
      const typed = rows.filter(isRow).map((r) => normalizeRow(name, r));
      if (!typed.length) continue;
      const list = col(name);
      if (!list) continue;
      const fresh: Row[] = [];
      for (const row of typed) {
        const id = rowId(row);
        const idx = id ? list.findIndex((r) => rowId(r) === id) : -1;
        if (idx >= 0) list[idx] = normalizeRow(name, { ...list[idx], ...row });
        else fresh.push(row);
      }
      if (fresh.length) list.unshift(...fresh);
    }

    // ② 局部更新
    const patches = records.patches;
    if (patches && typeof patches === 'object' && !Array.isArray(patches)) {
      for (const [name, ops] of Object.entries(patches as Record<string, unknown>)) {
        if (!Array.isArray(ops)) continue;
        const list = col(name);
        if (!list) continue;
        for (const op of ops) {
          if (!isRow(op) || !isRow(op.patch)) continue;
          const patch = isCollection(name) ? normalizePatch(name, op.patch as Row) : (op.patch as Row);
          const id = String(op.id ?? '');
          if (!id) continue;
          const idx = list.findIndex((r) => rowId(r) === id);
          // 合并后再整体归一化一次：补上被 patch 打散的必填字段
          if (idx >= 0) list[idx] = isCollection(name) ? normalizeRow(name, { ...list[idx], ...patch }) : { ...list[idx], ...patch };
        }
      }
    }

    // ③ 删除
    const deletes = records.deletes;
    if (deletes && typeof deletes === 'object' && !Array.isArray(deletes)) {
      for (const [name, ids] of Object.entries(deletes as Record<string, unknown>)) {
        if (!Array.isArray(ids)) continue;
        const list = col(name);
        if (!list) continue;
        const kill = new Set(ids.map(String));
        working[name] = list.filter((r) => !kill.has(rowId(r)));
      }
    }

    // ④ 整组替换
    const replace = records.replace;
    if (replace && typeof replace === 'object' && !Array.isArray(replace)) {
      for (const [name, rows] of Object.entries(replace as Record<string, unknown>)) {
        if (!Array.isArray(rows)) continue;
        if (!isCollection(name)) continue;
        working[name] = rows.filter(isRow).map((r) => normalizeRow(name, { ...r }));
        changed.add(name);
      }
    }
  }

  const out: Partial<Record<CollectionName, unknown[]>> = {};
  for (const name of changed) out[name] = working[name] as unknown[];
  return out;
}