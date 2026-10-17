import type { Goods } from '../types/entities';
import { Capacitor } from '@capacitor/core';
import { currentServer } from '../store';
import { iconCacheLookup } from './iconCache';
import { glyphBySlug } from './simpleBrand';
import { isValidDate } from './date';
import { goodsIconValue } from './goodsIcon';
import { dailyCost, goodsStatusLabel, holdDays, totalInvest } from '../domain/goods';
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

/** brand: 内置品牌 glyph 直绘（path 缩放居中，品牌色；v1.0.19 引用码渲染）。返回是否画了。 */
function drawBrandGlyph(
  ctx: CanvasRenderingContext2D,
  icon: string,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  const item = glyphBySlug(icon.slice(6).trim());
  if (!item) return false;
  const scale = Math.min((w * 0.84) / 24, (h * 0.84) / 24);
  if (!(scale > 0)) return false;
  const dw = 24 * scale;
  const dh = 24 * scale;
  ctx.save();
  ctx.translate(x + (w - dw) / 2, y + (h - dh) / 2);
  ctx.scale(scale, scale);
  ctx.fillStyle = `#${item.hex}`;
  ctx.fill(new Path2D(item.path));
  ctx.restore();
  return true;
}

/** 无真图时的兜底：柔和底色 + 名称首字。 */
function drawInitialFallback(
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  r = 0,
): void {
  if (r > 0) {
    ctx.fillStyle = C.accentSoft;
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
  }
  const rad = Math.min(w, h) * 0.24;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h / 2, rad, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.accent;
  ctx.font = `700 ${Math.round(rad)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((name || '物').charAt(0), x + w / 2, y + h / 2 + rad * 0.04);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
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

/**
 * 单物品海报（v1.0.17 重排版）。
 *
 * 版式：品牌头 → **整幅图区**（照片铺满、logo 居中）→ 名称 / 备注 / 标签胶囊
 * → 2×2 数据卡（总投入·日均·陪伴·购入）→ 页脚。
 * 数据口径与详情页一致，全部走 `domain/goods.ts` 的纯函数。
 */
export async function drawGoodsCard(g: Goods, categoryName: string | null): Promise<string> {
  const W = 900;
  const H = 1200;
  const PAD = 64;
  const CW = W - PAD * 2;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('画布不可用');

  const note = (g.note ?? '').trim();
  // 有备注时图区收一点，保证整版构图重心不变
  const cardY = 116;
  const cardH = note ? 540 : 580;
  const cardX = PAD;
  const cardW = CW;

  // 底 + 顶部品牌条
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.accent;
  ctx.fillRect(0, 0, W, 10);
  ctx.fillStyle = C.ink;
  ctx.font = '700 40px system-ui, sans-serif';
  ctx.fillText('纳物', PAD, 92);
  ctx.fillStyle = C.ink3;
  ctx.font = '400 24px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('值得的花销，值得记录', W - PAD, 92);
  ctx.textAlign = 'left';

  // ── 图区：整幅卡片，照片 cover 铺满 / logo contain 居中 ──
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, cardX, cardY, cardW, cardH, 32);
  ctx.fill();
  const iconVal = goodsIconValue(g);
  let drawn = false;
  if (iconVal.startsWith('brand:')) {
    drawn = drawBrandGlyph(ctx, iconVal, cardX, cardY, cardW, cardH);
  } else {
    const src = await resolveIconSrc(iconVal);
    if (src) {
      const img = await loadImage(src);
      if (img) {
        drawFit(ctx, img, cardX, cardY, cardW, cardH, 32, iconFitMode(iconVal));
        drawn = true;
      }
    }
  }
  if (!drawn) drawInitialFallback(ctx, g.name, cardX, cardY, cardW, cardH, 32);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  roundRect(ctx, cardX, cardY, cardW, cardH, 32);
  ctx.stroke();

  // ── 名称 ──
  let y = cardY + cardH + 74;
  ctx.fillStyle = C.ink;
  ctx.font = '700 54px system-ui, sans-serif';
  ctx.fillText(ellipsize(ctx, g.name || '未命名物品', CW), PAD, y);

  // ── 备注（一行） ──
  if (note) {
    y += 42;
    ctx.fillStyle = C.ink3;
    ctx.font = '400 24px system-ui, sans-serif';
    ctx.fillText(ellipsize(ctx, note, CW), PAD, y);
  }

  // ── 胶囊行：分类 / 状态 / 标签 ──
  const chipTop = y + 30;
  const chipH = 52;
  let cx = PAD;
  ctx.font = '500 24px system-ui, sans-serif';
  const putChip = (text: string, bg: string, fg: string): boolean => {
    const w = ctx.measureText(text).width + 40;
    if (cx + w > W - PAD) return false;
    ctx.fillStyle = bg;
    roundRect(ctx, cx, chipTop, w, chipH, chipH / 2);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.fillText(text, cx + 20, chipTop + chipH / 2 + 9);
    cx += w + 12;
    return true;
  };
  if (categoryName) putChip(categoryName, C.accentSoft, C.accent);
  putChip(goodsStatusLabel(g.status), '#eae7e0', g.status === 'retired' ? C.ink3 : '#4c5b53');
  for (const t of (g.tags ?? []).slice(0, 3)) {
    if (!putChip(`#${t}`, '#f0eee8', C.ink3)) break;
  }

  // ── 2×2 数据卡 ──
  const gap = 20;
  const cellW = (CW - gap) / 2;
  const cellH = 104;
  const gridY = chipTop + chipH + 42;
  const cells: Array<[string, string]> = [
    ['总投入', `¥${fmtMoney(totalInvest(g))}`],
    ['日均成本', `¥${fmtMoney(dailyCost(g), true)}`],
    ['已陪伴', `${holdDays(g)} 天`],
    ['购入于', isValidDate(g.buyDate) ? g.buyDate : '—'],
  ];
  cells.forEach(([label, val], i) => {
    const x = PAD + (i % 2) * (cellW + gap);
    const cy = gridY + Math.floor(i / 2) * (cellH + gap);
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, x, cy, cellW, cellH, 24);
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    roundRect(ctx, x, cy, cellW, cellH, 24);
    ctx.stroke();
    ctx.fillStyle = C.ink3;
    ctx.font = '400 22px system-ui, sans-serif';
    ctx.fillText(label, x + 24, cy + 40);
    ctx.fillStyle = C.ink;
    ctx.font = '700 36px system-ui, sans-serif';
    ctx.fillText(ellipsize(ctx, val, cellW - 48), x + 24, cy + 82);
  });

  // ── 页脚 ──
  ctx.fillStyle = C.ink3;
  ctx.font = '400 22px system-ui, sans-serif';
  ctx.fillText(`由「纳物」生成 · ${new Date().toLocaleDateString('zh-CN')}`, PAD, H - 44);
  ctx.textAlign = 'right';
  ctx.fillText('NaWu', W - PAD, H - 44);
  ctx.textAlign = 'left';

  return cv.toDataURL('image/png');
}

