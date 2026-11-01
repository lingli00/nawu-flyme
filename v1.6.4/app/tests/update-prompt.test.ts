// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOT_CHECK_KEY,
  DISMISS_KEY,
  dismissedVersion,
  dismissVersion,
  markBootCheck,
  shouldBootCheck,
  shouldPromptUpdate,
} from '../src/lib/updatePrompt';

/**
 * ★v1.3.9 启动自动检查更新 + 全局提醒条的节流/去打扰逻辑。
 * 背景：APP 没有任何自动推送——检查更新只在进设置页时跑，用户不进设置
 * 就不知道有新版。现在启动 12h 节流静默检查 + 顶部提醒条，本文件守这些规则。
 */

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('启动检查节流', () => {
  it('从未检查过 → 应该检查', () => {
    expect(shouldBootCheck()).toBe(true);
  });

  it('刚检查过 → 不再检查', () => {
    markBootCheck();
    expect(shouldBootCheck()).toBe(false);
  });

  it('超过 12h 节流窗口 → 再次允许检查', () => {
    const past = Date.now() - 12 * 60 * 60 * 1000 - 1;
    localStorage.setItem(BOOT_CHECK_KEY, String(past));
    expect(shouldBootCheck()).toBe(true);
  });

  it('节流窗口内 → 不检查', () => {
    localStorage.setItem(BOOT_CHECK_KEY, String(Date.now() - 60_000));
    expect(shouldBootCheck()).toBe(false);
  });
});

describe('提醒条去打扰', () => {
  it('有可用更新且未关闭过 → 提醒', () => {
    expect(shouldPromptUpdate({ version: '1.3.8' })).toBe(true);
  });

  it('无可用更新 → 不提醒', () => {
    expect(shouldPromptUpdate(null)).toBe(false);
    expect(shouldPromptUpdate(undefined)).toBe(false);
  });

  it('用户关掉过当前版本 → 不再提醒', () => {
    dismissVersion('1.3.8');
    expect(dismissedVersion()).toBe('1.3.8');
    expect(shouldPromptUpdate({ version: '1.3.8' })).toBe(false);
  });

  it('发新版本后 → 重新提醒', () => {
    dismissVersion('1.3.8');
    expect(shouldPromptUpdate({ version: '1.3.9' })).toBe(true);
  });

  it('关闭记录写入独立的键，不污染节流键', () => {
    dismissVersion('1.3.8');
    expect(localStorage.getItem(DISMISS_KEY)).toBe('1.3.8');
    expect(localStorage.getItem(BOOT_CHECK_KEY)).toBeNull();
  });
});
