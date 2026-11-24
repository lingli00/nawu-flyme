import type { UploadResult } from './imageCloud';

/**
 * ★v1.8.0 图片托管迁移 —— 把记录里「内嵌 base64 / 网络直链」的图换成云端引用。
 *
 * 这是整套方案里**最需要克制**的一层，三件事都必须同时成立：
 *   ① 幂等：已经是云端引用的记录原样返回（`changed=false`），不会反复上传；
 *   ② 不丢图：上传失败 → 记录**原样返回**，本地 base64 保留，下一轮再试；
 *   ③ 不崩：任何解析异常都让该记录原样通过（宁可这条没托管，也不能弄坏数据）。
 *
 * 纯函数设计（不依赖 store / 网络）：上传器由调用方注入，
 * 这样单测可以在没有登录态的情况下覆盖全部分支。
 */

/** 上传器签名：给一段图片内容（dataURL / 裸 base64 / http 直链），返回上传结果。 */
export type ImageUploader = (src: string) => Promise<UploadResult>;

/** 图片缓存形态（与 types/entities 的 GoodsImage 对齐，但不依赖它，便于纯函数单测）。 */
export interface CloudImageLike {
  source?: string;
  ref: string;
  sha256?: string;
  thumb?: string;
  [k: string]: unknown;
}

/** 一次迁移的统计（供日志 / 报告 / Toast 使用）。 */
export interface MigrateStat {
  /** 被改写的记录条数。 */
  records: number;
  /** 成功托管的图片数。 */
  uploaded: number;
  /** 服务端已有、秒返回的图片数。 */
  deduped: number;
  /** 上传失败的图片数（这些记录保持原样）。 */
  failed: number;
}

/** 单张图迁移所需的上下文。 */
export interface MigrateCtx {
  upload: ImageUploader;
  /** dataURL → 本地缩略图（≤256px）；缺省则不留缩略图（只靠云端 URL）。 */
  thumb?: (dataUrl: string) => Promise<string>;
}

const SHA_RE = /^[0-9a-f]{64}$/i;
const CLOUD_URL_RE = /\/api\/user\/images\/([0-9a-f]{64})/i;
const HTTP_RE = /^https?:\/\//i;
const DATA_RE = /^data:image\//i;
const BARE_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/** 裸 base64 判定阈值（与 goodsIcon.isBareBase64Image 一致；短串不碰，避免误伤文本）。 */
const BARE_BASE64_MIN = 100;

/** 字符串是否裸 base64 图片（够长 + 字符集合法）。 */
export function looksBareBase64(s: string): boolean {
  const v = (s ?? '').trim();
  return v.length > BARE_BASE64_MIN && BARE_BASE64_RE.test(v);
}

/** 是否已经是云端引用（任何形态）。 */
export function isAlreadyCloud(value: unknown): boolean {
  if (typeof value === 'string') {
    const v = value.trim();
    if (!v) return false;
    if (v.startsWith('cloud:')) return true;
    return CLOUD_URL_RE.test(v);
  }
  if (value && typeof value === 'object') {
    const o = value as { source?: unknown; ref?: unknown };
    if (typeof o.source === 'string' && o.source.toLowerCase() === 'cloud') return true;
    return typeof o.ref === 'string' && CLOUD_URL_RE.test(o.ref);
  }
  return false;
}

/** 这段字符串里的图片内容「能不能托管」（dataURL / 裸 base64 / http(s) 直链）。 */
export function isMigratable(src: string): boolean {
  const s = (src ?? '').trim();
  if (!s) return false;
  if (s.startsWith('img:')) return isMigratable(s.slice(4));
  if (s.startsWith('data:')) return DATA_RE.test(s);
  if (HTTP_RE.test(s)) return true;
  return looksBareBase64(s);
}

/** dataURL / 字符串 → 裸 base64（上传与去重都用同一个口径）。 */
export function base64BodyOf(dataUrl: string): string {
  const s = (dataUrl ?? '').trim();
  if (!s.startsWith('data:')) return s.replace(/\s+/g, '');
  const comma = s.indexOf(',');
  return comma >= 0 ? s.slice(comma + 1).replace(/\s+/g, '') : s;
}

