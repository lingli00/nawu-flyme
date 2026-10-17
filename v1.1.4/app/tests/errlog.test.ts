// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  installGlobalErrorCapture,
  recordBoundaryError,
  recentErrors,
  clearErrors,
} from '../src/lib/errlog';

describe('errlog 全局错误捕获', () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
  });

  it('recordBoundaryError 记录并可在 recentErrors 读到（新→旧）', () => {
    recordBoundaryError(new Error('boom-1'));
    recordBoundaryError(new TypeError('boom-2'));
    const logs = recentErrors();
    expect(logs).toHaveLength(2);
    expect(logs[0].msg).toContain('boom-2');
    expect(logs[1].kind).toBe('boundary');
    expect(logs[0].page).toBeDefined();
  });

  it('错误摘要与堆栈被截断，超长不炸', () => {
    recordBoundaryError(new Error('x'.repeat(5000)));
    const [rec] = recentErrors();
    expect(rec.msg.length).toBeLessThanOrEqual(300);
    expect((rec.stack ?? '').length).toBeLessThanOrEqual(500);
  });

  it('installGlobalErrorCapture 幂等且捕获 window error', async () => {
    installGlobalErrorCapture();
    installGlobalErrorCapture();
    window.dispatchEvent(new ErrorEvent('error', { message: 'sync boom', error: new Error('sync boom') }));
    await new Promise((r) => setTimeout(r, 800)); // 等防抖落盘
    const logs = recentErrors();
    expect(logs.some((r) => r.msg.includes('sync boom'))).toBe(true);
    // 落盘内容可被再次加载（新会话可见）
    const raw = localStorage.getItem('flyme.errlog');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).length).toBeGreaterThan(0);
  });

  it('clearErrors 清空内存与落盘', () => {
    recordBoundaryError(new Error('to-clear'));
    clearErrors();
    expect(recentErrors()).toHaveLength(0);
    expect(localStorage.getItem('flyme.errlog')).toBeNull();
  });
});
