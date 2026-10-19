// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import RecordMenu from '../src/components/RecordMenu';

/**
 * v1.0.28 · 锁定「就地弹层」契约（用户反馈：
 * ①报表页点心情/时间后跳去生活流页；②在对应页面添加东西不停留在对应界面）。
 *
 * 行为约定：
 * - 加号菜单的六类弹层（手动录入/新增订阅/购物冷静/心动清单/时间切片/情绪速写）
 *   一律就地打开（QuickSheetHost），不再跨路由导航，不写 sessionStorage 标志；
 * - 「AI 记一笔 / 价值记账」是页面导航，仍关菜单跳路由；
 * - 弹层关闭（保存/遮罩/返回键）→ 菜单一并关闭。
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

/** 宿主：open=false 时卸载菜单（真实触发 backGuard 卸载时序）。 */
function Host({ onClosed }: { onClosed?: () => void }): React.ReactNode {
  const [open, setOpen] = useState(true);
  return open
    ? createElement(RecordMenu, {
        onClose: () => {
          setOpen(false);
          onClosed?.();
        },
      })
    : null;
}

function findButton(text: string): HTMLButtonElement {
  // RecordMenu / QuickSheetHost 都走 createPortal 到 document.body
  const btn = [...document.body.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text));
  if (!btn) throw new Error(`按钮不存在: ${text}`);
  return btn as HTMLButtonElement;
}

async function renderMenu(route: string, onClosed?: () => void): Promise<void> {
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: [route] }, createElement(Host, { onClosed })));
  });
}

describe('RecordMenu · 结构（v1.0.24）', () => {
  it('AI 记一笔并入 2×2 记录卡（原 hero 已去掉，全菜单只有一个入口）', async () => {
    await renderMenu('/home');
    const hits = [...document.body.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes('AI 记一笔'));
    expect(hits.length).toBe(1);
    expect((document.body.textContent ?? '').includes('价值记账')).toBe(true);
    expect((document.body.textContent ?? '').includes('手动录入')).toBe(true);
    expect((document.body.textContent ?? '').includes('新增订阅')).toBe(true);
  });
});

describe('RecordMenu · 就地弹层（v1.0.28 / v1.1.6 整页化）', () => {
  it('新增订阅：就地打开整页表单，不跳路由、不写 sessionStorage 标志', async () => {
    await renderMenu('/ledger'); // 在非首页点击 → 仍应就地打开，不再跳 /home
    await act(async () => {
      findButton('新增订阅').click();
    });
    expect((document.body.textContent ?? '').includes('新增订阅')).toBe(true);
    expect(sessionStorage.getItem('gf.open.sub')).toBe(null);
  });

  it('生活流入口就地弹层：心动清单（不再跳 /ledger）', async () => {
    await renderMenu('/report');
    await act(async () => {
      findButton('心动清单').click();
    });
    expect((document.body.textContent ?? '').includes('心动清单')).toBe(true);
    expect(sessionStorage.getItem('gf.open.wish')).toBe(null);
  });

  it('四个记录卡统一弹出抽屉，点关闭 → 菜单一并关闭', async () => {
    let closed = false;
    await renderMenu('/home', () => {
      closed = true;
    });
    await act(async () => {
      findButton('新增订阅').click();
    });
    expect((document.body.textContent ?? '').includes('新增订阅')).toBe(true);
    // v1.1.7：新增订阅与 AI 记一笔/价值记账/手动录入统一为抽屉形态，右上角关闭
    const close = document.body.querySelector('button[aria-label="关闭"]') as HTMLButtonElement | null;
    expect(close).not.toBeNull();
    await act(async () => {
      close?.click();
    });
    // closeAll 延迟 60ms 关菜单
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(closed).toBe(true);
  });
});