/**
 * **迁移前预判**：这段图片内容托管后会不会「结构上变化」？
 *
 * 只有三种情况需要动它：
 *   a. dataURL / 裸 base64（本地图）—— 要换成云端引用；
 *   b. http(s) 直链且是**照片类**（商品图 / 官网图）—— 换取稳定的云端副本，
 *      否则外链失效、别人站点防盗链就是永久破图；
 *   c. 其它（brand: / lucide id / 空）——**不动**。
 *
 * 为什么必须预判：`noteCollectionMutation` 会对**出现的每个字段键**做深比较，
 * 提前知道「这张图会不会变」就能保证「不会变的记录」一个字节都不改，
 * 既省流量又不污染同步日志。
 */
export function imageNeedsMigration(
  value: unknown,
  kind: 'record' | 'string',
): boolean {
  if (isAlreadyCloud(value)) return false;
  if (value === null || value === undefined) return false;
  if (kind === 'string') {
    // 字符串字段（wishlist / cooldowns 的 image）：只处理 img:dataURL / dataURL / 裸 base64
    if (typeof value !== 'string') {
      // 对象形态也会被某些导入写成对象（EntityNormalize 兼容），这里按对象递归判断
      const o = value as CloudImageLike;
      return !!o && typeof o.ref === 'string' && !o.ref.startsWith('brand:') && !o.ref.startsWith('url:') && isMigratable(o.ref);
    }
    const s = value.trim();
    if (s.startsWith('img:')) return isMigratable(s);
    if (s.startsWith('url:') || s.startsWith('brand:') || s.startsWith('cloud:')) return false;
    return isMigratable(s) && !HTTP_RE.test(s);
  }
  // 记录形态（goods.image / subscriptions.image / valueRecords.image）
  const o = value as CloudImageLike;
  if (!o || typeof o.ref !== 'string') return false;
  const ref = o.ref.trim();
  const source = typeof o.source === 'string' ? o.source.toLowerCase() : '';
  if (ref.startsWith('brand:') || source === 'brand' || source === 'builtin' || source === 'system') return false;
  if (source === 'web' && HTTP_RE.test(ref)) return true; // 照片类外链 → 托管副本
  return isMigratable(ref) && !ref.startsWith('url:');
}

/**
 * 迁移一张图（`value` 是 image 对象）。**永不抛异常**。
 *
 * @returns `null` = 保持原样（不需要 / 失败）；否则返回新的云端 image 对象
 */
async function migrateRecordImage(
  value: CloudImageLike,
  ctx: MigrateCtx,
  stat: MigrateStat,
): Promise<CloudImageLike | null> {
  const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
  if (!ref) return null;
  if (isAlreadyCloud(value)) return null;
  const source = typeof value.source === 'string' ? value.source.toLowerCase() : '';
  if (source === 'brand' || source === 'builtin' || source === 'system') return null;
  if (ref.startsWith('brand:')) return null;

  let src = ref;
  if (source === 'web' || HTTP_RE.test(ref)) {
    if (!HTTP_RE.test(ref)) return null; // web 形态但不是 http（异常数据）→ 不碰
    src = ref;
  } else if (!isMigratable(ref)) {
    return null; // lucide id / emoji / 其它引用码
  }

  const isData = src.startsWith('data:');
  const up = await ctx.upload(src);
  if (!up.ok || !up.sha256) {
    stat.failed += 1;
    return null;
  }
  stat.uploaded += 1;
  if (up.deduped) stat.deduped += 1;

  // 缩略图：本地图用本地 canvas 压一张（离线兜底）；外链抓不到原图就不留缩略图
  let thumb = '';
  if (ctx.thumb && isData) {
    try {
      thumb = await ctx.thumb(src);
    } catch {
      thumb = '';
    }
  }

  const next: CloudImageLike = {
    source: 'cloud',
    ref: up.url || `/api/user/images/${up.sha256}`,
    sha256: up.sha256.toLowerCase(),
  };
  if (thumb && thumb.length < src.length) next.thumb = thumb;
  else if (typeof value.thumb === 'string' && value.thumb) next.thumb = value.thumb;
  return next;
}

