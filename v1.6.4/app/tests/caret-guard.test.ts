// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import {
  autoGrowTextarea,
  preserveCaret,
  readCaret,
  writeCaret,
} from '../src/lib/caretGuard';
import SmartRecordDock from '../src/components/layout/SmartRecordDock';
import { setKV } from '../src/storage/kv';
import { K_LEARNED_RULES, K_LEARN_SAMPLES } from '../src/storage/keys';
import { resetLearnedCache } from '../src/api/learnedRules';
import { useDataStore } from '../src/store';
import { SEED_CATEGORIES } from '../src/storage/seed';
import { openSmartRecord } from '../src/lib/smartRecordBus';

/**
 * ★v1.6.4 回归：光标在文本中间输入/删除后不能跳到末尾。
 *
 * 用户复现步骤（原话）：
 *   输入一段文字 → 把光标点到文字中间 → 删一个字 / 打一个字 →
 *   期望光标停在编辑位置，实际直接跳到整句话最后。
 *
 * 两处成因，这里都要锁死：
 * ① 原生层 captureInput=true 让 Capacitor 换掉 Chromium 的 InputConnection
 *    （BaseInputConnection 不管输入法组合区，删字=整段重设 → 光标到末尾）；
 * ② JS 层输入时改 textarea 高度/值，Android WebView 会把选区重排到末尾。
 */

/* ------------------------------------------------------------------ *
 * 一、光标工具本身
 * ------------------------------------------------------------------ */

function makeTextarea(value: string): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = value;
  document.body.appendChild(el);
  return el;
}

describe('caretGuard · 读写光标', () => {
  it('readCaret 读到中间位置', () => {
    const el = makeTextarea('我不吃了');
    el.setSelectionRange(2, 2);
    expect(readCaret(el)).toEqual({ start: 2, end: 2 });
  });

  it('writeCaret 把位置夹到文本长度内（过滤后文本变短也不抛错）', () => {
    const el = makeTextarea('abc');
    el.setSelectionRange(0, 0);
    expect(writeCaret(el, { start: 99, end: 120 })).toBe(true);
    expect(el.selectionStart).toBe(3);
    expect(el.selectionEnd).toBe(3);
  });

  it('writeCaret 位置没变时不再调用 setSelectionRange（多余调用会打断输入法组合）', () => {
    const el = makeTextarea('abcd');
    el.setSelectionRange(2, 2);
    const spy = vi.spyOn(el, 'setSelectionRange');
    expect(writeCaret(el, { start: 2, end: 2 })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('preserveCaret：DOM 变更把光标甩到末尾后，同步恢复原位', () => {
    const el = makeTextarea('我吃了饭');
    el.setSelectionRange(1, 1);
    preserveCaret(el, () => {
      // 模拟浏览器重排：选区被顶到末尾
      el.setSelectionRange(el.value.length, el.value.length);
    });
    expect(el.selectionStart).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 二、自适应高度（当初每次输入都改 height，是光标乱跳的直接触发点）
 * ------------------------------------------------------------------ */

/** 给 jsdom 里没有布局的 textarea 装上「假布局」，用于驱动自适应分支。 */
function fakeLayout(
  el: HTMLTextAreaElement,
  opts: { box: number; client: number; scroll: number | (() => number) },
): void {
  Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => opts.box });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => opts.client });
  if (typeof opts.scroll === 'function') {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: opts.scroll });
  } else {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => opts.scroll });
  }
}

