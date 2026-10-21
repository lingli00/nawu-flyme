import { describe, expect, it } from 'vitest';
import { channelBase, channelManifestPath } from '../src/api/appUpdate';
import { OFFICIAL_UPDATE_CHANNEL } from '../src/lib/appVersion';
import { joinUrl, normalizeServerUrl } from '../src/lib/url';

/**
 * v1.1.1 回归：官方频道地址拼接。
 *
 * 背景：request() 内部的 normalizeServerUrl() 会把 server.url 归一成「协议://主机」，
 * path 被剥掉。v1.1.1 之前把 OFFICIAL_UPDATE_CHANNEL 整个当 server.url 传进 request()，
 * 导致手机请求 http://host:port/app-manifest.json（少了频道目录），拿到 SPA 的 HTML，
 * 官方频道（含增量补丁）在 App 端从未生效——表现为「收不到增量更新通知」。
 */
describe('官方频道地址拼接（v1.1.1 回归）', () => {
  it('频道目录必须保留：manifest 请求 path 带目录前缀', () => {
    const { origin, dir } = channelBase();
    expect(dir.length).toBeGreaterThan(0);
    expect(channelManifestPath()).toBe(`${dir}/app-manifest.json`);
    // 手机最终请求的完整 URL 必须落在频道目录内
    expect(joinUrl(origin, channelManifestPath())).toBe(
      `${OFFICIAL_UPDATE_CHANNEL.replace(/\/+$/, '')}/app-manifest.json`,
    );
  });

  it('原点不含路径（供 request() 归一化后仍能拼回频道目录）', () => {
    const { origin } = channelBase();
    expect(origin).not.toContain('/nawu-update');
    expect(normalizeServerUrl(origin).url).toBe(origin);
  });

  it('对照记录：normalizeServerUrl 直接吃掉频道目录（本 bug 成因）', () => {
    const n = normalizeServerUrl(OFFICIAL_UPDATE_CHANNEL);
    expect(n.ok).toBe(true);
    expect(n.url).not.toContain('nawu-update');
  });
});