/**
 * v1.1.7 桌面皮肤重构守护：桌面端只换材质，入口与表单字段必须与手机端一字不差。
 * 这条测试锁住「加号菜单 = 4 记录卡 + 4 生活流入口 + 取消」，
 * 以及四个记录抽屉里的关键字段 —— 防止以后为了「桌面优化」把东西做丢。
 */
describe('RecordMenu · 入口与字段完整性（桌面/手机同一套）', () => {
  const CARDS = ['AI 记一笔', '价值记账', '手动录入', '新增订阅'];
  const LIFE = ['购物冷静', '心动清单', '时间切片', '情绪速写'];

  it('加号菜单：4 张记录卡 + 4 个生活流入口 + 取消，一个不少', async () => {
    await renderMenu('/home');
    const txt = document.body.textContent ?? '';
    for (const t of [...CARDS, ...LIFE]) expect(txt).toContain(t);
    const hasCancel = [...document.body.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === '取消');
    expect(hasCancel).toBe(true);
  });

  it('价值记账抽屉：支出/收入、金额、归需否+稍后、分类、备注都在', async () => {
    await renderMenu('/home');
    await act(async () => {
      findButton('价值记账').click();
    });
    const txt = document.body.textContent ?? '';
    for (const t of ['支出', '收入', '这笔花得怎么样', '归', '需', '否', '稍后', '分类', '日期', '备注']) {
      expect(txt).toContain(t);
    }
    expect(document.body.querySelector('input[placeholder="买了什么？（可选）"]')).not.toBeNull();
  });

  it('手动录入抽屉：名称/价格/购买日期/图标/分类/备注都在', async () => {
    await renderMenu('/home');
    await act(async () => {
      findButton('手动录入').click();
    });
    const txt = document.body.textContent ?? '';
    expect(txt).toContain('物品入库');
    for (const t of ['名称', '价格', '购买日期', '图标', '分类', '备注']) expect(txt).toContain(t);
    expect(document.body.querySelector('input[placeholder="买了什么"]')).not.toBeNull();
  });
});

/**
 * v1.1.7 桌面皮肤重构守护：桌面端只换材质，入口与表单字段必须与手机端一字不差。
 * 这条测试锁住「加号菜单 = 4 记录卡 + 4 生活流入口 + 取消」，
 * 以及四个记录抽屉里的关键字段 —— 防止以后为了「桌面优化」把东西做丢。
 */
describe('RecordMenu · 入口与字段完整性（桌面/手机同一套）', () => {
  const CARDS = ['AI 记一笔', '价值记账', '手动录入', '新增订阅'];
  const LIFE = ['购物冷静', '心动清单', '时间切片', '情绪速写'];

  it('加号菜单：4 张记录卡 + 4 个生活流入口 + 取消，一个不少', async () => {
    await renderMenu('/home');
    const txt = document.body.textContent ?? '';
    for (const t of [...CARDS, ...LIFE]) expect(txt).toContain(t);
    const hasCancel = [...document.body.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === '取消');
    expect(hasCancel).toBe(true);
  });

  it('价值记账抽屉：支出/收入、金额、归需否+稍后、分类、备注都在', async () => {
    await renderMenu('/home');
    await act(async () => {
      findButton('价值记账').click();
    });
    const txt = document.body.textContent ?? '';
    for (const t of ['支出', '收入', '这笔花得怎么样', '归', '需', '否', '稍后', '分类', '日期', '备注']) {
      expect(txt).toContain(t);
    }
    expect(document.body.querySelector('input[placeholder="买了什么？（可选）"]')).not.toBeNull();
  });

  it('手动录入抽屉：名称/价格/购买日期/图标/分类/备注都在', async () => {
    await renderMenu('/home');
    await act(async () => {
      findButton('手动录入').click();
    });
    const txt = document.body.textContent ?? '';
    expect(txt).toContain('物品入库');
    for (const t of ['名称', '价格', '购买日期', '图标', '分类', '备注']) expect(txt).toContain(t);
    expect(document.body.querySelector('input[placeholder="买了什么"]')).not.toBeNull();
  });
});
