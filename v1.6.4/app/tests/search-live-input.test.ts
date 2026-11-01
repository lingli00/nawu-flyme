// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import LedgerPage from '../src/pages/LedgerPage';
import { useLiveInput } from '../src/lib/useLiveInput';
import { useDataStore, useSettingsStore } from '../src/store';
import { today } from '../src/lib/date';
import type { Category, ValueRecord } from '../src/types/entities';

/**
 * v1.3.5 · 「输入即搜」回归（用户反馈：输完「馒头」不搜，删掉一个字才搜）。
 *
 * 根因不是过滤逻辑，是**中文输入法选词提交时 input 事件可能不派发**（Android WebView），
 * React 侧 state 停在上一帧。修复是事件 + 150ms 轮询双保险（lib/useLiveInput.ts）。
 * 所以这里的核心用例是：**只改 DOM 值、一个事件都不派发**，搜索也必须在 150ms 内生效。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/** 等轮询兜底跑一轮（150ms 间隔 → 给到 260ms）。 */
async function waitPoll(): Promise<void> {
  await act(async () => {
    await sleep(260);
  });
}

function Harness({ onValue }: { onValue: (v: string) => void }): React.ReactNode {
  const [active] = useState(true);
  const ref = useLiveInput(onValue, active);
  return createElement('input', { ref, defaultValue: '', 'data-testid': 'kw' });
}

describe('useLiveInput · 事件丢失也能同步', () => {
  it('只改 DOM 值、不派发任何事件（模拟输入法吞掉 input）→ 150ms 内同步', async () => {
    const seen: string[] = [];
    act(() => root.render(createElement(Harness, { onValue: (v) => seen.push(v) })));
    const input = container.querySelector('input') as HTMLInputElement;

    input.value = '馒头';
    expect(seen).toHaveLength(0);
    await waitPoll();
    expect(seen).toEqual(['馒头']);
  });

  it('compositionend（输入法选词提交）立即同步', () => {
    const seen: string[] = [];
    act(() => root.render(createElement(Harness, { onValue: (v) => seen.push(v) })));
    const input = container.querySelector('input') as HTMLInputElement;

    input.value = '馒头';
    act(() => {
      input.dispatchEvent(new Event('compositionend', { bubbles: true }));
    });
    expect(seen).toEqual(['馒头']);
  });

  it('普通 input 事件立即同步，且同值不重复回调', async () => {
    const seen: string[] = [];
    act(() => root.render(createElement(Harness, { onValue: (v) => seen.push(v) })));
    const input = container.querySelector('input') as HTMLInputElement;

    input.value = '馒';
    act(() => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(seen).toEqual(['馒']);

    /* 值没变：轮询不能再触发一次（避免无谓重渲染） */
    await waitPoll();
    expect(seen).toEqual(['馒']);

    input.value = '馒头';
    act(() => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(seen).toEqual(['馒', '馒头']);
  });
});

describe('生活流搜索 · 输入即搜', () => {
  const catId = 'cl-food';
  const cat: Category = { id: catId, name: '餐饮', icon: 'utensils', kind: 'ledger', order: 0 };
  const rec = (id: string, note: string, amount: number): ValueRecord => ({
    id,
    type: 'expense',
    amount,
    currency: 'CNY',
    date: today(),
    categoryId: catId,
    judgement: 'xu',
    note,
    createdAt: new Date().toISOString(),
  });

  beforeEach(() => {
    useDataStore.setState({
      categories: [cat],
      valueRecords: [rec('r1', '买了馒头当早饭', 3), rec('r2', '地铁通勤', 4)],
    });
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, currency: 'CNY' },
    });
  });

  async function renderPage(): Promise<void> {
    await act(async () => {
      root.render(createElement(MemoryRouter, {}, createElement(LedgerPage)));
    });
  }

  function openSearch(): HTMLInputElement {
    const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '搜索') as
      | HTMLButtonElement
      | undefined;
    expect(btn).toBeTruthy();
    act(() => btn!.click());
    const input = document.querySelector('input[placeholder="搜索标题 / 备注 / 金额"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    return input!;
  }

  it('渲染两条记录后，输入「馒头」只剩匹配项（不派发任何事件）', async () => {
    await renderPage();
    expect(document.body.textContent).toContain('买了馒头当早饭');
    expect(document.body.textContent).toContain('地铁通勤');

    const input = openSearch();
    /* 关键：模拟输入法只把字写进 DOM，不派发 input —— 旧实现此时毫无反应 */
    input.value = '馒头';
    await waitPoll();

    expect(document.body.textContent).toContain('买了馒头当早饭');
    expect(document.body.textContent).not.toContain('地铁通勤');
  });

  it('继续输入 / 退格都实时更新，且能回到全部', async () => {
    await renderPage();
    const input = openSearch();

    input.value = '馒头';
    await waitPoll();
    expect(document.body.textContent).not.toContain('地铁通勤');

    input.value = '';
    await waitPoll();
    expect(document.body.textContent).toContain('地铁通勤');

    input.value = '地铁';
    await waitPoll();
    expect(document.body.textContent).toContain('地铁通勤');
    expect(document.body.textContent).not.toContain('买了馒头当早饭');
  });

  it('无匹配时给出明确空态（关键词原样回显）', async () => {
    await renderPage();
    const input = openSearch();
    input.value = '包子';
    await waitPoll();
    expect(document.body.textContent).toContain('没有匹配「包子」的记录');
  });
});
