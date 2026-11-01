import { describe, expect, it } from 'vitest';
import {
  BRAND_GROUPS,
  ICON_CACHE_TAG,
  brandIconRef,
  brandIconSrc,
  faviconChain,
  iconApiUrl,
  localBrandIconPath,
} from '../src/lib/brandIcon';
import { BRAND_ICON_ASSETS } from '../src/generated/brandIconAssets';

/**
 * v1.0.33 · 品牌图标「零缺失 + 永久化 + 物品订阅共享」的契约锁定。
 *
 * 用户原话：「我不希望有任何一个缺失」「永久保存到服务器 + 封装进 APP」
 * 「物品跟订阅的品牌图标可以互通共享」。
 * 这里把四条承诺全部落成断言，谁改坏了立刻红。
 */

const BASE = 'http://127.0.0.1:2233';

describe('品牌图标资产完整性（v1.0.33）', () => {
  it('BRAND_GROUPS 里每一个域名都有随包资产，零缺失', () => {
    const domains = [...new Set(BRAND_GROUPS.flatMap((g) => g.items.map((i) => i.domain)))];
    expect(domains.length).toBeGreaterThan(150);
    const missing = domains.filter((d) => !BRAND_ICON_ASSETS[d]);
    expect(missing).toEqual([]);
  });

  it('资产表里的路径全部指向 /brand-icons/ 站内资源（离线可用、无第三方）', () => {
    for (const [domain, rel] of Object.entries(BRAND_ICON_ASSETS)) {
      expect(rel, domain).toMatch(/^\/brand-icons\/[^/]+\.(png|svg|ico|jpg|webp)$/);
      expect(rel).not.toMatch(/https?:/);
    }
  });

  it('物品与订阅共用同一引用 —— 同一域名必然产出同一个落库值', () => {
    const asItem = brandIconRef(BASE, 'kugou.com');
    const asSub = brandIconRef(BASE, 'kugou.com');
    expect(asItem).toBe(asSub);
    expect(asItem).toBe('url:/brand-icons/kugou.com.ico');
  });
});

describe('品牌图标取址优先级（v1.0.33）', () => {
  it('已收录域名 → 站内资产，不依赖网络', () => {
    expect(localBrandIconPath('aliyun.com')).toBe('/brand-icons/aliyun.com.png');
    expect(brandIconSrc(BASE, 'aliyun.com')).toBe('/brand-icons/aliyun.com.png');
  });

  it('未收录域名 → 回落到自建代理', () => {
    expect(localBrandIconPath('nope-not-a-brand-xyz.com')).toBeNull();
    expect(brandIconSrc(BASE, 'nope-not-a-brand-xyz.com')).toBe(
      `${BASE}/api/icon/img?d=nope-not-a-brand-xyz.com&v=${ICON_CACHE_TAG}`,
    );
  });

  it('代理 URL 带缓存击穿标签（否则 30 天旧假图缓存清不掉）', () => {
    const url = iconApiUrl(BASE, 'example.com');
    expect(url).toContain(`v=${ICON_CACHE_TAG}`);
    // 域名要正确编码，避免注入
    expect(iconApiUrl(BASE, 'a.com/b?x=1')).toContain('a.com%2Fb%3Fx%3D1');
  });

  it('base 结尾多余斜杠要被吃掉（否则拼出 //api）', () => {
    expect(iconApiUrl('http://x.com///', 'a.com')).toMatch(/^http:\/\/x\.com\/api\//);
  });

  it('回退链不含 favicon.im —— 它是灰圆假图的源头', () => {
    const chain = faviconChain(BASE, 'nope-not-a-brand-xyz.com');
    expect(chain.some((u) => u.includes('favicon.im'))).toBe(false);
    // 已收录域名：站内资产排第一
    const known = faviconChain(BASE, 'aliyun.com');
    expect(known[0]).toBe('/brand-icons/aliyun.com.png');
    expect(known[known.length - 1]).toContain('icon.horse');
  });
});
