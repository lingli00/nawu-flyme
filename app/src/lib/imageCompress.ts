/**
 * 图片压缩（v1.0.19 · 备份瘦身铁律）。
 *
 * 背景：v1.0.18 备份从几百 KB 膨胀到 10MB+ —— 原因是
 * ①物品 img: dataURL（512px JPEG）全量进备份；②图标缓存 icons 字段全量导出。
 *
 * 规则（用户拍板）：
 * - 程序自带的图标（lucide id / 品牌 glyph）一律存**引用码**（裸 id / brand:slug），
 *   备份只带几个字节；
 * - 用户上传 / 网络搜来的图，入库与备份前一律压缩到 **≤100KB**。
 */

/** 图标类图（订阅图标、品牌标、列表缩略图）的上限（KB）。 */
export const IMAGE_MAX_KB = 100;

/**
 * ★v1.6.2 物品照片专用预算（与图标分开）。
 *
 * 背景：图标 512px/100KB 是为了「备份瘦身」，但物品照片要进**分享海报**——
 * 海报画布 1800px 宽，512px 的照片被放大 3 倍多，用户看到的就是「图片模糊」。
 * 因此物品照片单独给 1024px / 160KB：手机上够清晰，备份仍受控
 * （100 件全带照片也只有 16MB，且只有照片走这个额度，图标仍是几字节引用码）。
 */
export const IMAGE_PHOTO_KB = 160;
/** 物品照片最长边（方形裁切后的边长）。 */
export const IMAGE_PHOTO_DIM = 1024;

/** 物品照片入库：方形已裁好，只做体积压缩（失败原样返回）。 */
export async function compressPhoto(dataUrl: string): Promise<string> {
  return compressDataUrlUnder(dataUrl, IMAGE_PHOTO_KB, IMAGE_PHOTO_DIM);
}

/** dataURL 字符数 ≈ 字节数 × 1.37（base64），留余量按 1.4 估。 */
function approxKb(dataUrl: string): number {
  return (dataUrl.length / 1024) * 0.72;
}

/** 解码 dataURL → HTMLImageElement（失败 null）。 */
function decode(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const el = new Image();
    const t = setTimeout(() => resolve(null), 8000);
    el.onload = () => {
      clearTimeout(t);
      resolve(el);
    };
    el.onerror = () => {
      clearTimeout(t);
      resolve(null);
    };
    el.src = dataUrl;
  });
}

/**
 * 把 dataURL 压到 ≤maxKB：先限边长再逐步降质量，最差降到 256px/q0.4。
 * 解码失败或已达标时原样返回。
 */
export async function compressDataUrlUnder(
  dataUrl: string,
  maxKB: number = IMAGE_MAX_KB,
  maxDim = 1024,
): Promise<string> {
  const src = (dataUrl ?? '').trim();
  if (!src.startsWith('data:image/')) return src;
  // 已达标（SVG 交给下面的重编码管线统一转 JPEG）
  if (approxKb(src) <= maxKB && !src.startsWith('data:image/svg')) return src;
  const img = await decode(src);
  if (!img) return src;
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (!nw || !nh) return src;

  const dims = [Math.min(maxDim, Math.max(nw, nh)), 768, 512, 384, 256];
  const qualities = [0.82, 0.65, 0.5, 0.4];
  let best = src;
  for (const dim of dims) {
    const scale = Math.min(1, dim / Math.max(nw, nh));
    const w = Math.max(1, Math.round(nw * scale));
    const h = Math.max(1, Math.round(nh * scale));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) return best;
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of qualities) {
      const out = cv.toDataURL('image/jpeg', q);
      best = out;
      if (approxKb(out) <= maxKB) return out;
    }
  }
  return best;
}

/**
 * 深度瘦身快照集合里的 img: dataURL（goods.image.ref / subscriptions.icon 等）。
 * 返回新对象（浅拷贝集合数组，条目按需替换）。
 */
