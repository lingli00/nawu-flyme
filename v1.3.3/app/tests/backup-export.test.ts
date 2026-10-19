import { describe, expect, it } from 'vitest';
import {
  isShareBusyError,
  SHARE_BUSY_FALLBACK_TEXT,
  SHARE_BUSY_RETRY_DELAY_MS,
  SHARE_DEFER_MS,
  shareWithRetry,
} from '../src/lib/backupExport';

/**
 * v0.7.1 修复：Android 分享面板并发冲突（"Can't share while sharing is in progress"）。
 * 覆盖：busy 错误识别、自动重试一次、重试仍失败给落盘兜底文案、非 busy 错误直通。
 */

/** 立即返回的假 sleep（记录调用参数）。 */
function fakeSleep(calls: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    calls.push(ms);
  };
}

describe('lib/backupExport · 分享重试（Android 面板并发冲突）', () => {
  it('isShareBusyError：识别 "Can\'t share while sharing is in progress"；其他错误不误判', () => {
    expect(isShareBusyError(new Error("Can't share while sharing is in progress"))).toBe(true);
    expect(isShareBusyError(new Error('Sharing is in progress'))).toBe(true);
    expect(isShareBusyError(new Error('Cancelled'))).toBe(false);
    expect(isShareBusyError('share failed')).toBe(false);
    expect(isShareBusyError(null)).toBe(false);
  });

  it('busy 错误 → 延迟后自动重试一次 → 成功', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await shareWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error("Can't share while sharing is in progress");
      },
      { sleep: fakeSleep(sleeps) },
    );
    expect(calls).toBe(2);
    expect(sleeps).toEqual([SHARE_BUSY_RETRY_DELAY_MS]);
  });

  it('重试仍 busy → 抛「文件已保存到 Documents」兜底文案（不丢导出结果）', async () => {
    const sleeps: number[] = [];
    const act = shareWithRetry(
      async () => {
        throw new Error("Can't share while sharing is in progress");
      },
      { retries: 1, sleep: fakeSleep(sleeps) },
    );
    await expect(act).rejects.toThrow(SHARE_BUSY_FALLBACK_TEXT);
    // 初次 + 重试 = 2 次调用，1 次延迟
    expect(sleeps.length).toBe(1);
  });

  it('非 busy 错误原样上抛，不重试不吞', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const act = shareWithRetry(
      async () => {
        calls++;
        throw new Error('Cancelled');
      },
      { sleep: fakeSleep(sleeps) },
    );
    await expect(act).rejects.toThrow('Cancelled');
    expect(calls).toBe(1);
    expect(sleeps.length).toBe(0);
  });

  it('时序常量：弹层关闭缓冲 300ms，busy 重试延迟 1200ms', () => {
    expect(SHARE_DEFER_MS).toBe(300);
    expect(SHARE_BUSY_RETRY_DELAY_MS).toBe(1200);
  });
});