/** 迁移一个字符串字段（wishlist.image / cooldowns.image）。 */
async function migrateStringImage(
  value: string,
  ctx: MigrateCtx,
  stat: MigrateStat,
): Promise<string | null> {
  const raw = value.trim();
  if (!raw || isAlreadyCloud(raw)) return null;
  if (raw.startsWith('brand:') || raw.startsWith('cloud:')) return null;
  let src = raw;
  if (raw.startsWith('img:')) src = raw.slice(4).trim();
  else if (raw.startsWith('url:')) return null; // web 形态字符串：维持原样（既有可能失效也不值得动它）
  if (!isMigratable(src)) return null;
  if (HTTP_RE.test(src)) return null;

  const up = await ctx.upload(src);
  if (!up.ok || !up.sha256) {
    stat.failed += 1;
    return null;
  }
  stat.uploaded += 1;
  if (up.deduped) stat.deduped += 1;
  let thumb = '';
  if (ctx.thumb && src.startsWith('data:')) {
    try {
      thumb = await ctx.thumb(src);
    } catch {
      thumb = '';
    }
  }
  // 字符串字段只能存一个 icon 字符串，缩略图无处安放 —— 直接写云端引用（不含签名 URL 的 t/s，
  // 保持短小且不带会过期的参数，渲染时由 goodsIconView 走 url: 分支再重签）。
  void thumb;
  return `cloud:${up.url || `/api/user/images/${up.sha256}`}`;
}

/** 一条记录里哪些键可能装图（12 个集合的真实字段名）。 */
const IMAGE_KEYS_RECORD = ['image', 'icon', 'cover', 'photo'] as const;
const IMAGE_KEYS_STRING = ['image', 'icon'] as const;

/**
 * 迁移一条记录（就地返回**新对象**，绝不修改入参）。
 *
 * @param stringMode true = 该字段里的图是字符串形态（wishlist / cooldowns 的 image）
 * @returns `{ row, changed }`；`changed=false` 时 `row` 就是原引用本身（调用方可直接跳过）
 */
export async function migrateRecord<T extends Record<string, unknown>>(
  row: T,
  ctx: MigrateCtx,
  stat: MigrateStat,
  stringMode = false,
): Promise<{ row: T; changed: boolean }> {
  if (!row || typeof row !== 'object') return { row, changed: false };
  let next: T | null = null;
  const ensure = (): T => {
    if (!next) next = { ...row };
    return next;
  };

  for (const key of IMAGE_KEYS_RECORD) {
    const v = (row as Record<string, unknown>)[key];
    if (v === null || v === undefined) continue;

    // ① 字符串形态的图（wishlist.image = 'img:data:…' / cooldowns.image 同）
    if (typeof v === 'string') {
      if (!IMAGE_KEYS_STRING.includes(key as (typeof IMAGE_KEYS_STRING)[number])) {
        // icon 字段（subscriptions.icon / categories.icon）：只托管 img: 形态，url:/lucide 不动
        if (!v.startsWith('img:')) continue;
      }
      try {
        const out = await migrateStringImage(v, ctx, stat);
        if (out) (ensure() as Record<string, unknown>)[key] = out;
      } catch {
        /* 单字段失败：保留原值 */
      }
      continue;
    }

    // ② 对象形态 {source, ref}（goods.image / subscriptions.image / valueRecords.image）
    if (typeof v === 'object' && !Array.isArray(v)) {
      try {
        const out = await migrateRecordImage(v as CloudImageLike, ctx, stat);
        if (out) (ensure() as Record<string, unknown>)[key] = out;
      } catch {
        /* 单字段失败：保留原值 */
      }
    }
  }

  void stringMode;
  return next ? { row: next, changed: true } : { row, changed: false };
}

/* ------------------------------------------------------------------ */
/* 同步路径的兜底：比较「引用语义」而不是「内容字节」                     */
/* ------------------------------------------------------------------ */

/**
 * 把一条图片引用归一成**可比较的语义键**（同步差集专用）。
 *
 * 为什么需要：同步 outbox 用 `stableStringify` 深比较，而云端引用里带了
 * **会过期的签名参数**（`?t=&s=`）—— 同一张图重签一次 URL 就变，会被误判成
 * 「记录变了」从而反复推送。归一时把签名参数统一抹成占位符即可根治。
 */
