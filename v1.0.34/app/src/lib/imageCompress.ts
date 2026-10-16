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

/** 单图体积上限（KB）。 */
export const IMAGE_MAX_KB = 100;

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
