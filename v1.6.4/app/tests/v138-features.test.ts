// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GoodsFormSheet } from '../src/pages/HomePage';
import TradeRecordCard from '../src/components/layout/TradeRecordCard';
import { useDataStore } from '../src/store';
import { SEED_CATEGORIES } from '../src/storage/seed';
import { setDriver } from '../src/storage/kv';
import { fmtTimestamp } from '../src/lib/date';
import { searchGoods } from '../src/lib/itemMatch';
import type { Goods } from '../src/types/entities';
import type { TradeDraft } from '../src/types/ai';

/* React 18 的 act 需要显式声明测试环境 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ★v1.3.8 五项体验修复的回归用例：
 * - 2.1 物品编辑：手续费费率自动折算（费率 × 出售价 → extraFees）
 * - 2.3 光标跳位：数字输入非受控，中间插入字符 DOM 值不被回写
 * - 2.4 更新时间：日期粒度的 publishedAt 不再显示成 00:00
 * - 2.5 物品搜索：分词 + 同义别名（美光内存条 → 镁光DDR4 8G）
 */

let container: HTMLDivElement;
let root: Root;

function baseGoods(): Goods {
  return {
    id: 'g-138',
    name: 'N95 笔记本',
    categoryId: 'cg0',
    tags: [],
    price: 100,
    currency: 'CNY',
    buyDate: '2026-10-01',
    status: 'retired',
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

/** 找到 PageField（label>span 标题结构）标题对应的输入框。 */
function inputAfterLabel(labelText: string): HTMLInputElement {
  const nodes = [...document.querySelectorAll('label > span')];
  for (const n of nodes) {
    if ((n.textContent ?? '').includes(labelText)) {
      const field = n.closest('label');
      const input = field?.querySelector<HTMLInputElement>('input');
      if (input) return input;
    }
  }
  throw new Error(`找不到字段: ${labelText}`);
}

/** React 受控/非受控输入都能触发的 onChange 派发。 */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('v1.3.8 · 更新时间显示', () => {
  it('日期粒度的 publishedAt 原样展示日期，不再伪造 00:00', () => {
    expect(fmtTimestamp('2026-10-21')).toBe('10-21');
    expect(fmtTimestamp('2026-10-21')).not.toContain('00:00');
  });

  it('完整 ISO 时间正常显示到分', () => {
    const out = fmtTimestamp('2026-10-21T16:35+08:00');
    expect(out).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('v1.3.8 · 物品搜索：分词 + 同义别名', () => {
  const list = [
    { id: 'a', name: '镁光DDR4 8G', tags: [], note: '', status: 'active' },
    { id: 'b', name: '罗技鼠标', tags: [], note: '', status: 'active' },
    { id: 'c', name: 'N95笔记本准系统 粉色', tags: [], note: '', status: 'active' },
  ];

  it('「美光内存条」能命中「镁光DDR4 8G」（品牌别名 + 内存条≈DDR）', () => {
    const hits = searchGoods(list, '美光内存条');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.item.id).toBe('a');
  });

  it('「美光的DDR4」也能命中同一件（虚词不干扰）', () => {
    const hits = searchGoods(list, '美光的DDR4');
    expect(hits[0]?.item.id).toBe('a');
  });

  it('不相关的搜索不串味', () => {
    const hits = searchGoods(list, '键盘');
    expect(hits.find((h) => h.item.id === 'a')).toBeUndefined();
  });

  it('在役物品排在退役物品前面', () => {
    const withRetired = [{ ...list[1], status: 'retired' }, list[0]];
    const hits = searchGoods(withRetired, '鼠标');
    expect(hits[0]?.item.id).toBe('b');
  });
});

describe('v1.3.8 · 物品编辑：手续费费率自动折算', () => {
  it('填费率保存后：feeRatePermille 落库，手续费金额按售价折算进 extraFees', async () => {
    await act(async () => {
      root.render(createElement(GoodsFormSheet, { initial: baseGoods(), onClose: () => undefined }));
    });

    const rateInput = document.querySelector<HTMLInputElement>('input[aria-label="手续费费率（百分比）"]');
    expect(rateInput).toBeTruthy();
    const sellInput = inputAfterLabel('出售价');

    await act(async () => {
      setNativeValue(sellInput, '200');
      setNativeValue(rateInput!, '2.1');
    });
    await act(async () => {
      btnByText('保存').click();
      await Promise.resolve();
    });

    const saved = useDataStore.getState().goods[0] as Goods;
    expect(saved.feeRatePermille).toBe(21);
    expect(saved.sellPrice).toBe(200);
    expect(saved.extraFees).toEqual([{ name: '手续费', amount: 4.2 }]);
  });

  it('旧数据只有手续费金额时，编辑面板按售价反推费率', async () => {
    const legacy = baseGoods();
    legacy.sellPrice = 200;
    legacy.extraFees = [{ name: '手续费', amount: 4.2 }];
    useDataStore.setState({ goods: [legacy] });

    await act(async () => {
      root.render(createElement(GoodsFormSheet, { initial: legacy, onClose: () => undefined }));
    });
    const rateInput = document.querySelector<HTMLInputElement>('input[aria-label="手续费费率（百分比）"]');
    expect(rateInput?.value).toBe('2.1');
  });
});

describe('v1.3.8 · 二手买卖卡：数字输入不再回写改写值（光标跳位根因）', () => {
  const trade: TradeDraft = {
    name: 'N95 笔记本',
    buyPrice: 360,
    sellPrice: 560,
    buyDate: '2026-10-21',
    currency: 'CNY',
    categoryId: '',
    feeRatePermille: 6,
    feeAmount: 0,
    shippingFee: 20,
    extraFee: 10,
    note: '测试',
  };

  function renderCard(): void {
    act(() => {
      root.render(
        createElement(TradeRecordCard, {
          initial: trade,
          categories: SEED_CATEGORIES,
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }),
      );
    });
  }

  it('在中间插入带非法字符的内容，DOM 保持用户输入原样（不被回写顶到末尾）', () => {
    renderCard();
    const buy = document.querySelector<HTMLInputElement>('input[aria-label="买入价"]');
    expect(buy).toBeTruthy();

    // 用户把光标放中间，输入了带杂质的文本 → 旧实现 React 会把 replace 后的值写回 DOM
    act(() => {
      setNativeValue(buy!, '12a3');
    });
    expect(buy!.value).toBe('12a3'); // DOM 原样保留 → 光标不会被顶走

    // 净赚/手续费的计算用的是净化后的数值
    act(() => {
      // jsdom 的 el.blur() 不派发 focusout，React onBlur 监听的是 focusout
      buy!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(buy!.value).toBe('123'); // 失焦才规整 DOM
  });

  it('费率与快递费预填值正常显示（预填 + 核对模式）', () => {
    renderCard();
    const rate = document.querySelector<HTMLInputElement>('input[aria-label="手续费费率（千分之）"]');
    const ship = document.querySelector<HTMLInputElement>('input[aria-label="快递费"]');
    expect(rate?.value).toBe('6');
    expect(ship?.value).toBe('20');
  });
});
