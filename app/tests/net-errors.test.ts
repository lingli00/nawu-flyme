import { describe, expect, it } from 'vitest';
import { ApiError, isApiError } from '../src/lib/error';
import {
  classifyFetchError,
  classifyNativeError,
  classifyStatus,
} from '../src/net/errors';
import { request } from '../src/net/httpClient';

/** 捕获 Promise 抛出的错误。 */
async function capture(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (isApiError(e)) return e;
    throw new Error(`期望 ApiError，实际是：${String(e)}`);
  }
  throw new Error('期望抛错，但调用成功了');
}

describe('net/errors · 六类错误分类', () => {
  it('invalid_url / network / http 三类文案互不相同（验收 4）', async () => {
    // ① 地址不合法
    const invalid = await capture(request({ url: 'abc' }, { path: '/api/health', timeoutMs: 2000 }));
    // ② 连不上（本机 127.0.0.1:1 必然拒绝连接）
    const unreachable = await capture(
      request({ url: 'http://127.0.0.1:1' }, { path: '/api/health', timeoutMs: 2000, retry: 0 }),
    );
    // ③ 接口异常（有状态码但非 2xx）
    const httpErr = classifyStatus(404, { ok: false, error: '' });

    expect(invalid.kind).toBe('invalid_url');
    expect(unreachable.kind).toBe('network');
    expect(httpErr.kind).toBe('http');

    const messages = [invalid.message, unreachable.message, httpErr.message];
    expect(new Set(messages).size).toBe(3);
    expect(messages[0]).toContain('地址格式不正确');
    expect(messages[1]).toContain('无法连接到服务器');
    expect(messages[2]).toContain('404');
  });

  it('超时文案带秒数，且与 network 不同', () => {
    const timeout = classifyNativeError(new Error('java.net.SocketTimeoutException: timeout'), 8);
    const network = classifyNativeError(new Error('java.net.UnknownHostException: host'), 8);
    expect(timeout.kind).toBe('timeout');
    expect(timeout.message).toContain('8s');
    expect(network.kind).toBe('network');
    expect(timeout.message).not.toBe(network.message);
  });

  it('证书错误单独归类为 tls', () => {
    const tls = classifyNativeError(
      new Error('javax.net.ssl.SSLHandshakeException: Trust anchor for certification path not found'),
      15,
    );
    expect(tls.kind).toBe('tls');
    expect(tls.message).toContain('证书');
  });

  it('401 归 auth，403/5xx 归 http 且优先用后端 error', () => {
    expect(classifyStatus(401, { ok: false, error: '登录已过期' }).kind).toBe('auth');
    expect(classifyStatus(403, { ok: false, error: '账号未验证' }).message).toBe('账号未验证');
    expect(classifyStatus(500, {}).message).toContain('500');
    expect(classifyStatus(404, {}).message).toContain('请确认这是纳物服务端');
  });

  it('fetch 的 TypeError 与 AbortError 分别落到 network / timeout', () => {
    expect(classifyFetchError(new TypeError('Failed to fetch'), 15).kind).toBe('network');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyFetchError(abort, 15).kind).toBe('timeout');
  });

  it('后端要求验证码时标记 requiresCode（F5）', () => {
    const err = classifyStatus(400, { ok: false, error: '请先完成邮箱验证' });
    expect(err.kind).toBe('http');
    expect(err.requiresCode).toBe(true);
  });
});
