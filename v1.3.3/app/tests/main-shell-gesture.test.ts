// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import MainShell from '../src/components/layout/MainShell';
import { openSmartRecord } from '../src/lib/smartRecordBus';

/**
 * ★v1.3.2 移动壳交互回归：
 * - 中央 FAB 加号已移除（底栏回归纯净四页签）；
 * - 右下角常驻对话气泡已移除（面板只能由菜单/空态 CTA 唤起）；
 * - 新增「左右滑动切换页面」引导：新用户首次出现、6 秒自动收起、
 *   滑页后立刻消失，且看过一次不再出现；
 * - 主内容区左右横滑 → 四大 Tab 切页（边缘阻尼、纵向不抢、表单/横滑容器不参与）。
 */

let container: HTMLDivElement;
let root: Root;

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

/** 在元素上派发指针事件（jsdom 无 PointerEvent 构造器，用 MouseEvent 冒同等类型）。 */
function firePtr(el: Element, type: string, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

/** 路由探针：把当前 pathname 渲染出来（断言滑页是否发生）。 */
function PathProbe(): React.ReactNode {
  const { pathname } = useLocation();
  return createElement('span', { 'data-testid': 'path' }, pathname);
}

async function renderShell(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/home'] },
        createElement(MainShell, null, createElement(PathProbe)),
      ),
    );
  });
}

function pathNow(): string {
  return document.body.querySelector('[data-testid="path"]')?.textContent ?? '';
}

/** 中央加号（v1.3.1 的 FAB）应当彻底消失。 */
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

/** 主内容区（滑页手势的载体）。 */
function mainEl(): HTMLElement {
  const el = document.body.querySelector('main');
  if (!el) throw new Error('main 不存在');
  return el as HTMLElement;
}

/** 等引导气泡浮现（组件内 800ms 延迟）。 */
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
    expect(document.body.querySelector('aside[aria-label="对话记一笔"]')).toBeNull();
    // 唯一允许出现的浮层是「隐藏底栏」手柄与滑动引导，二者都不是对话入口
    const floats = [...document.body.querySelectorAll('button.fixed, div.fixed button')];
    expect(floats.some((b) => (b.getAttribute('aria-label') ?? '').includes('对话'))).toBe(false);
  });

  it('底栏只剩四个页签（不含加号占位）', async () => {
    await renderShell();
    const nav = document.body.querySelector('nav');
    expect(nav).not.toBeNull();
    expect(nav!.querySelectorAll('a')).toHaveLength(4);
    expect(nav!.querySelector('button')).toBeNull();
  });
});

describe('MainShell · v1.3.2 左右滑动引导', () => {
  it('新用户首次进入会看到「左右滑动切换页面」引导', async () => {
    await renderShell();
    expect(swipeGuide()).toBeNull(); // 首帧不闪
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
    await act(async () => {
      firePtr(mainEl(), 'pointerdown', 300, 300);
      firePtr(mainEl(), 'pointermove', 200, 305);
      firePtr(mainEl(), 'pointerup', 200, 305);
    });
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

describe('MainShell · v1.3.1 主内容区滑页（移动壳）', () => {
  it('左滑 → 切到下一个 Tab（/home → /ledger）', async () => {
    await renderShell();
    await act(async () => {
      firePtr(mainEl(), 'pointerdown', 300, 300);
      firePtr(mainEl(), 'pointermove', 200, 305); // 左滑 100px，纵向仅 5px
      firePtr(mainEl(), 'pointerup', 200, 305);
    });
    expect(pathNow()).toBe('/ledger');
  });

  it('右滑 → 切回上一个 Tab（/home → /ledger 后右滑回 /home）', async () => {
    await renderShell();
    await act(async () => {
      firePtr(mainEl(), 'pointerdown', 300, 300);
      firePtr(mainEl(), 'pointermove', 200, 305);
      firePtr(mainEl(), 'pointerup', 200, 305);
    });
    expect(pathNow()).toBe('/ledger');
    await act(async () => {
      firePtr(mainEl(), 'pointerdown', 100, 300);
      firePtr(mainEl(), 'pointermove', 220, 305);
      firePtr(mainEl(), 'pointerup', 220, 305);
    });
    expect(pathNow()).toBe('/home');
  });

  it('首页右滑（边缘）→ 橡皮筋阻尼，不导航', async () => {
    await renderShell();
    await act(async () => {
      firePtr(mainEl(), 'pointerdown', 100, 300);
      firePtr(mainEl(), 'pointermove', 220, 305);
      firePtr(mainEl(), 'pointerup', 220, 305);
    });
    expect(pathNow()).toBe('/home');
  });

  it('纵向滚动 → 不误判为滑页', async () => {
    await renderShell();
    await act(async () => {
      firePtr(mainEl(), 'pointerdown', 300, 300);
      firePtr(mainEl(), 'pointermove', 310, 220); // 纵向 80px 占主导
      firePtr(mainEl(), 'pointerup', 310, 220);
    });
    expect(pathNow()).toBe('/home');
  });

  it('位移不足触发阈值 → 回弹不切页', async () => {
    await renderShell();
    await act(async () => {
      firePtr(mainEl(), 'pointerdown', 300, 300);
      firePtr(mainEl(), 'pointermove', 260, 305); // 仅 40px < 64
      firePtr(mainEl(), 'pointerup', 260, 305);
    });
    expect(pathNow()).toBe('/home');
  });

  it('从链接/按钮上发起的手势不参与滑页', async () => {
    await renderShell();
    const tabLink = document.body.querySelector('nav a');
    expect(tabLink).not.toBeNull();
    await act(async () => {
      firePtr(tabLink!, 'pointerdown', 200, 500);
      firePtr(tabLink!, 'pointermove', 100, 505);
      firePtr(tabLink!, 'pointerup', 100, 505);
    });
    expect(pathNow()).toBe('/home');
  });
});
