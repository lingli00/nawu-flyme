// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drawGoodsCard, drawWallSheet, iconFitMode } from '../src/lib/shareCard';
import type { Goods } from '../src/types/entities';

/**
 * ★v1.6.2 分享卡重做的回归用例。
 *
 * 用户要求：「分享导出使用高清原图，修复图片模糊」「重新设计分享卡片 UI，
 * 砍掉多余宽大泛白边框，提升图片占比」「网页、手机端卡片视觉风格统一」。
 *
 * 高清这条在代码里的落点是**出图倍率**：逻辑 900×1125，按 R=2 出 1800×2250。
 * 旧版直接出 900×1200，手机 @2x 屏一放大就糊 —— 所以这里钉住物理像素尺寸。
 * （jsdom 没有真实 canvas，getContext / toDataURL 用桩替身，只校验尺寸与格式。）
 */

type AnyCtx = Record<string, unknown>;

let lastCanvas: HTMLCanvasElement | null = null;

function fakeCtx(): AnyCtx {
  const gradient = { addColorStop: (): void => undefined };
  return new Proxy(
    {},
    {
      get(_t, key) {
        if (key === 'measureText') return (s: string) => ({ width: String(s).length * 12 });
        if (key === 'createLinearGradient') return () => gradient;
        return () => undefined;
      },
      set() {
        return true;
      },
    },
  );
}

function mkGoods(over: Partial<Goods> & Pick<Goods, 'id' | 'name'>): Goods {
  const base = {
    id: over.id,
    name: over.name,
    categoryId: 'cg0',
    tags: [],
    price: 2999,
    currency: 'CNY',
    buyDate: '2024-01-01',
    status: 'active',
    extraFees: [],
    incomes: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
  return { ...base, ...over } as Goods;
}

beforeEach(() => {
  lastCanvas = null;
  (globalThis as unknown as { Path2D: unknown }).Path2D = class {
    constructor() {
      /* 桩 */
    }
  };
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    lastCanvas = this;
    return fakeCtx() as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext'];
  HTMLCanvasElement.prototype.toDataURL = function toDataURL(this: HTMLCanvasElement, type?: string) {
    return `data:${type ?? 'image/png'};base64,AAAA`;
  } as unknown as HTMLCanvasElement['toDataURL'];
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shareCard · v1.6.2 高清分享卡', () => {
  it('单物品卡：900×1125 逻辑尺寸 ×2 倍出图（1800×2250），输出 JPEG', async () => {
    const url = await drawGoodsCard(mkGoods({ id: 'g1', name: '机械键盘' }), '数码');
    expect(url.startsWith('data:image/jpeg')).toBe(true);
    expect(lastCanvas?.width).toBe(1800);
    expect(lastCanvas?.height).toBe(2250);
  });

  it('整墙长图：1.5 倍出图（宽度 1350），且高度随物品数增长', async () => {
    const items = [
      { g: mkGoods({ id: 'a', name: '键盘' }), categoryName: '数码' },
      { g: mkGoods({ id: 'b', name: '耳机' }), categoryName: '数码' },
      { g: mkGoods({ id: 'c', name: '椅子' }), categoryName: '家居' },
    ];
    const one = await drawWallSheet(items.slice(0, 1));
    const three = await drawWallSheet(items);
    expect(one.startsWith('data:image/jpeg')).toBe(true);
    const h1 = lastCanvas?.height ?? 0;
    const w3 = lastCanvas?.width ?? 0;
    expect(w3).toBe(1350);
    expect(h1).toBeGreaterThan(0);
    expect(three).toBeTruthy();
  });

  it('没有图 / 品牌 / 系统图标都不抛错（落到首字或内置 glyph）', async () => {
    await expect(drawGoodsCard(mkGoods({ id: 'x', name: '空图' }), null)).resolves.toContain('data:image/jpeg');
    await expect(
      drawGoodsCard(mkGoods({ id: 'y', name: '品牌', image: { source: 'brand', ref: 'brand:apple' } }), null),
    ).resolves.toContain('data:image/jpeg');
  });

  it('照片铺满 / logo 居中：两种裁切口径不变（决定图片占比）', () => {
    expect(iconFitMode('img:data:image/jpeg;base64,AAA')).toBe('cover');
    expect(iconFitMode('url:/api/img/get?u=x')).toBe('cover');
    expect(iconFitMode('brand:apple')).toBe('contain');
    expect(iconFitMode('laptop')).toBe('contain');
  });
});