describe('caretGuard · 自适应高度不碰光标', () => {
  /** rAF 在测试里改成可控队列，便于断言「下一帧的二次恢复」。 */
  const rafQueue: FrameRequestCallback[] = [];
  beforeEach(() => {
    rafQueue.length = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const flushRaf = (): void => {
    while (rafQueue.length) rafQueue.shift()!(0);
  };

  it('单行输入（内容没超出一行）完全不动样式 —— 最高频路径零 DOM 变更', () => {
    const el = makeTextarea('我不吃了');
    el.setSelectionRange(2, 2);
    fakeLayout(el, { box: 42, client: 40, scroll: 40 });

    autoGrowTextarea(el);

    expect(el.style.height).toBe(''); // 一次都没写 height
    expect(el.selectionStart).toBe(2);
  });

  it('内容换行撑高时：高度变高，且光标仍在原来那一格（同步 + 下一帧各恢复一次）', () => {
    const el = makeTextarea('第一行很长很长的一句话');
    el.setSelectionRange(3, 3);
    // 读 scrollHeight 的那一刻模拟 WebView 重排把光标顶到末尾（真实机型就是这样）
    fakeLayout(el, {
      box: 42,
      client: 40,
      scroll: () => {
        el.setSelectionRange(el.value.length, el.value.length);
        return 88;
      },
    });

    autoGrowTextarea(el);

    // 高度按 border-box 计：scrollHeight(88) + 上下边框(2) = 90
    expect(el.style.height).toBe('90px');
    expect(el.selectionStart).toBe(3); // 同步恢复生效

    // 下一帧又被别处重排一次 → 二次恢复兜住
    el.setSelectionRange(el.value.length, el.value.length);
    flushRaf();
    expect(el.selectionStart).toBe(3);
  });

  it('删字后从多行收回单行：允许变矮，但光标不能跑', () => {
    const el = makeTextarea('只剩一行');
    // 单行高度由计算样式得出：行高 24 + 上下内边距 8×2 = 40（与真实样式同口径）
    el.style.lineHeight = '24px';
    el.style.paddingTop = '8px';
    el.style.paddingBottom = '8px';
    el.setSelectionRange(2, 2);
    let phase = 0;
    fakeLayout(el, {
      box: 88,
      client: 86,
      scroll: () => {
        // 第一次（当前高度）报告内容只有一行；设置为 auto 后再报告一次
        phase += 1;
        el.setSelectionRange(el.value.length, el.value.length);
        return phase === 1 ? 86 : 40;
      },
    });

    autoGrowTextarea(el);

    expect(el.style.height).toBe('42px');
    expect(el.selectionStart).toBe(2);
  });

  it('选中一段文字时，恢复的是选区而不是折叠光标', () => {
    const el = makeTextarea('我不吃了');
    el.setSelectionRange(1, 3);
    fakeLayout(el, { box: 42, client: 40, scroll: 80 });
    preserveCaret(el, () => {
      el.setSelectionRange(4, 4);
    });
    expect(readCaret(el)).toEqual({ start: 1, end: 3 });
  });
});

/* ------------------------------------------------------------------ *
 * 三、组件级复现：真实输入框 + 真实事件链路
 * ------------------------------------------------------------------ */

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  resetLearnedCache();
  await setKV(K_LEARNED_RULES, []);
  await setKV(K_LEARN_SAMPLES, []);
  resetLearnedCache();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
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
  vi.unstubAllGlobals();
});

/** 唤起「对话记一笔」面板，返回底部输入框。 */
async function openDockInput(): Promise<HTMLTextAreaElement> {
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(SmartRecordDock, { mode: 'mobile' })));
  });
  await act(async () => {
    openSmartRecord();
  });
  const el = [...document.body.querySelectorAll('textarea')].find((t) =>
    (t.placeholder ?? '').includes('一句话描述消费/心情'),
  );
  if (!el) throw new Error('没找到对话输入框');
  return el as HTMLTextAreaElement;
}

