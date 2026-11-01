// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UiHost } from '../src/components/ui/UiHost';
import { useUiStore } from '../src/store/useUiStore';

/**
 * v1.3.5 · 确认弹窗布局回归（用户反馈：在线更新弹窗把「开始更新」按钮挤出屏幕）。
 *
 * 契约：
 * ① 弹窗自身有高度上限（≤86vh）——内容再长也不会比屏幕高；
 * ② 正文 / 文件明细放在**独立可滚动区域**里滚；
 * ③ 底部按钮是弹窗的第二段（兄弟节点），不在滚动区内 —— 永远可点。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  useUiStore.setState({ confirmRequest: null, toasts: [] });
});

/** 造 85 条待删文件路径（真实场景规模）。 */
const FILES = Array.from({ length: 85 }, (_, i) => `assets/demoSeed-${i}Qx.js`);

function openConfirm(detail?: string): void {
  act(() => {
    /* confirm 会一直挂着（没人点按钮），这里不 await。 */
    void useUiStore.getState().confirm({
      title: '更新到 v1.3.5？',
      message: '新增 17 个文件 · 更新 2 个 · 删除 85 个 · 保留 187 个。更新前自动备份。',
      detail,
      detailLabel: detail ? '将删除的 85 个旧版本遗留文件' : undefined,
      confirmText: '开始更新',
      danger: true,
    });
  });
}

describe('确认弹窗 · 长清单布局', () => {
  it('弹窗有高度上限，避免被长清单撑出屏幕', () => {
    act(() => root.render(createElement(UiHost)));
    openConfirm(FILES.join('\n'));

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog!.className).toContain('max-h-[min(86vh,44rem)]');
    expect(dialog!.className).toContain('flex-col');
    expect(dialog!.className).toContain('overflow-hidden');
  });

  it('正文与文件清单在独立的可滚动区域里', () => {
    act(() => root.render(createElement(UiHost)));
    openConfirm(FILES.join('\n'));

    const detail = [...document.querySelectorAll('pre')].find((p) => (p.textContent ?? '').includes('demoSeed-0Qx'))!;
    expect(detail).toBeTruthy();
    /* 清单 85 行必须完整渲染（不再截断成「…等共 85 个」） */
    expect((detail.textContent ?? '').split('\n')).toHaveLength(85);
    /* 清单自己是一层滚动，外层正文也是一层滚动 */
    expect(detail.className).toContain('overflow-auto');
    expect(detail.className).toContain('max-h-[38vh]');
    const scroller = detail.parentElement?.parentElement as HTMLElement;
    expect(scroller.className).toContain('overflow-y-auto');
    expect(scroller.className).toContain('min-h-0');
  });

  it('底部按钮不在滚动区内 —— 日志再长也点得到', () => {
    act(() => root.render(createElement(UiHost)));
    openConfirm(FILES.join('\n'));

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const buttons = [...dialog.querySelectorAll('button')];
    const confirmBtn = buttons.find((b) => (b.textContent ?? '').includes('开始更新'))!;
    const cancelBtn = buttons.find((b) => (b.textContent ?? '').includes('取消'))!;
    expect(confirmBtn).toBeTruthy();
    expect(cancelBtn).toBeTruthy();

    const detail = [...dialog.querySelectorAll('pre')].find((p) => (p.textContent ?? '').includes('demoSeed-0Qx'))!;
    const scroller = detail.parentElement?.parentElement as HTMLElement;
    expect(scroller.contains(confirmBtn)).toBe(false);
    expect(scroller.contains(cancelBtn)).toBe(false);

    /* 弹窗只有两段：滚动内容 + 固定按钮条 */
    const footer = confirmBtn.parentElement as HTMLElement;
    expect(footer.className).toContain('border-t');
    expect(footer.className).toContain('shrink-0');
    expect(dialog.children).toHaveLength(2);
    expect(dialog.children[1]).toBe(footer);
  });

  it('点按钮能正常返回结果（弹窗可交互）', () => {
    act(() => root.render(createElement(UiHost)));
    let resolved: boolean | null = null;
    act(() => {
      void useUiStore
        .getState()
        .confirm({ title: '确认？', message: '短正文', confirmText: '开始更新' })
        .then((ok) => {
          resolved = ok;
        });
    });
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('开始更新'))!;
    act(() => btn.click());
    return Promise.resolve().then(() => {
      expect(resolved).toBe(true);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  });
});
