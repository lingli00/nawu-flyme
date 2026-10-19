// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import MainShell from '../src/components/layout/MainShell';

/**
 * ★v1.3.1 移动壳交互重构回归：
 * - 中央 FAB 手势：轻点/长按 → 动作菜单；按住右滑 → 对话面板（SmartRecordDock）；
 * - 主内容区左右横滑 → 四大 Tab 切页（边缘阻尼、纵向不抢、表单/横滑容器不参与）；
 * - 旧「AI 记一笔」独立页入口已移除（见 record-menu.test.ts）。
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

/** jsdom 无指针捕获实现，补桩避免 handler 抛错。 */
if (!Element.prototype.setPointerCapture) {
  (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
}

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

function fab(): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === '记一笔',
  );
  if (!btn) throw new Error('FAB 不存在');
  return btn as HTMLButtonElement;
}

function chatPanel(): Element | null {
  return document.body.querySelector('aside[aria-label="智能记录"]');
}

function menuPanel(): boolean {
  return (document.body.textContent ?? '').includes('记一笔，归一类');
}

/** 主内容区（滑页手势的载体）。 */
function mainEl(): HTMLElement {
  const el = document.body.querySelector('main');
  if (!el) throw new Error('main 不存在');
  return el as HTMLElement;
}

describe('MainShell · v1.3.1 FAB 手势（移动壳）', () => {
  it('轻点 FAB → 展开动作菜单', async () => {
    await renderShell();
    await act(async () => {
      fab().click();
    });
    expect(menuPanel()).toBe(true);
  });

  it('按住右滑 FAB → 打开对话面板，且不弹菜单', async () => {
    await renderShell();
    await act(async () => {
      firePtr(fab(), 'pointerdown', 200, 500);
      firePtr(fab(), 'pointermove', 260, 505); // 右滑 60px
      firePtr(fab(), 'pointerup', 260, 505);
    });
    expect(chatPanel()).not.toBeNull();
    expect(menuPanel()).toBe(false);
  });

  it('右滑后合成的 click 被压制（不会又把菜单弹出来）', async () => {
    await renderShell();
    await act(async () => {
      firePtr(fab(), 'pointerdown', 200, 500);
      firePtr(fab(), 'pointermove', 260, 505);
      firePtr(fab(), 'pointerup', 260, 505);
    });
    await act(async () => {
      fab().click(); // 真机上 pointerup 后会合成这个 click
    });
    expect(chatPanel()).not.toBeNull();
    expect(menuPanel()).toBe(false);
  });

  it('按住上滑 FAB → 展开动作菜单', async () => {
    await renderShell();
    await act(async () => {
      firePtr(fab(), 'pointerdown', 200, 500);
      firePtr(fab(), 'pointermove', 205, 440); // 上滑 60px
      firePtr(fab(), 'pointerup', 205, 440);
    });
    expect(menuPanel()).toBe(true);
    expect(chatPanel()).toBeNull();
  });

  it('按住所动（无划动）→ 长按也展开菜单（未发现滑动用户的兜底）', async () => {
    await renderShell();
    await act(async () => {
      firePtr(fab(), 'pointerdown', 200, 500);
      firePtr(fab(), 'pointerup', 202, 503); // 位移 < 阈值
    });
    expect(menuPanel()).toBe(true);
  });

  it('对话面板打开后，点「对话记一笔」卡（菜单内）先关菜单再开面板', async () => {
    await renderShell();
    await act(async () => {
      fab().click();
    });
    await act(async () => {
      const card = [...document.body.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('对话记一笔'),
      );
      card?.click();
    });
    expect(menuPanel()).toBe(false);
    expect(chatPanel()).not.toBeNull();
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

  it('从按钮上发起的手势不参与滑页', async () => {
    await renderShell();
    await act(async () => {
      firePtr(fab(), 'pointerdown', 200, 500);
      firePtr(fab(), 'pointermove', 100, 505); // 左滑 100px 但从 FAB 发起
      firePtr(fab(), 'pointerup', 100, 505);
    });
    expect(pathNow()).toBe('/home');
  });
});
