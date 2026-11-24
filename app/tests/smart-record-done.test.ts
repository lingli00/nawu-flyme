// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * ★v1.3.3 卡片完成态（用户反馈原话：
 * 「记录完成后卡片不消失，卡片上直接展示【已完成】状态，
 *   不再只靠顶部『已保存』提示，避免用户误以为未保存」）。
 *
 * 断言三件事：
 * 1. `done` 非空 → 顶部出现 role="status" 的【已完成】，且带完成文案；
 * 2. 所有输入/下拉/大类 chip 变 disabled（不能改一条已经落库的记录）；
 * 3. 底部按钮从「取消 / 确认保存」换成「下一条（剩 N 条）」/「完成」，
 *    且 `onConfirm` 在完成态下不会被再次触发。
 */

import SmartRecordCard, { type RecordCardState } from '../src/components/layout/SmartRecordCard';
import { SEED_CATEGORIES } from '../src/storage/seed';
import type { Category } from '../src/types/entities';

const CATS = SEED_CATEGORIES as Category[];

function state(): RecordCardState {
  const ledgerCats = CATS.filter((c) => c.kind === 'ledger');
  return {
    kind: 'ledger',
    categoryId: (ledgerCats[0] ?? CATS[0]).id,
    name: '午饭',
    amount: 25,
    date: '2026-10-19',
    note: '楼下小碗菜',
  };
}

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
});

function render(props: Parameters<typeof SmartRecordCard>[0]): void {
  act(() => root.render(createElement(SmartRecordCard, props)));
}

function click(el: Element | null): void {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('对话记一笔 · 卡片完成态', () => {
  it('未完成时：没有【已完成】、字段可编辑、底部是取消/确认保存', () => {
    render({ initial: state(), categories: CATS, onConfirm: () => undefined, onCancel: () => undefined });

    expect(container.querySelector('[role="status"]')).toBeNull();
    const inputs = [...container.querySelectorAll('input')];
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((i) => !i.disabled)).toBe(true);

    const text = container.textContent ?? '';
    expect(text).toContain('确认保存');
    expect(text).not.toContain('下一条');
  });

  it('完成态：顶部亮出【已完成】+ 完成文案，输入与下拉全部只读', () => {
    render({
      initial: state(),
      categories: CATS,
      onConfirm: () => undefined,
      onCancel: () => undefined,
      done: '已记入生活流 · 餐饮 · ¥25',
    });

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain('已完成');
    expect(container.textContent).toContain('已记入生活流 · 餐饮 · ¥25');

    for (const el of container.querySelectorAll('input, select')) {
      expect((el as HTMLInputElement | HTMLSelectElement).disabled).toBe(true);
    }
    // 大类 chip（物品/订阅/生活流）也锁住
    const chips = [...container.querySelectorAll('button')].filter((b) =>
      ['物品', '订阅', '生活流'].includes((b.textContent ?? '').trim()),
    );
    expect(chips).toHaveLength(3);
    for (const b of chips) expect((b as HTMLButtonElement).disabled).toBe(true);
    // 容器打了 data-done 标记（样式与测试都用它判定）
    expect(container.querySelector('[data-done="1"]')).not.toBeNull();
  });

  it('完成态不再给「确认保存」入口，避免重复落库', () => {
    const onConfirm = vi.fn();
    render({
      initial: state(),
      categories: CATS,
      onConfirm,
      onCancel: () => undefined,
      done: '已记入生活流 · 餐饮 · ¥25',
    });

    const text = container.textContent ?? '';
    expect(text).not.toContain('确认保存');
    expect(text).not.toContain('取消');
  });

  it('队列还有剩时显示「下一条（剩 N 条）」，点了调 onNext', () => {
    const onNext = vi.fn();
    render({
      initial: state(),
      categories: CATS,
      onConfirm: () => undefined,
      onCancel: () => undefined,
      done: '已记入生活流 · 餐饮 · ¥25',
      remaining: 2,
      onNext,
    });

    const btn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('下一条'));
    expect(btn).toBeDefined();
    expect(btn?.textContent).toContain('剩 2 条');
    click(btn ?? null);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('队列清空时只留「完成」，不再出现「下一条」', () => {
    render({
      initial: state(),
      categories: CATS,
      onConfirm: () => undefined,
      onCancel: () => undefined,
      done: '已记入生活流 · 餐饮 · ¥25',
      remaining: 0,
      onNext: () => undefined,
    });

    expect(container.textContent).not.toContain('下一条');
    expect(container.textContent).toContain('完成');
  });
});