/**
 * 置物墙整墙海报（v1.0.11；v1.0.17 重排版）。
 * 900 宽三列网格，高度随物品数自适应；单卡 = 图区（照片 cover 铺满）+ 名称 + 价格/日均。
 */
export async function drawWallSheet(items: Array<{ g: Goods; categoryName: string | null }>): Promise<string> {
  const W = 900;
  const COLS = 3;
  const GAP = 20;
  const PAD = 48;
  const colW = (W - PAD * 2 - GAP * (COLS - 1)) / COLS;
  const imgH = Math.round(colW * 0.82);
  const cardH = imgH + 108;
  const rows = Math.max(1, Math.ceil(items.length / COLS));
  const headH = 216;
  const footH = 92;
  const H = headH + rows * (cardH + GAP) - GAP + footH;

  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('画布不可用');

  // 底 + 品牌条
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.accent;
  ctx.fillRect(0, 0, W, 12);

  // 头部
  ctx.fillStyle = C.ink;
  ctx.font = '700 52px system-ui, sans-serif';
  ctx.fillText('纳物 · 置物墙', PAD, 116);
  const total = items.reduce((acc, it) => acc + totalInvest(it.g), 0);
  ctx.fillStyle = C.ink3;
  ctx.font = '400 26px system-ui, sans-serif';
  ctx.fillText(
    `${items.length} 件在役 · 总投入 ¥${fmtMoney(total)} · 日均 ¥${fmtMoney(
      items.reduce((acc, it) => acc + dailyCost(it.g), 0),
      true,
    )}`,
    PAD,
    160,
  );
  ctx.font = '400 22px system-ui, sans-serif';
  ctx.fillText('NaWu · 值得的花销，值得记录', PAD, 196);

  // 卡片网格
  for (let i = 0; i < items.length; i += 1) {
    const cx = PAD + (i % COLS) * (colW + GAP);
    const cy = headH + Math.floor(i / COLS) * (cardH + GAP);
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, cx, cy, colW, cardH, 24);
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    roundRect(ctx, cx, cy, colW, cardH, 24);
    ctx.stroke();

    // 图区：照片铺满，logo 居中
    ctx.fillStyle = '#ffffff';
    const ix = cx + 14;
    const iy = cy + 14;
    const iw = colW - 28;
    const ih = imgH;
    const iconVal = goodsIconValue(items[i].g);
    let ok = false;
    if (iconVal.startsWith('brand:')) {
      ok = drawBrandGlyph(ctx, iconVal, ix, iy, iw, ih);
    } else {
      const src = await resolveIconSrc(iconVal);
      if (src) {
        const img = await loadImage(src);
        if (img) {
          drawFit(ctx, img, ix, iy, iw, ih, 16, iconFitMode(iconVal));
          ok = true;
        }
      }
    }
    if (!ok) drawInitialFallback(ctx, items[i].g.name, ix, iy, iw, ih, 16);

    // 名称
    const name = items[i].g.name || '未命名';
    ctx.fillStyle = C.ink;
    ctx.font = '600 24px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(ellipsize(ctx, name, colW - 28), cx + 14, cy + imgH + 44);
    // 价格 + 日均
    ctx.fillStyle = C.accent;
    ctx.font = '700 26px system-ui, sans-serif';
    const price = `¥${fmtMoney(totalInvest(items[i].g))}`;
    ctx.fillText(ellipsize(ctx, price, (colW - 28) * 0.55), cx + 14, cy + imgH + 82);
    ctx.fillStyle = C.ink3;
    ctx.font = '400 20px system-ui, sans-serif';
    const per = `日均 ¥${fmtMoney(dailyCost(items[i].g), true)}`;
    ctx.textAlign = 'right';
    ctx.fillText(ellipsize(ctx, per, (colW - 28) * 0.5), cx + colW - 14, cy + imgH + 82);
    ctx.textAlign = 'left';
  }

  // 页脚
  ctx.fillStyle = C.ink3;
  ctx.font = '400 20px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`由「纳物」生成 · ${new Date().toLocaleDateString('zh-CN')}`, W / 2, H - 30);
  ctx.textAlign = 'left';

  return cv.toDataURL('image/png');
}

/** 保存/分享策略（v1.0.16 重写）：
 *  原生 App → 直接写入系统相册「纳物」相册（MediaStore，无需任何存储权限）；
 *  网页端 → navigator.share 优先，失败回退 <a download>。
 *  ★旧实现 `<a download>` 在 App WebView 里既不弹下载也不进相册——
 *  用户看到「已保存」但相册永远是空的，本版根治。 */
export async function shareOrDownload(
  dataUrl: string,
  fileName: string,
): Promise<'shared' | 'saved' | 'downloaded'> {
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
      const base = fileName.replace(/\.png$/i, '');
      await Media.savePhoto({ path: dataUrl, albumIdentifier: albumId || undefined, fileName: base });
      return 'saved';
    } catch (e) {
      logger.warn('savePhoto failed, fallback to share/download', e);
      // 落相册失败 → 退回系统分享，再不行才下载
    }
  }
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], fileName, { type: 'image/png' });
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