export function normalizeImageRefForDiff(ref: string): string {
  const s = (ref ?? '').trim();
  if (!s) return '';
  const sha = CLOUD_URL_RE.exec(s);
  if (sha) return `/api/user/images/${sha[1].toLowerCase()}`;
  if (s.startsWith('cloud:')) {
    const body = s.slice(6).trim();
    const m = CLOUD_URL_RE.exec(body);
    if (m) return `/api/user/images/${m[1].toLowerCase()}`;
    if (SHA_RE.test(body)) return `/api/user/images/${body.toLowerCase()}`;
    return `cloud:${body.replace(/[?&](t|s)=[^&]*/g, '')}`;
  }
  return s;
}

/**
 * 记录里「装 fig 的字段」→ 归一后的可比较形式（其它字段原样保留）。
 *
 * 只抹掉云端引用上的签名参数，其它一律不动 —— 结构不变，只是让深比较稳定。
 */
export function normalizeRecordImageRefs<T>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  let out: Record<string, unknown> | null = null;
  for (const key of IMAGE_KEYS_RECORD) {
    const v = (row as Record<string, unknown>)[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const img = v as CloudImageLike;
    if (typeof img.ref !== 'string') continue;
    const norm = normalizeImageRefForDiff(img.ref);
    if (norm === img.ref) continue;
    if (!out) out = { ...(row as Record<string, unknown>) };
    out[key] = { ...img, ref: norm };
  }
  return (out as T) ?? row;
}

/* ------------------------------------------------------------------ */
/* 差异比对：先列云端已有 sha256，再只上传「本地有、云端没有」的           */
/* ------------------------------------------------------------------ */

/** 一张待比对/待上传的图。 */
export interface PendingImage {
  /** 图片内容（dataURL / 裸 base64 / http 直链）。 */
  src: string;
  /** 内容 sha256（`src` 的 UTF-8 字节，与服务端口径一致；算不出为 ''）。 */
  sha256: string;
}

/** 一次托管计划的执行结果。 */
export interface HydrateResult {
  /** 内容值（或 http 直链）→ 上传/命中的结果，供迁移层改写记录。 */
  results: Map<string, UploadResult>;
  uploaded: number;
  deduped: number;
  failed: number;
}

/**
 * **差异上传的主体**：把一组图片托管到云端，只传云端没有的。
 *
 * 顺序（也就是用户要的「检查本地与云端的区别，然后再上传」）：
 *   ① 算每张图的 sha256（`sha256Hex`，与服务端同口径）；
 *   ② 取云端已有 sha256 列表（`fetchCloudHashes`，一次 GET）；
 *   ③ 云端命中 → 记为「已存在」（deduped），**一个字节都不传**；
 *   ④ 云端没有 → 才真传。并发 2（弱网下别把上行塞满，避免和业务请求抢带宽）。
 *
 * 任何一步失败都**不抛异常**：失败的图 `ok:false`，上层据此保留本地 base64。
 */
export async function hydrateImages(
  items: PendingImage[],
  opts: {
    upload: ImageUploader;
    /** 云端已有 sha256；`null` = 未知（服务端不支持/网络失败 → 全部交给 PUT 去去重）。 */
    cloudHashes: Set<string> | null;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<HydrateResult> {
  const out: HydrateResult = { results: new Map(), uploaded: 0, deduped: 0, failed: 0 };
  const total = items.length;
  if (!total) return out;

  // 同内容只传一次（一张图被多个物品引用时很常见）
  const bySha = new Map<string, PendingImage>();
  const order: PendingImage[] = [];
  for (const it of items) {
    const k = it.sha256 || it.src;
    if (bySha.has(k)) continue;
    bySha.set(k, it);
    order.push(it);
  }

  let done = 0;
  const CONCURRENCY = 2;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, order.length) }, async () => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= order.length) return;
      const it = order[idx];
      let res: UploadResult;
      if (it.sha256 && opts.cloudHashes && opts.cloudHashes.has(it.sha256)) {
        // ② 云端已有 → 秒记结果（不传字节）
        res = { ok: true, sha256: it.sha256, url: `/api/user/images/${it.sha256}`, deduped: true };
        out.deduped += 1;
      } else {
        res = await opts.upload(it.src);
        if (res.ok) {
          if (res.deduped) out.deduped += 1;
          else out.uploaded += 1;
        } else {
          out.failed += 1;
        }
      }
      out.results.set(it.src, res);
      done += 1;
      opts.onProgress?.(done, total);
    }
  });
  await Promise.all(workers);
  return out;
}