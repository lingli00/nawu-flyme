// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GoodsFormSheet } from '../src/pages/HomePage';
import { useDataStore } from '../src/store';
import { SEED_CATEGORIES } from '../src/storage/seed';
import { setDriver } from '../src/storage/kv';
import type { Goods } from '../src/types/entities';

/* React 18 的 act 需要显式声明测试环境（与其它 jsdom 用例一致） */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ★v1.3.6 需求 4（恶性数据 Bug 回归）：
 * 「物品退役时新增的附加费用，保存后项目名称丢失，只剩金额」。
 *
 * 根因不是数据结构，而是**读值来源**：
 * 费用名称输入框只挂了 `onChange` 回写 state，而中文名称必然要过输入法——
 * Android WebView 在 IME 组合期常常不派发 change（本工程在物品名/备注上
 * 踩过同一个坑，v1.1.10 已改成「提交时读 DOM」）。金额是纯数字、不走 IME，
 * 所以「金额在、名称空」这个现象与用户描述完全吻合。
 *
 * 本用例刻意**不派发任何事件**，只改 DOM 的 value —— 模拟 onChange 漏发的机型，
 * 然后点保存，断言名称与金额都被持久化。
 */

let container: HTMLDivElement;
let root: Root;

function baseGoods(): Goods {
  return {
    id: 'g-fee-1',
    name: 'N95 笔记本',
    categoryId: 'cg0',
    tags: [],
    price: 360,
    currency: 'CNY',
    buyDate: '2026-10-01',
    status: 'active',
    extraFees: [],
    incomes: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  } as Goods;
}

beforeEach(async () => {
  const map = new Map<string, string>();
  setDriver({
    name: 'memory',
    async get(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
  });
  useDataStore.setState({
    categories: SEED_CATEGORIES,
    goods: [baseGoods()],
    valueRecords: [],
    subscriptions: [],
    moods: [],
    times: [],
    loaded: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function btnByText(text: string): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (!btn) throw new Error(`按钮不存在: ${text}`);
  return btn as HTMLButtonElement;
}

describe('物品详情 · 退役附加费用持久化', () => {
  it('IME 没触发 onChange，费用名称与金额也必须完整保存', async () => {
    await act(async () => {
      root.render(createElement(GoodsFormSheet, { initial: baseGoods(), onClose: () => undefined }));
    });

    // 打开编辑表单后新增一行附加费用
    await act(async () => {
      btnByText('添加附加费').click();
    });

    const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="说明（如运费）"]');
    expect(nameInput).toBeTruthy();
    const row = nameInput?.closest('div');
    const amountInput = row?.querySelectorAll('input')[1] as HTMLInputElement | undefined;
    expect(amountInput).toBeTruthy();

    // 关键：只改 DOM value，不派发 input/change（复现输入法组合期 onChange 漏发）
    await act(async () => {
      nameInput!.value = '运费';
      amountInput!.value = '20';
    });

    await act(async () => {
      btnByText('保存').click();
      await Promise.resolve();
    });

    const saved = useDataStore.getState().goods[0] as Goods;
    expect(saved.extraFees).toEqual([{ name: '运费', amount: 20 }]);
  });

  it('多行费用逐行对应，名称不会串到别的金额上', async () => {
    await act(async () => {
      root.render(createElement(GoodsFormSheet, { initial: baseGoods(), onClose: () => undefined }));
    });
    await act(async () => {
      btnByText('添加附加费').click();
      btnByText('添加附加费').click();
    });

    const names = [...document.querySelectorAll<HTMLInputElement>('input[placeholder="说明（如运费）"]')];
    expect(names).toHaveLength(2);
    const amounts = names.map(
      (n) => n.closest('div')?.querySelectorAll('input')[1] as HTMLInputElement,
    );

    await act(async () => {
      names[0]!.value = '手续费';
      amounts[0]!.value = '3.36';
      names[1]!.value = '快递费';
      amounts[1]!.value = '20';
    });

    await act(async () => {
      btnByText('保存').click();
      await Promise.resolve();
    });

    const saved = useDataStore.getState().goods[0] as Goods;
    expect(saved.extraFees).toEqual([
      { name: '手续费', amount: 3.36 },
      { name: '快递费', amount: 20 },
    ]);
  });

  it('删除中间一行后，剩下那行的名称不会串位', async () => {
    const withFees = baseGoods();
    withFees.extraFees = [
      { name: '运费', amount: 20 },
      { name: '保价', amount: 5 },
      { name: '包装', amount: 2 },
    ];
    useDataStore.setState({ goods: [withFees], categories: SEED_CATEGORIES });

    await act(async () => {
      root.render(createElement(GoodsFormSheet, { initial: withFees, onClose: () => undefined }));
    });

    // 删除中间那行「保价」
    await act(async () => {
      const delBtns = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="删除附加费"]')];
      delBtns[1]!.click();
    });

    await act(async () => {
      btnByText('保存').click();
      await Promise.resolve();
    });

    const saved = useDataStore.getState().goods[0] as Goods;
    expect(saved.extraFees).toEqual([
      { name: '运费', amount: 20 },
      { name: '包装', amount: 2 },
    ]);
  });
});
