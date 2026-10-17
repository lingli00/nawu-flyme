// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectUrlRefKeys, slimCollectionsIcons } from '../src/lib/imageCompress';

/**
 * v1.0.24：备份瘦身链路补覆盖。
 * v1.0.22 给 WishItem / Cooldown 加 image 字段时是**裸 img: 字符串**形态，
 * 而 slimCollectionsIcons 只处理 goods.image.ref（对象）与 subscriptions.icon（字符串），
 * collectUrlRefKeys 同理漏收 —— 这两类大图会不压缩直接进备份（v1.0.19 修过的膨胀问题复发）。
 */

const BIG = 'img:data:image/jpeg;base64,' + 'A'.repeat(400 * 1024); // ≈282KB > 100KB 上限
const SMALL = 'data:image/jpeg;base64,SMALL';

const RealImage = global.Image;

beforeAll(() => {
  // jsdom 不解码 dataURL：替身 Image 立即触发 onload，带齐宽高
  // @ts-expect-error 测试替身
  global.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 800;
    naturalHeight = 600;
    width = 800;
    height = 600;
    set src(_v: string) {
      setTimeout(() => this.onload?.(), 0);
    }
  };
  // jsdom 无 canvas 2d：假 ctx + 固定小图输出
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext = () => ({ drawImage() {} });
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).toDataURL = () => SMALL;
});

afterAll(() => {
  global.Image = RealImage;
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext;
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).toDataURL;
});

describe('slimCollectionsIcons · 裸 img: 字符串字段（v1.0.24）', () => {
  it('心动清单 / 冷静池的 image 与 goods.image.ref、subscriptions.icon 一视同仁被压缩', async () => {
    const out = (await slimCollectionsIcons({
      wishlist: [{ id: 'w1', name: '想要', image: BIG, createdAt: '2026-10-14T10:00:00.000Z' }],
      cooldowns: [{ id: 'c1', name: '忍住', image: BIG, until: '2026-10-21', createdAt: '2026-10-14T10:00:00.000Z' }],
      goods: [{ id: 'g1', name: '已有', image: { source: 'file', ref: BIG } }],
      subscriptions: [{ id: 's1', name: '订阅', icon: BIG }],
    })) as Record<string, Array<Record<string, never>>>;
    expect(out.wishlist[0].image).toBe(`img:${SMALL}`);
    expect(out.cooldowns[0].image).toBe(`img:${SMALL}`);
    expect((out.goods[0].image as unknown as { ref: string }).ref).toBe(`img:${SMALL}`);
    expect(out.subscriptions[0].icon).toBe(`img:${SMALL}`);
  });

  it('非 img: 值（url: / brand: / 裸 id）原样透传，不误伤', async () => {
    const out = (await slimCollectionsIcons({
      wishlist: [
        { id: 'w1', image: 'url:/api/icon/img?d=abc' },
        { id: 'w2', image: 'brand:taobao' },
        { id: 'w3', image: undefined },
      ],
    })) as Record<string, Array<Record<string, never>>>;
    expect(out.wishlist[0].image).toBe('url:/api/icon/img?d=abc');
    expect(out.wishlist[1].image).toBe('brand:taobao');
    expect(out.wishlist[2].image).toBeUndefined();
  });
});

describe('collectUrlRefKeys · 裸 image 字符串（v1.0.24）', () => {
  it('心动清单 / 冷静池 image 的 url: 引用也进缓存导出白名单', () => {
    const keys = collectUrlRefKeys(
      {
        wishlist: [{ id: 'w1', image: 'url:/api/icon/img?d=abc' }],
        cooldowns: [{ id: 'c1', image: 'url:/api/icon/proxy?u=http%3A%2F%2Fx' }],
        goods: [{ id: 'g1', image: { source: 'net', ref: 'url:/api/icon/img?d=def' } }],
      },
      (s) => s,
    );
    expect(keys.has('/api/icon/img?d=abc')).toBe(true);
    expect(keys.has('/api/icon/img?d=def')).toBe(true);
    expect(keys.has('/api/icon/proxy?u=http%3A%2F%2Fx')).toBe(true);
  });
});
