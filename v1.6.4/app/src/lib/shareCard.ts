import type { Goods } from '../types/entities';
import { Capacitor } from '@capacitor/core';
import { currentServer } from '../store';
import { fetchIconAsDataUrl, iconCacheLookup } from './iconCache';
import { glyphBySlug } from './simpleBrand';
import { goodsIconValue } from './goodsIcon';
import { dailyCost, holdDays, totalInvest } from '../domain/goods';
import logger from './log';

/** 兼容旧调用方（置物墙）——物品 image → icon 字符串的唯一实现在 lib/goodsIcon。 */
export { goodsIconValue };

/**
 * 分享生图（v1.0.10；v1.0.17 重排版）。纯 canvas，无第三方依赖。
 *
 * - icon 三形态兼容：img: dataURL 直接画；url: 相对路径补当前站点 origin；
 *   裸 lucide id / 无法加载 → 柔底 + 名称首字兜底；
 * - v1.0.17：照片类（本地 / 商品图）一律 **cover 铺满图区**，不再小图居中留白；
 *   logo 类才 contain；单卡补齐备注、标签与「总投入 / 日均 / 陪伴 / 购入」四项数据；
 * - 返回 PNG dataURL，由调用方决定存相册 / 分享 / 下载。
 */

/** 米白底 / 深绿主色（与全局 --paper/--accent 同源）。 */
const C = { paper: '#f5f3ee', accent: '#2e6e5a', accentSoft: '#e3ede8', ink: '#26302c', ink3: '#8a938f', line: '#e4e2da' };

/** 分享海报写入的系统相册名（App 端）。 */
const ALBUM_NAME = '纳物';

function loadImage(src: string, timeoutMs = 6000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = src;
  });
}

/** 物品 icon 值 → 可绘制的 src（不可绘返回 null）。 */
function iconSrcOf(icon: string | undefined): string | null {
  const v = (icon ?? '').trim();
  if (!v) return null;
  if (v.startsWith('img:')) return v.slice(4).trim();
  if (v.startsWith('url:')) {
    let u = v.slice(4).trim();
    if (!/^https?:\/\//i.test(u)) {
      // 相对路径补 origin：优先真实服务器（App 内 window.origin 是 https://localhost，拼上去必然 404）
      const origin = currentServer()?.url || (typeof window !== 'undefined' ? window.location.origin : '') || '';
      if (!origin) return null;
      u = `${origin}${u.startsWith('/') ? '' : '/'}${u}`;
    }
    // Iconify 直链在部分手机网络不可达 → 换自建代理（服务器有 CORS 头，canvas 不脏）
    if (u.includes('api.iconify.design')) {
      const base = currentServer()?.url ?? (typeof window !== 'undefined' ? window.location.origin : '');
      if (base) u = `${base}/api/icon/proxy?u=${encodeURIComponent(u)}`;
    }
    return u;
  }
  return null; // 裸 lucide id：canvas 无法画矢量，走首字兜底
}

/** canvas 用的图标 src：本地缓存 dataURL 优先（v1.0.15），
 *  未命中才回落 URL（dataURL 画 canvas 不存在跨域污染，WebView 加载 http 图
 *  慢/不稳的问题也一并绕开）。 */
