import { useMemo, useState } from 'react';
import type { Goods } from '../types/entities';
import { goodsIconValue } from '../lib/goodsIcon';
import { glyphBySlug } from '../lib/simpleBrand';
import { GlyphImg, IconPreview, iconBaseOf, useCachedIconSrc } from './IconPicker';

/**
 * 物品图片（★v1.6.2 置物墙重构）。
 *
 * 「置物墙直接复用物品页的图片」——这条要求的落点就在这里：**同一份
 * `goods.image`**（`goodsIconValue` 单一真相源），墙上不再另存一份、也不要求重录。
 *
 * 四形态：
 * - `img:` 实拍照片 / 商品图 → 铺满（cover），它是墙的视觉主体；
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

export default function GoodsPhoto({
  g,
  alt,
  /** 无自定义图时的兜底节点（通常是分类图标）。 */
  fallback,
}: {
  g: Goods;
  alt?: string;
  fallback?: JSX.Element;
}): JSX.Element {
  const v = goodsIconValue(g);
  const label = alt ?? g.name ?? '';

  if (v.startsWith('img:')) {
    return (
      <img
        src={v.slice(4).trim()}
        alt={label}
        draggable={false}
        className="h-full w-full object-cover"
      />
    );
  }
  if (v.startsWith('brand:')) {
    const glyph = glyphBySlug(v.slice(6).trim());
    if (glyph) {
      return (
        <span className="flex h-full w-full items-center justify-center" style={{ padding: '20%' }}>
          <GlyphImg item={glyph} size={64} />
        </span>
      );
    }
  }
  if (v.startsWith('url:')) return <CachedUrlImg raw={v.slice(4).trim()} alt={label} />;
  if (v) {
    return (
      <span className="flex h-full w-full items-center justify-center p-[18%]">
        <IconPreview icon={v} size={64} className="h-full w-full" />
      </span>
    );
  }
  return fallback ?? <span className="h-full w-full bg-surface-2" aria-hidden />;
}
