import { describe, expect, it } from 'vitest';
import { goodsIconValue, goodsImageFromIcon, hasOwnIcon, isLocalImage, isWebImage } from '../src/lib/goodsIcon';

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
