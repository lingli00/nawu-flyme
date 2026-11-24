import { describe, expect, it } from 'vitest';
import {
  goodsIconValue,
  goodsIconView,
  goodsImageFromIcon,
  hasOwnIcon,
  isBareBase64Image,
  isLocalImage,
  isWebImage,
  normalizeImageRef,
} from '../src/lib/goodsIcon';

/**
 * 物品图标三形态互转（v1.0.29 · 「系统图标选不中」回归）。
 * 旧行为：裸 lucide id → setImage(undefined)，用户点系统图标永远没反应。
 */
describe('goodsIcon · 图标互转', () => {
  it('内置 lucide id ↔ source:builtin 往返一致', () => {
    const img = goodsImageFromIcon('headphones');
    expect(img).toEqual({ source: 'builtin', ref: 'headphones' });
    expect(goodsIconValue({ image: img })).toBe('headphones');
    expect(hasOwnIcon({ image: img })).toBe(true);
  });

  it('url: / img: / brand: 三形态往返一致', () => {
    const web = goodsImageFromIcon('url:https://a.com/i.png');
    expect(web).toEqual({ source: 'web', ref: 'https://a.com/i.png' });
    expect(goodsIconValue({ image: web })).toBe('url:https://a.com/i.png');

    const local = goodsImageFromIcon('img:data:image/png;base64,AA');
    expect(local).toEqual({ source: 'local', ref: 'data:image/png;base64,AA' });
    expect(goodsIconValue({ image: local })).toBe('img:data:image/png;base64,AA');

    const brand = goodsImageFromIcon('brand:apple');
    expect(brand).toEqual({ source: 'brand', ref: 'brand:apple' });
    expect(goodsIconValue({ image: brand })).toBe('brand:apple');
  });

  it('空值 → 无自定义图标（回落分类图标）', () => {
    expect(goodsImageFromIcon('')).toBeUndefined();
    expect(goodsIconValue({})).toBe('');
    expect(goodsIconValue({ image: { source: 'system', ref: '' } })).toBe('');
    expect(hasOwnIcon({})).toBe(false);
  });

  it('旧数据兼容：source=web 的裸 URL 也能识别成 url:', () => {
    expect(goodsIconValue({ image: { source: 'web', ref: 'https://x.cn/f.ico' } })).toBe('url:https://x.cn/f.ico');
    expect(isWebImage({ image: { source: 'web', ref: 'https://x.cn/f.ico' } })).toBe(true);
  });

  it('本地图判定不把 builtin 误判成 web', () => {
    expect(isLocalImage({ image: { source: 'builtin', ref: 'cup' } })).toBe(false);
    expect(isWebImage({ image: { source: 'builtin', ref: 'cup' } })).toBe(false);
    expect(isLocalImage({ image: { source: 'local', ref: 'data:image/png;base64,AA' } })).toBe(true);
  });
});

/**
 * ★v1.7.7 「AI API 导入的物品图片不显示」根治。
 * 线上 11/19 条物品的 `image.ref` 是**裸 base64**（没有 `data:` 前缀），
 * 旧逻辑 `startsWith('data:')` 判不出本地图 → 返回空串 → 图片消失。
 */
describe('goodsIcon · 裸 base64 自愈（v1.7.7）', () => {
  /** 一段够长、字符集合法的假 base64（前缀 `/9j/` = JPEG 魔数）。 */
  const JPEG_B64 = `/9j/4AAQSkZJRgABAQAAAQABAAD${'A'.repeat(140)}`;
  const PNG_B64 = `iVBORw0KGgoAAAANSUhEUg${'B'.repeat(150)}`;

  it('isBareBase64Image：够长 + 字符集合法才算（短串/URL 不算）', () => {
    expect(isBareBase64Image(JPEG_B64)).toBe(true);
    expect(isBareBase64Image('AA')).toBe(false);
    expect(isBareBase64Image('https://a.com/x.jpg')).toBe(false);
    expect(isBareBase64Image('headphones')).toBe(false);
  });

  it('normalizeImageRef：裸 base64 自动补 data: 前缀（按魔数识别 jpeg/png）', () => {
    expect(normalizeImageRef(JPEG_B64)).toBe(`data:image/jpeg;base64,${JPEG_B64}`);
    expect(normalizeImageRef(PNG_B64)).toBe(`data:image/png;base64,${PNG_B64}`);
    // 已是 dataURL / URL / 空：原样（或空串）返回
    expect(normalizeImageRef('data:image/webp;base64,AA')).toBe('data:image/webp;base64,AA');
    expect(normalizeImageRef('https://a.com/x.jpg')).toBe('https://a.com/x.jpg');
    expect(normalizeImageRef('')).toBe('');
  });

  it('goodsIconValue：裸 base64 → img:<dataURL>（不再返回空串）', () => {
    const v = goodsIconValue({ image: { source: 'system', ref: JPEG_B64 } });
    expect(v).toBe(`img:data:image/jpeg;base64,${JPEG_B64}`);
    expect(v.startsWith('img:data:image/')).toBe(true);
    expect(isLocalImage({ image: { source: 'system', ref: JPEG_B64 } })).toBe(true);
    expect(isLocalImage({ image: { ref: JPEG_B64 } } as never)).toBe(true); // 连 source 都没有（导入数据常见）
    // 反向转换一致：补全后的 dataURL 能被 goodsImageFromIcon 原样吃回去
    expect(goodsImageFromIcon(v)).toEqual({ source: 'local', ref: `data:image/jpeg;base64,${JPEG_B64}` });
    // 裸 base64 直接当 icon 字符串传进来也要能收
    expect(goodsImageFromIcon(JPEG_B64)).toEqual({ source: 'local', ref: `data:image/jpeg;base64,${JPEG_B64}` });
  });

  it('字符串型 image 也兼容（"https://…" / "data:…" / 裸 base64）', () => {
    expect(goodsIconValue({ image: 'https://a.com/x.jpg' as never })).toBe('url:https://a.com/x.jpg');
    expect(goodsIconValue({ image: 'data:image/png;base64,AA' as never })).toBe('img:data:image/png;base64,AA');
    expect(isLocalImage({ image: 'data:image/png;base64,AA' as never })).toBe(true);
    expect(isWebImage({ image: 'https://a.com/x.jpg' as never })).toBe(true);
    expect(goodsIconValue('brand:apple' as never)).toBe('brand:apple');
  });

  it('brand / url / builtin 分支行为不变', () => {
    expect(goodsIconValue({ image: { source: 'brand', ref: 'brand:apple' } })).toBe('brand:apple');
    expect(goodsIconValue({ image: { source: 'web', ref: 'https://a.com/i.png' } })).toBe('url:https://a.com/i.png');
    expect(goodsIconValue({ image: { source: 'builtin', ref: 'cup' } })).toBe('cup');
  });

  it('goodsIconView：空值 / 缺字段一律给 string，绝不让 .startsWith 崩', () => {
    for (const g of [undefined, null, {}, { image: undefined }, { image: { source: '', ref: '' } }]) {
      const v = goodsIconView(g as never);
      expect(typeof v.value).toBe('string');
      expect(v.kind).toBe('none');
      expect(v.src).toBe('');
    }
    const img = goodsIconView({ image: { source: 'system', ref: JPEG_B64 } });
    expect(img.kind).toBe('img');
    expect(img.src).toBe(`data:image/jpeg;base64,${JPEG_B64}`);
    // img: 后面为空 → 不当作 img（回落兜底，而不是渲染空 src）
    expect(goodsIconView({ image: { source: 'local', ref: '' } } as never).kind).toBe('none');
  });
});
