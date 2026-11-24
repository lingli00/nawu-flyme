import { useEffect, useMemo, useState } from 'react';
import type { Goods } from '../types/entities';
import { goodsIconView } from '../lib/goodsIcon';
import { glyphBySlug } from '../lib/simpleBrand';
import { GlyphImg, IconPreview, iconBaseOf, useCachedIconSrc } from './IconPicker';
import { isCloudImageUrl, resignBrokenUrl } from '../lib/imageCloud';

/**
 * 物品图片（★v1.6.2 置物墙重构）。
 *
 * 「置物墙直接复用物品页的图片」——这条要求的落点就在这里：**同一份
 * `goods.image`**（`goodsIconValue` 单一真相源），墙上不再另存一份、也不要求重录。
 *
 * 五形态：
 * - `img:` 实拍照片 / 商品图 → 铺满（cover），它是墙的视觉主体；
 * - `cloud:` 云端托管照片（★v1.8.0）→ 本地缩略图优先（离线也不空白），
 *   无缩略图时走网络层抓取；抓不到才灰底；
 * - `brand:` 内置品牌 glyph → 矢量直出，居中（contain + 留白）；
 * - `url:` 品牌图标 / 网络图标 → 走图标缓存链（App 内不直连），居中；
 * - 裸 lucide id → 系统图标居中；没有自定义图时由调用方给分类图标兜底。
 *
 * 照片与 logo 的铺法不同是刻意的：logo 铺满会被裁掉一截，看起来像糊图。
 */
function CachedUrlImg({ raw, alt }: { raw: string; alt: string }): JSX.Element {
  const chain = useMemo(() => {
    const list = [raw];
    if (raw.includes('api.iconify.design')) {
      const base = iconBaseOf();
      if (base) list.unshift(`${base}/api/icon/proxy?u=${encodeURIComponent(raw)}`);
    }
    return list;
  }, [raw]);
  const { src, done } = useCachedIconSrc(chain);
  const [broken, setBroken] = useState(false);
  if (broken || (done && !src)) return <span className="h-full w-full bg-surface-2" aria-hidden />;
  if (!src) return <span className="h-full w-full animate-pulse bg-surface-2" aria-hidden />;
  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      onError={() => setBroken(true)}
      className="h-full w-full object-contain p-[16%]"
    />
  );
}

/**
 * 云端照片（★v1.8.0）。
 *
 * 三级兜底，任何一级失败都不抛异常：
 *   ① 本地缩略图（seller 离线/弱网直接出图，零网络）；
 *   ② 网络原图 —— 先走图标缓存（App 走原生通道、不裸连 WebView），
 *      未命中就直接用 `<img src>`（浏览器/WebView 自己的 HTTP 缓存表现最好）；
 *   ③ 签名过期/404 时后台重签一次（服务器换密钥、URL 放很久都会走到这里），
 *      最终仍失败 → 灰底（不崩、不空白闪烁）。
 */
function CloudPhoto({ thumb, url, alt }: { thumb: string; url: string; alt: string }): JSX.Element {
  /** 网络地址（相对路径）；空 = 只能用缩略图。 */
  const netUrl = useMemo(() => url ?? '', [url]);
  const { src: cached, done } = useCachedIconSrc(useMemo(() => [netUrl], [netUrl]));
  const [broken, setBroken] = useState(false);
  const [retried, setRetried] = useState(false);

  useEffect(() => {
    setBroken(false);
    setRetried(false);
  }, [netUrl]);

  // ① 缩略图：永远优先（离线可用、不依赖签名是否过期）
  if (thumb) return <img src={thumb} alt={alt} draggable={false} className="h-full w-full object-cover" />;
  if (broken) return <span className="h-full w-full bg-surface-2" aria-hidden />;
  // ② 缓存命中（dataURL）直接出图
  if (cached) return <img src={cached} alt={alt} draggable={false} className="h-full w-full object-cover" />;
  // ③ 网络直出（无缓存且无网络地址 → 等缓存抓取结果，不给空 <img>）
  if (!netUrl) {
    if (!done) return <span className="h-full w-full animate-pulse bg-surface-2" aria-hidden />;
    return <span className="h-full w-full bg-surface-2" aria-hidden />;
  }
  return (
    <img
      src={netUrl}
      alt={alt}
      draggable={false}
      loading="lazy"
      decoding="async"
      className="h-full w-full object-cover"
      onError={() => {
        if (!retried && isCloudImageUrl(netUrl)) {
          setRetried(true);
          resignBrokenUrl(netUrl);
          return;
        }
        setBroken(true);
      }}
    />
  );
}

export default function GoodsPhoto({
  g,
  alt,
  /** 无自定义图时的兜底节点（通常是分类图标）。 */
  fallback,
}: {
  g: Goods;
  alt?: string;
  /** ★v1.7.7：AI API 导入的数据缺字段是常态，这里放宽为可选，组件内部一律 ?? 兜底 */
  fallback?: JSX.Element | null;
}): JSX.Element {
  /* ★v1.7.7：goodsIconView 保证 value/src 一定有值（空值走 'none'），
     旧写法 `v.startsWith('img:')` 在 v 为 undefined 时会直接崩。 */
  const v = useMemo(() => goodsIconView(g), [g]);
  const label = alt ?? g?.name ?? '';

  if (v.kind === 'img' && v.src) {
    return (
      <img
        src={v.src}
        alt={label}
        draggable={false}
        className="h-full w-full object-cover"
      />
    );
  }
  if (v.kind === 'cloud') return <CloudPhoto thumb={v.src} url={v.url} alt={label} />;
  if (v.kind === 'brand') {
    const glyph = glyphBySlug(v.value.slice(6).trim());
    if (glyph) {
      return (
        <span className="flex h-full w-full items-center justify-center" style={{ padding: '20%' }}>
          <GlyphImg item={glyph} size={64} />
        </span>
      );
    }
  }
  if (v.kind === 'url' && v.src) return <CachedUrlImg raw={v.src} alt={label} />;
  if (v.kind === 'builtin' && v.value) {
    return (
      <span className="flex h-full w-full items-center justify-center p-[18%]">
        <IconPreview icon={v.value} size={64} className="h-full w-full" />
      </span>
    );
  }
  return fallback ?? <span className="h-full w-full bg-surface-2" aria-hidden />;
}