import { describe, expect, it } from 'vitest';
import { buildQueryString, joinUrl, normalizeServerUrl } from '../src/lib/url';

describe('lib/url · 服务器地址归一化', () => {
  it('补协议 + 去尾斜杠 + 剥 path', () => {
    expect(normalizeServerUrl('192.168.1.100:3030/')).toEqual({ ok: true, url: 'http://192.168.1.100:3030' });
  });

  it('保留 https 与端口', () => {
    expect(normalizeServerUrl('https://flyme.example.com:8443/app/index.php').url).toBe(
      'https://flyme.example.com:8443',
    );
  });

  it('大小写协议与尾斜杠都归一', () => {
    expect(normalizeServerUrl('HTTP://192.168.1.10:3030///').url).toBe('http://192.168.1.10:3030');
  });

  it('localhost 可用', () => {
    expect(normalizeServerUrl('localhost:8080').url).toBe('http://localhost:8080');
  });

  it('乱填的地址判为非法（invalid_url）', () => {
    const r = normalizeServerUrl('abc');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('地址格式不正确，示例：http://192.168.1.10:3030');
  });

  it('含空格 / 非 http 协议 / 空串都判为非法', () => {
    expect(normalizeServerUrl('http://a b.com').ok).toBe(false);
    expect(normalizeServerUrl('ftp://example.com').ok).toBe(false);
    expect(normalizeServerUrl('   ').ok).toBe(false);
  });

  it('拼接 URL 与 query', () => {
    expect(joinUrl('http://h:3030/', '/api/health')).toBe('http://h:3030/api/health');
    expect(joinUrl('http://h:3030', '/api/sync/pull', { id: 12 })).toBe('http://h:3030/api/sync/pull?id=12');
    expect(buildQueryString({})).toBe('');
  });
});