/** 派发一次真实 input 事件（React 的 onInput 走原生 input）。 */
function fireInput(el: HTMLTextAreaElement): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('对话记一笔输入框 · 中间编辑不跳末尾（v1.6.4 复现用例）', () => {
  const rafQueue: FrameRequestCallback[] = [];
  beforeEach(() => {
    rafQueue.length = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  });
  const flushRaf = (): void => {
    while (rafQueue.length) rafQueue.shift()!(0);
  };

  it('多次在中间删除、插入，光标始终停在编辑位置', async () => {
    const el = await openDockInput();
    fakeLayout(el, {
      box: 42,
      client: 40,
      scroll: () => {
        el.setSelectionRange(el.value.length, el.value.length); // 模拟重排
        return 42;
      },
    });

    // 初始：我吃了饭
    el.value = '我吃了饭';
    el.setSelectionRange(4, 4);
    fireInput(el);
    flushRaf();
    expect(el.selectionStart).toBe(4);

    // ① 中间插入「过」：我吃过饭
    el.value = '我吃过饭';
    el.setSelectionRange(3, 3);
    fireInput(el);
    flushRaf();
    expect(el.selectionStart).toBe(3);

    // ② 删掉中间一个字：我过饭（光标仍在第 2 格）
    el.value = '我过饭';
    el.setSelectionRange(2, 2);
    fireInput(el);
    flushRaf();
    expect(el.selectionStart).toBe(2);

    // ③ 句首插入
    el.value = '今天我过饭';
    el.setSelectionRange(3, 3);
    fireInput(el);
    flushRaf();
    expect(el.selectionStart).toBe(3);
  });

  it('选中一段文字整体替换后，光标停在替换处末尾', async () => {
    const el = await openDockInput();
    fakeLayout(el, {
      box: 42,
      client: 40,
      scroll: () => {
        el.setSelectionRange(el.value.length, el.value.length);
        return 42;
      },
    });

    el.value = '我吃了饭';
    el.setSelectionRange(1, 3); // 选中「吃了」
    fireInput(el);
    flushRaf();

    // 用户直接键入覆盖选区
    el.value = '我饱了饭';
    el.setSelectionRange(2, 2);
    fireInput(el);
    flushRaf();

    expect(el.selectionStart).toBe(2);
    expect(el.selectionEnd).toBe(2);
  });

  it('连续快速输入（连发多次 input）不会把光标推到末尾', async () => {
    const el = await openDockInput();
    fakeLayout(el, {
      box: 42,
      client: 40,
      scroll: () => {
        el.setSelectionRange(el.value.length, el.value.length);
        return 42;
      },
    });

    let text = '买了个键盘';
    el.value = text;
    el.setSelectionRange(1, 1);
    for (let i = 0; i < 8; i += 1) {
      text = `${text.slice(0, i + 1)}很${text.slice(i + 1)}`;
      el.value = text;
      el.setSelectionRange(i + 2, i + 2);
      fireInput(el);
    }
    flushRaf();

    expect(el.selectionStart).toBe(9);
    expect(el.selectionStart).not.toBe(el.value.length);
  });
});

/* ------------------------------------------------------------------ *
 * 四、源码护栏：这段逻辑后续迭代不许被删掉/注释掉
 * ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');

/** 去掉 TS/TSX 注释，避免注释里的反例命中断言。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('源码护栏 · 光标保护不允许被移除（v1.6.4 起长期有效）', () => {
  const dock = readFileSync(path.join(APP, 'src/components/layout/SmartRecordDock.tsx'), 'utf8');
  const guard = readFileSync(path.join(APP, 'src/lib/caretGuard.ts'), 'utf8');

  it('caretGuard.ts 必须保留「先存光标 → 恢复 → 下一帧再确认」三段', () => {
    const code = stripComments(guard);
    expect(code).toMatch(/export function readCaret/);
    expect(code).toMatch(/export function writeCaret/);
    expect(code).toMatch(/export function preserveCaret/);
    expect(code).toMatch(/requestAnimationFrame/); // 二次恢复，删了 Android 上就复发
    expect(code).toMatch(/setSelectionRange/);
  });

  it('对话输入框必须走 caretGuard 的自适应，禁止再写裸的 height 赋值', () => {
    const code = stripComments(dock);
    expect(code).toMatch(/from '\.\.\/\.\.\/lib\/caretGuard'/);
    expect(code).toMatch(/autoGrowTextarea/);
    // 旧写法：直接 el.style.height = `${el.scrollHeight}px`
    expect(code).not.toMatch(/\.style\.height\s*=\s*`?\$\{?\s*\w*\.?scrollHeight/);
  });

  it('输入框必须保持非受控（defaultValue），不能改成 value 受控', () => {
    const code = stripComments(dock);
    expect(code).toMatch(/ref=\{inputRef\}/);
    expect(code).toMatch(/defaultValue=""/);
  });

  it('原生层 captureInput 必须保持 false（改成 true 光标必跳末尾）', () => {
    const ts = stripComments(readFileSync(path.join(APP, 'capacitor.config.ts'), 'utf8'));
    expect(ts).toMatch(/captureInput:\s*false/);
    const json = JSON.parse(
      readFileSync(path.join(APP, 'android/app/src/main/assets/capacitor.config.json'), 'utf8'),
    ) as { android: { captureInput?: boolean } };
    expect(json.android.captureInput).toBe(false);
  });
});
