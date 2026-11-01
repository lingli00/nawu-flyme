// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMaskDismiss } from '../src/lib/maskDismiss';

/**
 * ★v1.6.2 抽屉/弹层遮罩「点击外部关闭」的判定规则。
 *
 * 用户报的原始现象：在抽屉里长按拖拽选文字 / 粘贴，鼠标一出面板就整块关掉，
 * 编辑的内容全丢。根因是旧实现直接 `onClick={onClose}` —— 指针在面板内按下、
 * 在遮罩上抬起时，click 的 target 是共同祖先（遮罩），于是被当成「点外部」。
 *
 * 现在的规则：按下与抬起都必须落在遮罩本身，且过程中没有拖动（>8px）。
 */

let container: HTMLDivElement;
let root: Root;
let closed = 0;

function Overlay(): JSX.Element {
  const maskDismiss = useMaskDismiss(() => {
    closed += 1;
  });
  return createElement(
    'div',
    { 'data-testid': 'mask', ...maskDismiss },
    createElement('div', { 'data-testid': 'panel' }, '面板里的文字，可拖拽选中'),
  );
}

function fire(el: Element, type: string, x = 100, y = 100): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

const mask = (): HTMLElement => document.querySelector('[data-testid="mask"]') as HTMLElement;
const panel = (): HTMLElement => document.querySelector('[data-testid="panel"]') as HTMLElement;

beforeEach(() => {
  closed = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(Overlay)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('useMaskDismiss · v1.6.2 遮罩交互', () => {
  it('点击遮罩空白处 → 关闭', () => {
    act(() => {
      fire(mask(), 'pointerdown');
      fire(mask(), 'pointerup');
    });
    expect(closed).toBe(1);
  });

  it('面板内按下、拖到遮罩上松手（选文字溢出）→ 不关闭', () => {
    act(() => {
      fire(panel(), 'pointerdown');
      fire(mask(), 'pointerup');
    });
    expect(closed).toBe(0);
  });

  it('遮罩上按下但拖动了 40px（滑动/拖拽）→ 不关闭', () => {
    act(() => {
      fire(mask(), 'pointerdown', 100, 100);
      fire(mask(), 'pointermove', 140, 100);
      fire(mask(), 'pointerup', 140, 100);
    });
    expect(closed).toBe(0);
  });

  it('遮罩上按下、在面板内松手 → 不关闭', () => {
    act(() => {
      fire(mask(), 'pointerdown');
      fire(panel(), 'pointerup');
    });
    expect(closed).toBe(0);
  });

  it('面板内点击（冒泡到遮罩）→ 不关闭', () => {
    act(() => {
      fire(panel(), 'pointerdown');
      fire(panel(), 'pointerup');
    });
    expect(closed).toBe(0);
  });
});