async function resolveIconSrc(icon: string | undefined): Promise<string | null> {
  const urlSrc = iconSrcOf(icon);
  if (!urlSrc) return null;
  if (urlSrc.startsWith('data:')) return urlSrc;
  const cached = await iconCacheLookup([urlSrc]);
  return cached ?? urlSrc;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 千分位金额；整数不显示小数，有零头保留两位。 */
function fmtMoney(n: number, keepCents = false): string {
  const v = Number.isFinite(n) ? n : 0;
  if (keepCents) return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/**
 * 图该怎么画（v1.0.17）。
 *
 * 旧版一律 contain + 56 内边距 → 商品照片被缩得很小、四周大片白边（用户反馈「显示图小」）。
 * 现在按来源判定：
 * - **cover**：实拍图 / 商品图（本地上传 `img:`、Bing 商品图代理 `/api/img/`）→ 铺满图区、居中裁切；
 * - **contain**：品牌 logo / 矢量图标（Iconify 代理 `/api/icon/`、裸 lucide）→ 完整呈现，只留很小边距。
 */
export function iconFitMode(icon: string | undefined): 'cover' | 'contain' {
  const v = (icon ?? '').trim();
  if (v.startsWith('img:')) return 'cover';
  if (v.startsWith('brand:')) return 'contain'; // 内置品牌 glyph = 矢量 logo
  if (v.startsWith('url:')) {
    const u = v.slice(4).toLowerCase();
    if (u.includes('/api/img/') || u.includes('bing.net') || u.includes('tse') ) return 'cover';
  }
  return 'contain';
}

/** 缩略图被 cover 会糊：短边不足阈值时退回 contain。 */
const COVER_MIN_PX = 180;

/** cover / contain 画一张图进矩形（带圆角裁切）。返回是否画了真图。 */
function drawFit(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  mode: 'cover' | 'contain',
): void {
  const iw = img.width || 1;
  const ih = img.height || 1;
  const useCover = mode === 'cover' && Math.min(iw, ih) >= COVER_MIN_PX;
  // contain 的留白：logo 也不该缩得太小，边距压到 8%
  const pad = useCover ? 0 : Math.min(w, h) * 0.08;
  const boxW = w - pad * 2;
  const boxH = h - pad * 2;
  const scale = useCover ? Math.max(boxW / iw, boxH / ih) : Math.min(boxW / iw, boxH / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.save();
  if (r > 0) {
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
  }
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

/** 按当前 font 把长文本截断到 maxW（二分 + 省略号）。 */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/* ---------------- ★v1.6.2 高清分享卡（整体重做） ---------------- */

/**
 * 输出倍率：画布物理像素 = 逻辑尺寸 × R。
 *
 * 旧版 900×1200 直接出图，手机 @2x/@3x 屏上看就是「糊」—— 一张 900px 宽的图
 * 铺满 1080px 的屏幕必然被放大。现在按 2 倍出图（1800×2250），
 * 文字与描边全部按逻辑坐标画、由 ctx.scale 放大，边缘依然锐利。
 */
const R = 2;
/** 整墙长图倍率（图更多、更高，1.5 倍已足够清晰，同时控制体积）。 */
const RW = 1.5;

/** 货币符号（与页面一致：CNY→¥ / USD→$）。 */
function symbolOf(currency?: string): string {
  return currency === 'USD' ? '$' : '¥';
}

/** 照片类（要 cover 铺满、要抓原图）判定，与 iconFitMode 同源。 */
function isPhotoIcon(icon: string | undefined): boolean {
  const v = (icon ?? '').trim();
  if (v.startsWith('img:')) return true;
  if (!v.startsWith('url:')) return false;
  const u = v.slice(4).toLowerCase();
  return u.includes('/api/img/') || u.includes('bing.net') || u.includes('tse');
}

/**
 * 分享生图用的「尽量高清」取图。
 *
 * 为什么不能只用图标缓存：iconCache 是为列表渲染存的（单条 ≤400KB），
 * 而商品图入库前经过「方裁 512 + 压到 ≤100KB」，拿来画 772px 的图区只能放大 → 发虚。
 * 所以照片类**先按原图抓一次**（走服务端图片代理，字节上限放到 12MB），
 * 抓不到才回落缓存 / 直链。抓到的原图在本会话内缓存，反复分享不再重复请求。
 */
const shareImageCache = new Map<string, HTMLImageElement | null>();

async function loadShareImage(iconVal: string | undefined): Promise<HTMLImageElement | null> {
  const v = (iconVal ?? '').trim();
  if (!v || v.startsWith('brand:')) return null;
  const cached = shareImageCache.get(v);
  if (cached !== undefined) return cached;

  let img: HTMLImageElement | null = null;
  if (isPhotoIcon(v)) {
    const src = iconSrcOf(v);
    if (src && !src.startsWith('data:')) {
      const big = await fetchIconAsDataUrl(src, 12_000_000);
      if (big) img = await loadImage(big, 10_000);
    }
  }
  if (!img) {
    const src = await resolveIconSrc(v);
    if (src) img = await loadImage(src);
  }
  shareImageCache.set(v, img);
  return img;
}

/** 竖向渐变压深（白字可读，但不要把整张图压成灰）。 */
function scrim(
  ctx: CanvasRenderingContext2D,
  _x: number,
  y: number,
  w: number,
  h: number,
  from: string,
  to: string,
): void {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, y, w, h);
}

/**
 * 单物品分享卡（★v1.6.2 重新设计）。
 *
 * 版式就三件事：**图占满 / 字最少 / 没有宽大边框**。
 * - 照片类：照片**满版铺满整张卡**（0 边距）。旧版是白卡 + 46px 内边距 + 2px 描边，
 *   图片实际只占一半面积，四周一圈泛白，正是用户说的「多余宽大泛白边框」。
 * - 图标类（品牌 logo / 系统图标）：柔色底 + 居中标的，底部走深色文字，
 *   不再出现「一坨白卡套一个 72px 小图标」。
 * - 数据从 2×2 四宫格收敛成**一行**（分类 · 价格 · 日均 · 陪伴），信息不丢、版面不挤。
 */
export async function drawGoodsCard(g: Goods, categoryName: string | null): Promise<string> {
  const W = 900;
  const H = 1125; // 4:5，与置物墙格子同比例
  const PAD = 48;
  const cw = W - PAD * 2;

  const cv = document.createElement('canvas');
  cv.width = Math.round(W * R);
  cv.height = Math.round(H * R);
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('画布不可用');
  ctx.scale(R, R);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const iconVal = goodsIconValue(g);
  const photo = await loadShareImage(iconVal);
  const glyph = iconVal.startsWith('brand:') ? glyphBySlug(iconVal.slice(6).trim()) : null;
  /** 照片型且图够大 → cover 满版；其余（logo / 小图 / 系统图标）→ 柔底居中。 */
  const fullBleed = Boolean(photo) && iconFitMode(iconVal) === 'cover';

  if (fullBleed && photo) {
    drawFit(ctx, photo, 0, 0, W, H, 0, 'cover');
    // 底部压深承载文字；顶部再加一道很淡的压深，避免浅色照片上品牌字看不见
    scrim(ctx, 0, H * 0.48, W, H * 0.52, 'rgba(10,14,12,0)', 'rgba(10,14,12,0.92)');
    scrim(ctx, 0, 0, W, 132, 'rgba(10,14,12,0.34)', 'rgba(10,14,12,0)');
  } else {
    // 图标型：柔底铺满 + 居中呈现（不加任何卡片底 / 描边 / 内边距）
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, W, H);
    const bh = H * 0.76;
    ctx.fillStyle = C.accentSoft;
    ctx.fillRect(0, 0, W, bh);
    let drawn = false;
    if (glyph) {
      const scale = Math.min((W * 0.34) / 24, (bh * 0.34) / 24);
      if (scale > 0) {
        const dw = 24 * scale;
        ctx.save();
        ctx.translate((W - dw) / 2, (bh - dw) / 2);
        ctx.scale(scale, scale);
        ctx.fillStyle = `#${glyph.hex}`;
        ctx.fill(new Path2D(glyph.path));
        ctx.restore();
        drawn = true;
      }
    } else if (photo) {
      drawFit(ctx, photo, 0, 0, W, bh, 0, 'contain');
      drawn = true;
    }
    if (!drawn) {
      // 系统图标 / 无图：大字首字直接落在柔底上（不再画白色圆底，避免又是一块白斑）
      ctx.fillStyle = C.accent;
      ctx.font = '700 220px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((g.name || '物').charAt(0), W / 2, bh / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
    // 图标区与文字区之间一条极轻的分隔（顶替原来的卡片描边）
    ctx.fillStyle = C.line;
    ctx.fillRect(0, bh, W, 1);
  }

  const onPhoto = fullBleed;
  const ink = onPhoto ? '#ffffff' : C.ink;
  const sub = onPhoto ? 'rgba(255,255,255,0.84)' : C.ink3;

  // 名称
  ctx.fillStyle = ink;
  ctx.font = '700 46px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(ellipsize(ctx, g.name || '未命名物品', cw), PAD, H - 148);

  // 一行数据：分类 · 价格 · 日均 · 陪伴
  const sym = symbolOf(g.currency);
  const metaParts = [
    categoryName ?? '',
    `${sym}${fmtMoney(Number(g.price ?? 0))}`,
    `日均 ${sym}${fmtMoney(dailyCost(g), true)}`,
    `陪伴 ${holdDays(g)} 天`,
  ].filter(Boolean);
  ctx.fillStyle = sub;
  ctx.font = '500 24px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(ellipsize(ctx, metaParts.join(' · '), cw), PAD, H - 100);

  // 品牌水印（右下，压得很轻，不抢主体）
  ctx.fillStyle = onPhoto ? 'rgba(255,255,255,0.5)' : 'rgba(38,48,44,0.32)';
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('纳物 NaWu', W - PAD, H - 44);
  ctx.textAlign = 'left';

  return cv.toDataURL('image/jpeg', 0.94);
}

/**
 * 置物墙整墙长图（★v1.6.2 重新设计）。
 *
 * 三列，图片是主体：每格 = 4:5 图 + 一行「名称 / 价格 + 极轻分类」。
 * 不再给每格套白色卡片 + 描边 + 内边距（旧版一层白卡再一层白图区，
 * 图片实际只占六成面积，四角全是泛白边）。
 */
export async function drawWallSheet(items: Array<{ g: Goods; categoryName: string | null }>): Promise<string> {
  const W = 900;
  const COLS = 3;
  const GAP = 22;
  const PAD = 40;
  const colW = (W - PAD * 2 - GAP * (COLS - 1)) / COLS;
  const imgH = Math.round(colW * 1.25); // 4:5
  const captionH = 64;
  const cardH = imgH + captionH;
  const rows = Math.max(1, Math.ceil(items.length / COLS));
  const headH = 168;
  const footH = 76;
  const H = headH + rows * (cardH + GAP) - GAP + footH;

  const cv = document.createElement('canvas');
  cv.width = Math.round(W * RW);
  cv.height = Math.round(H * RW);
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('画布不可用');
  ctx.scale(RW, RW);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);

  // 头部：标题 + 一行总账
  ctx.fillStyle = C.accent;
  ctx.fillRect(PAD, 56, 6, 44);
  ctx.fillStyle = C.ink;
  ctx.font = '700 42px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('置物墙', PAD + 22, 92);
  const total = items.reduce((acc, it) => acc + totalInvest(it.g), 0);
  const sym = symbolOf(items[0]?.g.currency);
  ctx.fillStyle = C.ink3;
  ctx.font = '500 22px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(
    `${items.length} 件在役 · 总投入 ${sym}${fmtMoney(total)} · 日均 ${sym}${fmtMoney(
      items.reduce((acc, it) => acc + dailyCost(it.g), 0),
      true,
    )}`,
    PAD + 22,
    130,
  );

  for (let i = 0; i < items.length; i += 1) {
    const one = items[i];
    const g = one.g;
    const cx = PAD + (i % COLS) * (colW + GAP);
    const cy = headH + Math.floor(i / COLS) * (cardH + GAP);

    const iconVal = goodsIconValue(g);
    const photo = await loadShareImage(iconVal);
    const glyph = iconVal.startsWith('brand:') ? glyphBySlug(iconVal.slice(6).trim()) : null;
    const cover = Boolean(photo) && iconFitMode(iconVal) === 'cover';

    if (!cover) {
      // 图标型：柔底（圆角），避免 logo 直接悬在纸面上没有边界感
      ctx.fillStyle = C.accentSoft;
      roundRect(ctx, cx, cy, colW, imgH, 20);
      ctx.fill();
    }
    let ok = false;
    if (glyph) {
      const scale = Math.min((colW * 0.5) / 24, (imgH * 0.5) / 24);
      if (scale > 0) {
        const dw = 24 * scale;
        ctx.save();
        ctx.translate(cx + (colW - dw) / 2, cy + (imgH - dw) / 2);
        ctx.scale(scale, scale);
        ctx.fillStyle = `#${glyph.hex}`;
        ctx.fill(new Path2D(glyph.path));
        ctx.restore();
        ok = true;
      }
    } else if (photo) {
      drawFit(ctx, photo, cx, cy, colW, imgH, 20, cover ? 'cover' : 'contain');
      ok = true;
    }
    if (!ok) {
      ctx.fillStyle = C.accent;
      ctx.font = `700 ${Math.round(colW * 0.34)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((g.name || '物').charAt(0), cx + colW / 2, cy + imgH / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    // 一行说明：名称（左）+ 价格（右）
    const baseY = cy + imgH + 30;
    const price = `${symbolOf(g.currency)}${fmtMoney(totalInvest(g))}`;
    ctx.font = '700 22px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    const priceW = Math.min(colW * 0.42, ctx.measureText(price).width + 4);
    ctx.textAlign = 'right';
    ctx.fillStyle = C.accent;
    ctx.fillText(price, cx + colW, baseY);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.ink;
    ctx.font = '500 22px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(ellipsize(ctx, g.name || '未命名', colW - priceW - 10), cx, baseY);
    if (one.categoryName) {
      // 分类只做极轻的副行，字号压到 18，不抢图
      ctx.fillStyle = C.ink3;
      ctx.font = '400 18px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText(ellipsize(ctx, one.categoryName, colW), cx, baseY + 26);
    }
  }

  // 页脚
  ctx.fillStyle = C.ink3;
  ctx.font = '400 18px system-ui, sans-serif';
  ctx.fillText(`由「纳物」生成 · ${new Date().toLocaleDateString('zh-CN')}`, PAD, H - 34);
  ctx.textAlign = 'right';
  ctx.fillText('NaWu', W - PAD, H - 34);
  ctx.textAlign = 'left';

  return cv.toDataURL('image/jpeg', 0.94);
}

/** 保存/分享策略（v1.0.16 重写；★v1.6.2 按 dataURL 的真实类型给 MIME）：
 *  原生 App → 直接写入系统相册「纳物」相册（MediaStore，无需任何存储权限）；
 *  网页端 → navigator.share 优先，失败回退 <a download>。
 *  分享卡现在是 JPEG（高清照片卡），若仍硬编码 image/png，部分系统分享面板
 *  会按错误类型处理（存成扩展名 png 的 JPEG / 个别相册识别失败）。 */
export async function shareOrDownload(
  dataUrl: string,
  fileName: string,
): Promise<'shared' | 'saved' | 'downloaded'> {
  const mime = /^data:([a-z0-9/+.-]+)[;,]/i.exec(dataUrl)?.[1] ?? 'image/png';
  if (Capacitor.isNativePlatform()) {
    try {
      const { Media } = await import('@capacitor-community/media');
      // 找「纳物」相册（App 关联相册，无需权限）；没有就建
      let albumId = '';
      try {
        const { albums } = await Media.getAlbums();
        albumId = albums.find((a) => a.name === ALBUM_NAME)?.identifier ?? '';
      } catch {
        /* ignore */
      }
      if (!albumId) {
        await Media.createAlbum({ name: ALBUM_NAME });
        const { albums } = await Media.getAlbums();
        albumId = albums.find((a) => a.name === ALBUM_NAME)?.identifier ?? '';
      }
      const base = fileName.replace(/\.(png|jpe?g)$/i, '');
      await Media.savePhoto({ path: dataUrl, albumIdentifier: albumId || undefined, fileName: base });
      return 'saved';
    } catch (e) {
      logger.warn('savePhoto failed, fallback to share/download', e);
      // 落相册失败 → 退回系统分享，再不行才下载
    }
  }
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], fileName, { type: mime });
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean; share?: (d: { files: File[] }) => Promise<void> };
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      await nav.share({ files: [file] });
      return 'shared';
    }
  } catch {
    /* 用户取消或不可用 → 下载 */
  }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  a.click();
  return 'downloaded';
}
