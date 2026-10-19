// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import SmartRecordDock from '../src/components/layout/SmartRecordDock';
import { loadLearnedRules, loadLearnSamples, resetLearnedCache } from '../src/api/learnedRules';
import { setKV } from '../src/storage/kv';
import { K_LEARNED_RULES, K_LEARN_SAMPLES } from '../src/storage/keys';
import { useDataStore } from '../src/store';
import { SEED_CATEGORIES } from '../src/storage/seed';
import { addDays, today } from '../src/lib/date';

/**
 * ★v1.2.0 智能记录入口端到端（PRD 五、交互流程文字版时序）：
 *   点气泡 → 输入「刚买了个N95准系统笔记本 花了899」→ 弹确认卡片 →
 *   用户把大类改成「生活流」→ 确认保存 → 记录入库 + 自动学习该关键词簇。
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  resetLearnedCache();
  // KV 内存驱动是模块级单例，跨用例残留：先真正清空两个学习键再跑
  await setKV(K_LEARNED_RULES, []);
  await setKV(K_LEARN_SAMPLES, []);
  resetLearnedCache();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // 直接给数据仓库塞种子分类 + 清空业务集合（组件从 store 读，不走 hydration；
  // store 是模块级单例，跨用例必须重置，否则上一条用例的落库会串到下一用例）
  useDataStore.setState({
    categories: SEED_CATEGORIES,
    goods: [],
    valueRecords: [],
    subscriptions: [],
    moods: [],
    times: [],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function btnByText(text: string): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').includes(text) || b.getAttribute('aria-label') === text,
  );
  if (!btn) throw new Error(`按钮不存在: ${text}`);
  return btn as HTMLButtonElement;
}

function inputByPlaceholder(ph: string): HTMLInputElement {
  const el = [...document.body.querySelectorAll('input')].find((i) => (i.placeholder ?? '').includes(ph));
  if (!el) throw new Error(`输入框不存在: ${ph}`);
  return el as HTMLInputElement;
}

/** 卡片里的输入框值不在 textContent 里，按 placeholder 取 DOM 真值。 */
function cardInputValue(ph: string): string {
  return inputByPlaceholder(ph).value;
}

async function renderDock(): Promise<void> {
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(SmartRecordDock, { mode: 'mobile' })));
  });
}