export async function slimCollectionsIcons(
  collections: Record<string, unknown[]> | undefined | null,
): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  if (!collections) return out;
  const jobs: Array<Promise<void>> = [];

  const compressVal = async (v: string): Promise<string> => {
    if (!v.startsWith('img:')) return v;
    const slim = await compressDataUrlUnder(v.slice(4), IMAGE_MAX_KB);
    return `img:${slim}`;
  };

  for (const [name, rows] of Object.entries(collections)) {
    if (!Array.isArray(rows)) {
      out[name] = [];
      continue;
    }
    out[name] = rows.slice();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as Record<string, unknown> | null;
      if (!row || typeof row !== 'object') continue;
      // 物品：image = { source, ref }
      const image = row.image as { source?: unknown; ref?: unknown } | null | undefined;
      if (image && typeof image === 'object' && typeof image.ref === 'string' && image.ref.startsWith('img:')) {
        const rowRef = row;
        const idx = i;
        const coll = name;
        jobs.push(
          compressVal(image.ref).then((ref) => {
            (out[coll][idx] as Record<string, unknown>) = {
              ...rowRef,
              image: { ...(rowRef.image as Record<string, unknown>), ref },
            };
          }),
        );
      }
      // 订阅等：icon 字符串字段
      if (typeof row.icon === 'string' && row.icon.startsWith('img:')) {
        const rowRef = row;
        const idx = i;
        const coll = name;
        jobs.push(
          compressVal(row.icon).then((icon) => {
            (out[coll][idx] as Record<string, unknown>) = { ...rowRef, icon };
          }),
        );
      }
      // v1.0.24：裸 img: 字符串字段（心动清单 image / 冷静池 image ——
      // v1.0.22 加字段时漏了这里，导致这两类图不压缩直接进备份）
      if (typeof row.image === 'string' && row.image.startsWith('img:')) {
        const rowRef = row;
        const idx = i;
        const coll = name;
        jobs.push(
          compressVal(row.image).then((image) => {
            (out[coll][idx] as Record<string, unknown>) = { ...rowRef, image };
          }),
        );
      }
    }
  }
  await Promise.all(jobs);
  return out;
}

/* ------------------------------------------------------------------ */
/* ★v1.8.0 备份 / 快照瘦身：图片只留云端引用                            */
/* ------------------------------------------------------------------ */

/** 快照里一条记录的图片字段名（与 imageMigrate 的 IMAGE_KEYS_RECORD 一致）。 */
const SNAPSHOT_IMAGE_KEYS = ['image', 'icon'] as const;

/** 对象形态的图片值 → 标准云端相对路径；不是云端返回 ''。 */
function canonicalCloudRefOf(img: unknown): string {
  if (!img || typeof img !== 'object' || Array.isArray(img)) return '';
  const o = img as { source?: unknown; ref?: unknown; sha256?: unknown };
  const src = typeof o.source === 'string' ? o.source.toLowerCase() : '';
  const refStr = typeof o.ref === 'string' ? o.ref.trim() : '';
  if (src !== 'cloud' && !/\/api\/user\/images\//i.test(refStr)) return '';
  if (/^[0-9a-f]{64}$/i.test(refStr)) return `/api/user/images/${refStr.toLowerCase()}`;
  const m = /\/api\/user\/images\/([0-9a-f]{64})/i.exec(refStr) || /\/api\/user\/images\/([0-9a-f]{64})/i.exec(typeof o.sha256 === 'string' ? o.sha256 : '');
  return m ? `/api/user/images/${m[1].toLowerCase()}` : '';
}

/**
 * 任意值 → 标准云端相对路径；不是云端返回 ''。
 * 兼容四种来源：对象 `{source:'cloud',ref}`、`cloud:<url>` 字符串、`url:/api/user/images/<sha>`、已归一化路径。
 */
export function canonicalCloudRef(v: unknown): string {
  if (v && typeof v === 'object') return canonicalCloudRefOf(v);
  if (typeof v !== 'string') return '';
  let s = v.trim();
  if (!s) return '';
  if (s.startsWith('cloud:')) s = s.slice(6).trim();
  else if (s.startsWith('url:')) s = s.slice(4).trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return `/api/user/images/${s.toLowerCase()}`;
  const m = /\/api\/user\/images\/([0-9a-f]{64})/i.exec(s);
  return m ? `/api/user/images/${m[1].toLowerCase()}` : '';
}

/** 图片字段是否已经是云端引用。 */
export function isCloudRef(v: unknown): boolean {
  return canonicalCloudRef(v) !== '';
}

/**
 * 记录 → 「台账瘦身版」：云端图只留 `{source:'cloud', ref, sha256}`，**丢掉本地缩略图**。
 *
 * 为什么要丢 thumb：缩略图是 3~6KB 的 dataURL，它只服务于**本机渲染**
 * （离线 / URL 过期兜底）。备份与同步的目的是「把这张图在别的设备上还原出来」，
 * 云端图本身就在服务器上 —— 把缩略图一起传上去，等于每张图白送 5KB 上行，
 * 18 张图 ≈ 90KB，弱网下就是用户抱怨的那几秒。
 * 收到终端的渲染不依赖它（CloudPhoto 有网络原图兜底）。
 *
 * 非云端记录 / 无图片字段 → **原对象返回**（引用相同），调用方可据此零改动跳过。
 */
export function slimRecordForSnapshot<T>(row: T): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  let out: Record<string, unknown> | null = null;
  for (const key of SNAPSHOT_IMAGE_KEYS) {
    const v = (row as Record<string, unknown>)[key];
    const ref = canonicalCloudRefOf(v);
    if (!ref) continue;
    const img = v as Record<string, unknown>;
    const rawSha = typeof img.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(img.sha256) ? img.sha256.toLowerCase() : '';
    // 已经是最精简形态（只有 source/ref/sha256 三个字段）→ 不动，保持对象引用稳定
    if (Object.keys(img).length === 3 && !('thumb' in img) && ref === img.ref) continue;
    if (!out) out = { ...(row as Record<string, unknown>) };
    out[key] = { source: 'cloud', ref, sha256: rawSha || ref.slice(-64) };
  }
  return (out as T) ?? row;
}

