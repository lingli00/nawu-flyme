// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import MainShell from '../src/components/layout/MainShell';
import { openSmartRecord } from '../src/lib/smartRecordBus';

/**
 * 移动壳交互回归：
 * - v1.3.2 的界面减法与滑动引导（加号/气泡已移除、引导只出现一次）；
 * - ★v1.3.4 横滑改成**原生滚动吸附**：真机上 pointer 事件会被 pointercancel 打断，
 *   所以这里不再模拟 pointer，而是直接驱动 `scrollLeft` + `scroll` 事件，
 *   验证「停在哪就吸附到哪、半页以内回弹、手指未抬起不切路由」。
 */

let container: HTMLDivElement;
let root: Root;

/** 仿真宽度：jsdom 没有布局，clientWidth 恒为 0，必须手动钉住。 */
const W = 390;

beforeEach(() => {
  // jsdom 无 matchMedia：补桩（matches 恒 false → 走移动壳分支）
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  try {
    localStorage.clear();
  } catch {
    /* jsdom 隐私模式兜底 */
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

/** 路由探针：把当前 pathname 渲染出来（断言滑页是否发生）。 */
function PathProbe(): React.ReactNode {
  const { pathname } = useLocation();
  return createElement('span', { 'data-testid': 'path' }, pathname);
}

async function renderShell(tabPane?: (p: string) => React.ReactNode): Promise<void> {
  const props: { children: React.ReactNode; tabPane?: (p: string) => React.ReactNode } = {
    children: createElement(PathProbe),
  };
  if (tabPane) props.tabPane = tabPane;
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(MainShell, props)));
  });
  // 分页 track 在渲染后才有 clientWidth，钉成手机宽度
  const tr = trackEl();
  Object.defineProperty(tr, 'clientWidth', { configurable: true, get: () => W });
}

function pathNow(): string {
  return document.body.querySelector('[data-testid="path"]')?.textContent ?? '';
}

function fab(): HTMLButtonElement | null {
  const btn = [...document.body.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === '记一笔' && (b.className ?? '').includes('h-14'),
  );
  return (btn as HTMLButtonElement | undefined) ?? null;
}

function chatPanel(): Element | null {
  return document.body.querySelector('aside[aria-label="对话记一笔"]');
}

function swipeGuide(): Element | null {
  return document.body.querySelector('.nw-swipe-hint');
}

/** 分页器轨道（原生横向滚动 + 吸附的载体）。 */
function trackEl(): HTMLElement {
  const el = document.body.querySelector('.nw-pager-track');
  if (!el) throw new Error('.nw-pager-track 不存在');
  return el as HTMLElement;
}

/** 四页容器（顺序即 Tab 顺序）。 */
function panes(): HTMLElement[] {
  return [...document.body.querySelectorAll('.nw-pager-pane')] as HTMLElement[];
}

/** 模拟一次横向滚动停在 left 处，并等滚动结束判定（120ms 防抖）。
 *
 * `clearTouch`：切页用例要显式抬起"虚拟手指"（`onTouchStart` 把 touching 置 true，
 * 该标记只在 touch end/cancel 或滚动停稳定时器里清；之前这些用例只是碰巧赢了这个竞态）。
 * ★v1.8.0 bug1：启动期存在一个 6s 的滑页引导计时器，滚动停稳定时器会不断被它重置，
 * 所以在引导组件还挂着时多等一拍，避免 assert 时 scrollLeft 已被回弹到首页。 */
async function scrollTo(left: number, clearTouch = false): Promise<void> {
  const tr = trackEl();
  await act(async () => {
    if (clearTouch) tr.dispatchEvent(new Event('touchend'));
    tr.scrollLeft = left;
    tr.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 170));
    if (document.querySelector('.nw-swipe-hint')) {
      await new Promise((r) => setTimeout(r, 170));
    }
  });
}

async function waitGuide(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 850));
  });
}