/** 冲刷异步链路（落库有 300ms 防抖 + 串行写链，act 一次只 flush 一层微任务）。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 450));
  });
}

describe('SmartRecordDock · PRD 交互全流程', () => {
  it('气泡 → 输入 → 确认卡片 → 改大类 → 保存并自动学习', async () => {
    await renderDock();

    // 1) 点悬浮气泡 → 面板弹出
    await act(async () => {
      btnByText('智能记录').click();
    });
    expect(document.body.querySelector('aside[aria-label="智能记录"]')).not.toBeNull();

    // 2) 输入一句话 → 发送（本地规则解析，未配置 AI）
    const input = inputByPlaceholder('一句话描述消费/心情');
    await act(async () => {
      input.value = '刚买了个N95准系统笔记本 花了899';
      btnByText('发送').click();
    });

    // 3) 确认卡片出现，默认识别为 物品 · 数码（N95 + 共现词消歧）
    const card = document.body.querySelector('section[aria-label="识别记录预览"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('物品');
    expect(card?.textContent).toContain('数码');
    expect(cardInputValue('名称')).toBe('N95准系统笔记本');
    expect(cardInputValue('0')).toBe('899');

    // 4) 用户把大类改成「生活流」→ 确认保存
    await act(async () => {
      btnByText('生活流').click();
    });
    await act(async () => {
      btnByText('确认保存').click();
    });
    await flush();

    // 5) 记录入库（生活流一条）
    const records = useDataStore.getState().valueRecords;
    expect(records).toHaveLength(1);
    expect(records[0]?.amount).toBe(899);

    // 会话里给出「已学会」反馈
    const chat = document.body.querySelector('aside[aria-label="智能记录"]');
    expect(chat?.textContent).toContain('已学会');

    // 6) 自动学习：本地规则库多了一条「n95 → 生活流」规则 + 一条样本
    const rules = await loadLearnedRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.kind).toBe('ledger');
    expect(rules[0]?.keyword).toBe('n95');
    const samples = await loadLearnSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.text).toContain('N95准系统笔记本');
  });

  it('直接确认（不改分类）→ 保存但不学习', async () => {
    await renderDock();
    await act(async () => {
      btnByText('智能记录').click();
    });
    const input = inputByPlaceholder('一句话描述消费/心情');
    await act(async () => {
      input.value = '刚买了个N95准系统笔记本 花了899';
      btnByText('发送').click();
    });
    await act(async () => {
      btnByText('确认保存').click();
    });
    await flush();
    expect(useDataStore.getState().goods).toHaveLength(1);
    expect(useDataStore.getState().goods[0]?.categoryId).toBe('cg0');
    expect(await loadLearnedRules()).toHaveLength(0);
  });

  it('取消 → 不保存不学习', async () => {
    await renderDock();
    await act(async () => {
      btnByText('智能记录').click();
    });
    const input = inputByPlaceholder('一句话描述消费/心情');
    await act(async () => {
      input.value = '刚买了个N95准系统笔记本 花了899';
      btnByText('发送').click();
    });
    await act(async () => {
      btnByText('取消').click();
    });
    await flush();
    expect(useDataStore.getState().goods).toHaveLength(0);
    expect(await loadLearnedRules()).toHaveLength(0);
  });

  /* ---------- ★v1.2.0 迭代：查询 / 连发 / 顶卡 / 微信式底栏 ---------- */

  it('查询「昨天吃了什么」→ 本地数据回答，不弹记录卡', async () => {
    await renderDock();
    await act(async () => {
      btnByText('智能记录').click();
    });
    // 种子：昨天一笔餐饮 + 一条心情
    useDataStore.setState({
      valueRecords: [
        {
          id: 'v1',
          type: 'expense',
          amount: 25,
          currency: 'CNY',
          date: addDays(today(), -1),
          categoryId: 'cl0',
          judgement: 'xu',
          createdAt: '2026-10-18T02:00:00.000Z',
        },
      ],
      moods: [{ id: 'm1', feeling: '😄', text: '开心', crushed: false, inHeart: false, date: addDays(today(), -1) }],
    });
    const input = inputByPlaceholder('一句话描述消费/心情');
    await act(async () => {
      input.value = '昨天吃了什么';
      btnByText('发送').click();
    });
    await flush();
    // 不弹卡，会话里给出基于本地数据的回答
    expect(document.body.querySelector('section[aria-label="识别记录预览"]')).toBeNull();
    const chat = document.body.querySelector('aside[aria-label="智能记录"]');
    expect(chat?.textContent).toContain('昨天共 1 笔');
    expect(chat?.textContent).toContain('支出 ¥25');
    // 心情查询同样走回答
    await act(async () => {
      input.value = '昨天心情怎么样';
      btnByText('发送').click();
    });
    await flush();
    expect(chat?.textContent).toContain('心情记录 1 条');
    expect(chat?.textContent).toContain('😄 开心');
    // 查询不会落库
    expect(useDataStore.getState().valueRecords).toHaveLength(1);
  });

  it('连发两条：旧卡片被顶掉（不保存不学习），新消息照样识别出卡', async () => {
    await renderDock();
    await act(async () => {
      btnByText('智能记录').click();
    });
    const input = inputByPlaceholder('一句话描述消费/心情');
    // 第一条：出卡但不确认
    await act(async () => {
      input.value = '抽纸花了0.01元。';
      btnByText('发送').click();
    });
    await flush();
    expect(document.body.querySelector('section[aria-label="识别记录预览"]')).not.toBeNull();
    expect(useDataStore.getState().valueRecords).toHaveLength(0);

    // 第二条：不点取消，直接发新句子 → 旧卡按放弃处理，新卡立即出来
    await act(async () => {
      input.value = '买了包蓝利群花了39。';
      btnByText('发送').click();
    });
    await flush();
    const chat = document.body.querySelector('aside[aria-label="智能记录"]');
    expect(chat?.textContent).toContain('已放弃上一条未保存的识别');
    const card = document.body.querySelector('section[aria-label="识别记录预览"]');
    expect(card).not.toBeNull();
    expect(cardInputValue('名称')).toContain('蓝利群');

    // 确认第二条 → 只入库这一条，且不触发学习（分类没改）
    await act(async () => {
      btnByText('确认保存').click();
    });
    await flush();
    const rec = useDataStore.getState().valueRecords;
    expect(rec).toHaveLength(1);
    expect(rec[0]?.amount).toBe(39);
    expect(await loadLearnedRules()).toHaveLength(0);
  });

  it('双击发送防重：400ms 内同一文本只发一次', async () => {
    await renderDock();
    await act(async () => {
      btnByText('智能记录').click();
    });
    const input = inputByPlaceholder('一句话描述消费/心情');
    await act(async () => {
      input.value = '刚买了个N95准系统笔记本 花了899';
      btnByText('发送').click();
      btnByText('发送').click();
    });
    await flush();
    const bubbles = [...document.body.querySelectorAll('aside p')].filter(
      (p) => (p.textContent ?? '') === '刚买了个N95准系统笔记本 花了899',
    );
    expect(bubbles).toHaveLength(1);
  });

  it('多任务一起：一条消息问多个问题逐个回答（用户反馈 4）', async () => {
    await renderDock();
    await act(async () => {
      btnByText('智能记录').click();
    });
    // 种子：今天两笔物品（2026-10-19 是周一，「这周」只有今天）
    useDataStore.setState({
      goods: [
        {
          id: 'g1',
          name: '机械键盘',
          categoryId: 'cg0',
          tags: [],
          price: 599,
          currency: 'CNY',
          buyDate: today(),
          status: 'active',
          extraFees: [],
          incomes: [],
          createdAt: '2026-10-19T02:00:00.000Z',
          updatedAt: '2026-10-19T02:00:00.000Z',
        },
        {
          id: 'g2',
          name: '鼠标垫',
          categoryId: 'cg0',
          tags: [],
          price: 19,
          currency: 'CNY',
          buyDate: today(),
          status: 'active',
          extraFees: [],
          incomes: [],
          createdAt: '2026-10-19T02:00:00.000Z',
          updatedAt: '2026-10-19T02:00:00.000Z',
        },
      ],
    });
    const input = inputByPlaceholder('一句话描述消费/心情');
    await act(async () => {
      input.value = '这周买过最贵的东西是什么？最便宜的呢？';
      btnByText('发送').click();
    });
    await flush();
    const chat = document.body.querySelector('aside[aria-label="智能记录"]');
    // 两个问题都回答了（视频里只回第一句的缺陷）
    expect(chat?.textContent).toContain('机械键盘');
    expect(chat?.textContent).toContain('599');
    expect(chat?.textContent).toContain('鼠标垫');
    expect(chat?.textContent).toContain('19');
    // 纯查询不弹记录卡
    expect(document.body.querySelector('section[aria-label="识别记录预览"]')).toBeNull();
  });

  it('微信式底栏：语音/文字形态切换（按住说话）', async () => {
    await renderDock();
    await act(async () => {
      btnByText('智能记录').click();
    });
    expect(inputByPlaceholder('一句话描述消费/心情')).not.toBeNull();
    // 切到语音形态 → 出现「按住 说话」
    await act(async () => {
      btnByText('切换到语音输入').click();
    });
    expect(btnByText('按住 说话')).not.toBeUndefined();
    expect(document.body.querySelector('input[placeholder="一句话描述消费/心情"]')).toBeNull();
    // 识图按钮两种形态都在
    expect(btnByText('识图记账')).not.toBeUndefined();
    // 切回文字形态
    await act(async () => {
      btnByText('切换到文字输入').click();
    });
    expect(inputByPlaceholder('一句话描述消费/心情')).not.toBeNull();
  });
});
