// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import WallPage from '../src/pages/WallPage';
import { useDataStore } from '../src/store';
import { SEED_CATEGORIES } from '../src/storage/seed';
import type { Goods } from '../src/types/entities';

/**
 * ★v1.6.2 置物墙重构的回归用例。
 *
 * 三条用户要求，逐条钉住：
 * 1. 直接复用物品页的数据与图片（不重复录入）→ 墙上渲染的就是 `goods.image` 那张图；
 * 2. 图片是主体、文字默认藏起来 → 默认 opacity-0，轻点后 opacity-100；
 * 3. 网格不再细长畸形 → 用容器自适应 auto-fill（不跟视口断点走）。
 */

let container: HTMLDivElement;
let root: Root;

function mkGoods(over: Partial<Goods> & Pick<Goods, 'id' | 'name'>): Goods {
  const base = {
    categoryId: 'cg0',
    tags: [],
    price: over.price ?? 2999,
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

const PHOTO = 'data:image/jpeg;base64,/9j/AAAAPHOTO';

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDataStore.setState({
    categories: SEED_CATEGORIES,
    goods: [
      mkGoods({ id: 'g1', name: '机械键盘', price: 899, image: { source: 'local', ref: PHOTO } }),
      mkGoods({ id: 'g2', name: '降噪耳机', price: 1299, image: { source: 'builtin', ref: 'headphones' } }),
      mkGoods({ id: 'g3', name: '已退役的旧手机', status: 'retired' }),
    ],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function renderWall(): Promise<void> {
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(WallPage)));
  });
}

describe('WallPage · v1.6.2 置物墙', () => {
  it('复用物品数据与图片，退役物品不上墙', async () => {
    await renderWall();
    const imgs = [...document.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    // 物品页的那张照片原样出现在墙上（不重新录入、不二次上传）
    expect(imgs).toContain(PHOTO);
    const tiles = document.querySelectorAll('[role="button"][aria-label]');
    const labels = [...tiles].map((t) => t.getAttribute('aria-label') ?? '').join('|');
    expect(labels).toContain('机械键盘');
    expect(labels).toContain('降噪耳机');
    expect(labels).not.toContain('已退役的旧手机');
  });

  it('文字默认隐藏，轻点图片后浮出', async () => {
    await renderWall();
    const tile = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find((el) =>
      (el.getAttribute('aria-label') ?? '').includes('机械键盘'),
    ) as HTMLElement;
    expect(tile).toBeTruthy();
    const overlay = tile.querySelector('div.pointer-events-none') as HTMLElement;
    expect(overlay.className).toContain('opacity-0');
    expect(overlay.textContent).toContain('机械键盘');
    expect(overlay.textContent).toContain('陪伴');

    await act(async () => {
      tile.click();
    });
    const after = tile.querySelector('div.pointer-events-none') as HTMLElement;
    expect(after.className).toContain('opacity-100');
  });

  it('网格用容器自适应列（auto-fill），不再按视口断点套 4~5 列', async () => {
    await renderWall();
    const grid = document.querySelector('ul[style*="grid-template-columns"]') as HTMLElement;
    expect(grid).toBeTruthy();
    expect(grid.getAttribute('style')).toContain('auto-fill');
    // 4:5 定比格子：细长畸形的直接原因就是格子高度不设限
    const tile = grid.querySelector('[role="button"]') as HTMLElement;
    expect(tile.className).toContain('aspect-[4/5]');
  });
});