describe('MainShell · v1.3.2 界面减法', () => {
  it('中央加号 FAB 已移除', async () => {
    await renderShell();
    expect(fab()).toBeNull();
  });

  it('右下角常驻对话气泡已移除（无面板时页面上没有悬浮按钮）', async () => {
    await renderShell();
    expect(chatPanel()).toBeNull();
    const floats = [...document.body.querySelectorAll('button.fixed, div.fixed button')];
    expect(floats.some((b) => (b.getAttribute('aria-label') ?? '').includes('对话'))).toBe(false);
  });

  it('底栏只剩四个页签（不含加号占位）', async () => {
    await renderShell();
    const nav = document.body.querySelector('nav');
    expect(nav).not.toBeNull();
    expect(nav!.querySelectorAll('a')).toHaveLength(4);
    // ★v1.8.0：折叠把手不再是 nav 的子按钮 —— 底栏本体真的只剩四个页签
    expect(nav!.querySelector('button')).toBeNull();
    // 把手外移到 nav 的兄弟节点（.nw-tabbar-wrap 内、nav 之外）
    const wrap = document.body.querySelector('.nw-tabbar-wrap');
    expect(wrap).not.toBeNull();
    const grip = wrap!.querySelector('button.nw-tabbar-grip');
    expect(grip).not.toBeNull();
    expect(grip!.getAttribute('aria-label')).toBe('隐藏底部导航');
    expect(wrap!.contains(nav)).toBe(true);
  });

  it('底栏折叠把手：拖拽超过 18px 会收起，再向上甩会展开', async () => {
    await renderShell();
    const wrap = () => document.body.querySelector('.nw-tabbar-wrap') as HTMLElement;
    const grip = () => wrap().querySelector('button.nw-tabbar-grip') as HTMLButtonElement;
    expect(wrap().hasAttribute('data-hidden')).toBe(false);

    /** 模拟一次 pointer 拖拽（jsdom 没有 PointerEvent，构造一个带 pointerId/clientY 的最小子集）。 */
    const drag = async (fromY: number, toY: number): Promise<void> => {
      const ev = (type: string, y: number): Event => {
        const e = new Event(type, { bubbles: true });
        Object.assign(e, { clientY: y, clientX: 100, pointerId: 7, button: 0, pointerType: 'touch' });
        return e;
      };
      await act(async () => {
        grip().dispatchEvent(ev('pointerdown', fromY));
        grip().dispatchEvent(ev('pointermove', toY));
        grip().dispatchEvent(ev('pointerup', toY));
        await new Promise((r) => setTimeout(r, 30));
      });
    };

    // 展开态向下甩 40px → 收起
    await drag(700, 740);
    expect(wrap().getAttribute('data-hidden')).toBe('true');
    expect(grip().getAttribute('aria-label')).toBe('显示底部导航');
    expect(localStorage.getItem('gf.tabbar.hidden')).toBe('1');

    // 折叠态向上甩 40px → 展开（先等过拖拽后的 click 屏蔽窗口）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 360));
    });
    await drag(740, 700);
    expect(wrap().hasAttribute('data-hidden')).toBe(false);
    expect(localStorage.getItem('gf.tabbar.hidden')).toBe('0');
  });

  it('拖拽位移不足 18px 不会翻转底部导航', async () => {
    await renderShell();
    const wrap = () => document.body.querySelector('.nw-tabbar-wrap') as HTMLElement;
    const grip = () => wrap().querySelector('button.nw-tabbar-grip') as HTMLButtonElement;
    await act(async () => {
      const ev = (type: string, y: number): Event => {
        const e = new Event(type, { bubbles: true });
        Object.assign(e, { clientY: y, clientX: 100, pointerId: 9, button: 0 });
        return e;
      };
      grip().dispatchEvent(ev('pointerdown', 700));
      grip().dispatchEvent(ev('pointermove', 708));
      grip().dispatchEvent(ev('pointerup', 708));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(wrap().hasAttribute('data-hidden')).toBe(false);
  });
});

describe('MainShell · v1.3.2 左右滑动引导', () => {
  it('新用户首次进入会看到「左右滑动切换页面」引导', async () => {
    await renderShell();
    expect(swipeGuide()).toBeNull();
    await waitGuide();
    expect(swipeGuide()).not.toBeNull();
    expect(swipeGuide()!.textContent).toContain('左右滑动切换页面');
  });

  it('引导 6 秒后自动收起，并记住「已看过」', async () => {
    await renderShell();
    await waitGuide();
    expect(swipeGuide()).not.toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 6200));
    });
    expect(swipeGuide()).toBeNull();
    expect(localStorage.getItem('gf.swipeGuide.seen')).toBe('1');
  }, 15000);

  it('已经看过的用户不再出现引导', async () => {
    localStorage.setItem('gf.swipeGuide.seen', '1');
    await renderShell();
    await waitGuide();
    expect(swipeGuide()).toBeNull();
  });

  it('成功滑页后引导立即消失', async () => {
    await renderShell();
    await waitGuide();
    expect(swipeGuide()).not.toBeNull();
    await scrollTo(W);
    expect(pathNow()).toBe('/ledger');
    expect(swipeGuide()).toBeNull();
  });

  it('引导不拦截触摸（pointer-events-none）', async () => {
    await renderShell();
    await waitGuide();
    expect(swipeGuide()!.className).toContain('pointer-events-none');
  });
});

describe('MainShell · v1.3.2 对话面板入口', () => {
  it('全局信号唤起面板：标题与入口文字一致（对话记一笔）', async () => {
    await renderShell();
    await act(async () => {
      openSmartRecord();
    });
    const panel = chatPanel();
    expect(panel).not.toBeNull();
    expect(panel!.textContent ?? '').toContain('对话记一笔');
  });
});