/**
 * 整份集合 → 台账瘦身版（备份 payload / .flyme 导出共用）。
 * 没有任何云端图时**原对象返回**，行为与旧版逐字节一致。
 */
export function slimCollectionsForSnapshot(
  collections: Record<string, unknown[]> | undefined | null,
): Record<string, unknown[]> {
  const src = collections ?? {};
  let dirty = false;
  const out: Record<string, unknown[]> = {};
  for (const [name, rows] of Object.entries(src)) {
    if (!Array.isArray(rows)) {
      out[name] = [];
      dirty = true;
      continue;
    }
    let arr: unknown[] | null = null;
    for (let i = 0; i < rows.length; i += 1) {
      const slim = slimRecordForSnapshot(rows[i]);
      if (slim !== rows[i]) {
        if (!arr) arr = rows.slice();
        arr[i] = slim;
      }
    }
    if (arr) {
      out[name] = arr;
      dirty = true;
    } else {
      out[name] = rows;
    }
  }
  return dirty ? out : (src as Record<string, unknown[]>);
}

/**
 * 收集快照里被实际引用的 url: 图标键（normIconKey 归一化后），
 * 供 iconCacheExportReferenced 只导出「真正在用」的缓存条目。
 */
export function collectUrlRefKeys(
  collections: Record<string, unknown[]> | undefined | null,
  norm: (src: string) => string,
): Set<string> {
  const keys = new Set<string>();
  if (!collections) return keys;
  const feed = (icon: unknown): void => {
    if (typeof icon !== 'string') return;
    // ★v1.0.29：goods.image.ref 存的是**裸 URL**（source:'web'），不带 url: 前缀 ——
    // 旧实现只认 url: 开头，导致物品的官网图标被判为「未被引用」，备份恢复后永久丢图。
    const raw = (icon.startsWith('url:') ? icon.slice(4) : /^https?:\/\//i.test(icon) ? icon : '').trim();
    if (!raw) return;
    keys.add(norm(raw));
    // 同链兜底：/api/icon/img?d=… 的 d 参数键
    const m = raw.match(/[?&]d=([^&]+)/);
    if (m) keys.add(`/api/icon/img?d=${m[1]}`);
    const m2 = raw.match(/[?&]u=([^&]+)/);
    if (m2) keys.add(`/api/icon/proxy?u=${m2[1]}`);
  };
  for (const rows of Object.values(collections)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const r = row as Record<string, unknown> | null;
      if (!r || typeof r !== 'object') continue;
      const image = r.image as { ref?: unknown } | null | undefined;
      if (image && typeof image === 'object') feed(image.ref);
      // v1.0.24：裸字符串形态（心动清单 / 冷静池的 image 字段）
      if (typeof r.image === 'string') feed(r.image);
      feed(r.icon);
    }
  }
  return keys;
}
