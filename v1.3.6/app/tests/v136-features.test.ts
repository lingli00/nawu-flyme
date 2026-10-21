// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import SmartRecordDock from '../src/components/layout/SmartRecordDock';
import { openSmartRecord } from '../src/lib/smartRecordBus';
import { probeSpeech, speechErrorText, startSpeech } from '../src/lib/speechLocal';
import { setDriver } from '../src/storage/kv';
import { useDataStore } from '../src/store';
import { SEED_CATEGORIES } from '../src/storage/seed';
import type { Goods } from '../src/types/entities';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ★v1.3.6 三条用户反馈的回归（对话记一笔）：
 *  ① 二手买卖一体（买入 + 卖出 + 手续费/快递/杂费）要能一句话跑完并自动退役；
 *  ② 已提交的条目要能一键复制、点开就地改完重新识别；
 *  ③ 语音输入改为端侧识别（探测/降级文案），不再依赖云端。
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // 内存驱动：隔离持久化，避免上一条用例的数据串进来
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
    goods: [],
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
  vi.restoreAllMocks();
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

async function renderDock(): Promise<void> {
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(SmartRecordDock, { mode: 'mobile' })));
  });
  await act(async () => {
    openSmartRecord();
  });
}

async function send(text: string): Promise<void> {
  const input = inputByPlaceholder('一句话描述消费/心情');
  await act(async () => {
    input.value = text;
    btnByText('发送').click();
  });
}

async function flush(ms = 1200): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe('对话记一笔 · 二手买卖一体', () => {
  it('用户原句识别成一张「二手买卖」卡：入库 + 卖出信息都在', async () => {
    await renderDock();
    await send('买入N95笔记本360元，卖出560元，手续费费率千分之6、快递费20、额外费用10');

    const card = document.body.querySelector('section[aria-label="二手买卖识别预览"]');
    expect(card).not.toBeNull();
    // 不再是「没找到匹配的物品，请先入库」
    expect(card?.textContent).toContain('卖出信息');
    // 名称、买入、售价都带出来了
    expect(inputByPlaceholder('物品名').value).toBe('N95笔记本');
    // 手续费自动算：560 × 6‰ = 3.36
    expect(card?.textContent).toContain('3.36');
    // 净赚 = 560 − 360 − 3.36 − 20 − 10
    expect(card?.textContent).toContain('166.64');
  });

  it('点「入库并标记已售出」→ 物品退役 + 附加费用带名称 + 净赚进生活流', async () => {
    await renderDock();
    await send('买入N95笔记本360元，卖出560元，手续费费率千分之6、快递费20、额外费用10');

    await act(async () => {
      btnByText('入库并标记已售出').click();
    });
    await flush();

    const goods = useDataStore.getState().goods as Goods[];
    expect(goods).toHaveLength(1);
    expect(goods[0]?.name).toBe('N95笔记本');
    expect(goods[0]?.price).toBe(360);
    expect(goods[0]?.status).toBe('retired');
    expect(goods[0]?.sellPrice).toBe(560);
    // 三项费用都写进了物品的附加费用（名称 + 金额一个不少）
    expect(goods[0]?.extraFees).toEqual([
      { name: '手续费', amount: 3.36 },
      { name: '快递费', amount: 20 },
      { name: '杂费', amount: 10 },
    ]);

    const incomes = useDataStore.getState().valueRecords.filter((r) => r.type === 'income');
    expect(incomes).toHaveLength(1);
    expect(incomes[0]?.amount).toBe(166.64);
  });

  it('卡片留在原地显示已完成，不再「一闪就没」', async () => {
    await renderDock();
    await send('买入N95笔记本360元，卖出560元，手续费费率千分之6、快递费20、额外费用10');
    await act(async () => {
      btnByText('入库并标记已售出').click();
    });
    await flush();

    const card = document.body.querySelector('section[aria-label="二手买卖识别预览"]');
    expect(card?.getAttribute('data-done')).toBe('1');
    expect(card?.textContent).toContain('已完成');
  });
});

describe('对话记一笔 · 已提交条目复制 / 编辑', () => {
  it('每条用户消息下都有「复制」「编辑」两个入口', async () => {
    await renderDock();
    await send('买了包纸巾 花了10');
    await flush();

    expect(document.body.querySelector('button[aria-label="复制原文"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="编辑这条"]')).not.toBeNull();
  });

  it('复制：一键把原文放进剪贴板并给出反馈', async () => {
    // jsdom 没有 navigator.clipboard，走 execCommand 兜底
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: (c: string) => boolean }).execCommand = exec;

    await renderDock();
    await send('买了包纸巾 花了10');
    await flush();
    await act(async () => {
      btnByText('复制').click();
    });

    expect(exec).toHaveBeenCalledWith('copy');
    const chat = document.body.querySelector('aside[aria-label="对话记一笔"]');
    expect(chat?.textContent).toContain('已复制原文');
  });

  it('编辑：就地改一个数字，重新识别后按新内容出卡（不用整段重打）', async () => {
    await renderDock();
    await send('买了个键盘 花了399');
    await flush();

    // 点第一条用户消息的「编辑」
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="编辑这条"]')!.click();
    });
    const ta = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑这条内容"]');
    expect(ta).not.toBeNull();

    await act(async () => {
      ta!.value = '买了个键盘 花了 299';
    });
    await act(async () => {
      btnByText('重新识别').click();
    });
    await flush();

    // 会话里出现修改后的原文（历史气泡保留，可回溯）
    const chat = document.body.querySelector('aside[aria-label="对话记一笔"]');
    expect(chat?.textContent).toContain('花了 299');
    // 新卡片的金额按修改后的 299 走
    expect(inputByPlaceholder('0').value).toBe('299');
  });
});

describe('语音输入 · 端侧识别', () => {
  it('jsdom（既无原生插件也无 Web Speech）→ 探测为 none，明说不可用而不是装作在听', async () => {
    const probe = await probeSpeech();
    expect(probe).toEqual({ mode: 'none', onDevice: false });
    await expect(startSpeech({ onResult: () => undefined })).rejects.toThrow('unavailable');
  });

  it('错误文案不再把锅甩给「服务端 / 网络」', () => {
    expect(speechErrorText('unavailable', true)).toContain('离线语音引擎');
    expect(speechErrorText('not-allowed', true)).toContain('系统设置');
    expect(speechErrorText('network', true)).toContain('改用键盘输入');
    // 三处文案互不相同，便于用户对症处理
    const set = new Set([
      speechErrorText('unavailable', true),
      speechErrorText('not-allowed', true),
      speechErrorText('no-match', true),
    ]);
    expect(set.size).toBe(3);
  });

  it('网页端点「语音」不会再调用 Web Speech 之外的云端接口（源码层面锁死）', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const src = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'src',
        'components',
        'layout',
        'SmartRecordDock.tsx',
      ),
      'utf8',
    );
    // 面板本身不再直接 new SpeechRecognition，一律走 lib/speechLocal 统一分流
    expect(src).not.toMatch(/webkitSpeechRecognition/);
    expect(src).toContain("from '../../lib/speechLocal'");
  });
});