describe('MainShell · v1.3.4 原生滚动吸附分页器', () => {
  it('四页并排都在 DOM 里（可以拖到一半看邻页）', async () => {
    await renderShell();
    expect(panes()).toHaveLength(4);
    expect(trackEl().className).toContain('nw-pager-track');
  });

  it('吸附到第二页 → 路由切到 /ledger', async () => {
    await renderShell();
    await scrollTo(W);
    expect(pathNow()).toBe('/ledger');
  });

  it('来回滑动：第二页 → 回首页', async () => {
    await renderShell();
    await scrollTo(W);
    expect(pathNow()).toBe('/ledger');
    await scrollTo(0);
    expect(pathNow()).toBe('/home');
  });

  it('连续滑到最后一页（/me）', async () => {
    await renderShell();
    await scrollTo(W);
    await scrollTo(W * 2);
    await scrollTo(W * 3);
    expect(pathNow()).toBe('/me');
  });

  it('停在两页中间但不足半页 → 回弹到首页，不切路由', async () => {
    await renderShell();
    await scrollTo(W * 0.3);
    expect(pathNow()).toBe('/home');
  });

  it('正好过半页 → 吸附到下一页', async () => {
    await renderShell();
    await scrollTo(W * 0.55);
    expect(pathNow()).toBe('/ledger');
  });

  it('手指还在屏上时不切路由（松手才判定）', async () => {
    await renderShell();
    const tr = trackEl();
    await act(async () => {
      tr.dispatchEvent(new Event('touchstart', { bubbles: true }));
      tr.scrollLeft = W;
      tr.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 170));
    });
    expect(pathNow()).toBe('/home');
    await act(async () => {
      tr.dispatchEvent(new Event('touchend', { bubbles: true }));
      // 抬指后要等吸附动画走完才判定（实现里是 260ms 起算，事件再重置）
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(pathNow()).toBe('/ledger');
  });

  it('点底栏切页时 track 自动对齐到目标页', async () => {
    await renderShell();
    const links = [...document.body.querySelectorAll('nav a')] as HTMLAnchorElement[];
    await act(async () => {
      links[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(pathNow()).toBe('/report');
    expect(Math.round(trackEl().scrollLeft)).toBe(W * 2);
  });

  it('挂载当前页 + 左右邻页（不是全部四页）', async () => {
    // ★v1.8.2 「跟手滑动」恢复：为让拖到一半时看得到邻页真实内容，恢复邻页预挂，
    // 但只挂「当前页 + 左右邻页」，绝不挂全部四页（避免一次重渲染四棵页面树）。
    //   idx=0 → 挂 [0,1]，第 2/3 页保持空 section。
    //
    // ⚠️ 本用例**故意只传 children、不传 tabPane**：MainShell 里 tabPane 与 children 是互斥的
    // 两条渲染路径（生产用 tabPane，测试靠 children=<PathProbe> 读路由）。
    // 传了 tabPane 就看不到探针（pathNow() 返回 ''），所以这里走 children 路径验证门控。
    await renderShell();
    expect(pathNow()).toBe('/home');
    // 当前页 aria-hidden=false，其余三页 true（含已挂载的邻页——它可见但不可交互/不在无障碍树）。
    expect(panes().map((p) => p.getAttribute('aria-hidden'))).toEqual(['false', 'true', 'true', 'true']);
    // 首页(idx0)挂 [0,1]：pane0、pane1 有真实内容（下拉刷新层 + 页面树），pane2、pane3 空。
    expect(panes()[0].children.length).toBeGreaterThan(0);
    expect(panes()[1].children.length).toBeGreaterThan(0); // ★邻页已预挂真实内容
    expect(panes()[2].children.length).toBe(0); // 远页不挂
    expect(panes()[3].children.length).toBe(0);

    // 切到第 2 页(/ledger)：重新计算挂载窗口 → [0,1,2]，第 3 页仍不挂。
    await scrollTo(W, true);
    expect(pathNow()).toBe('/ledger');
    expect(panes()[0].children.length).toBeGreaterThan(0);
    expect(panes()[1].children.length).toBeGreaterThan(0);
    expect(panes()[2].children.length).toBeGreaterThan(0); // 新邻页挂上
    expect(panes()[3].children.length).toBe(0);
  });

  it('逐页滑到末页：访问过的页全部保持挂载（甩回不空白）', async () => {
    // ★v1.8.5：改的是「访问过就保持挂载」——用户从第1页逐页甩到第4页，再甩回去，
    // 途经的页必须一直有内容（否则快速甩回旧页会空白一两秒，用户实测报障）。
    await renderShell();
    await scrollTo(W, true);      // 到 /ledger（访问过 0,1）
    await scrollTo(W * 2, true);  // 到 /report（访问过 0,1,2）
    await scrollTo(W * 3, true);  // 到 /me（访问过 0,1,2,3）
    expect(pathNow()).toBe('/me');
    // 四页都被访问过 → 全部保持挂载，甩回任何一页都不会现挂现渲染。
    expect(panes()[0].children.length).toBeGreaterThan(0);
    expect(panes()[1].children.length).toBeGreaterThan(0);
    expect(panes()[2].children.length).toBeGreaterThan(0);
    expect(panes()[3].children.length).toBeGreaterThan(0);
  });
});
