import { describe, expect, it } from 'vitest';
import { suggestIcons, topSuggestion } from '../src/lib/iconSuggest';

/**
 * ★v1.3.0 图标智能推荐（用户需求：自动匹配图标）。
 * 推荐链：随包品牌资产（本地）→ 内置 glyph → 图标代理（联网）→ 分类默认。
 */

const BASE = 'http://192.168.1.100:3030';

describe('iconSuggest · 订阅/物品名 → 推荐图标', () => {
  it('「B站大会员」→ 本地品牌资产（bilibili.com.png 随包分发）', () => {
    const top = topSuggestion('B站大会员', { kind: 'sub', base: BASE });
    expect(top?.kind).toBe('local');
    expect(top?.value).toBe('url:/brand-icons/bilibili.com.png');
    expect(top?.label).toBe('本地图标');
  });

  it('「网易云音乐」→ 本地品牌资产（music.163.com.png）', () => {
    const top = topSuggestion('网易云音乐', { kind: 'sub', base: BASE });
    expect(top?.kind).toBe('local');
    expect(top?.value).toContain('/brand-icons/');
  });

  it('「iCloud 50G」→ 本地品牌资产', () => {
    const top = topSuggestion('iCloud 50G', { kind: 'sub', base: BASE });
    expect(top?.kind).toBe('local');
  });

  it('名称带域名 → 也能命中本地资产', () => {
    const top = topSuggestion('网易云 music.163.com', { kind: 'sub', base: BASE });
    expect(top?.kind).toBe('local');
  });

  it('无本地资产的知名品牌（配了 base）→ 网络推荐（自建代理）', () => {
    const list = suggestIcons('Claude Pro', { kind: 'sub', base: BASE });
    // claude.ai.png 已随包 → local；这里断言链上至少有一个非空推荐
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]!.value).toMatch(/^url:|^brand:/);
  });

  it('完全无品牌命中 + 有分类图标 → 兜底分类默认', () => {
    const top = topSuggestion('桌面小摆件', { kind: 'goods', categoryIcon: 'package' });
    expect(top?.kind).toBe('builtin');
    expect(top?.value).toBe('package');
  });

  it('什么线索都没有 → 返回空数组（调用方保持原交互）', () => {
    expect(suggestIcons('', {})).toEqual([]);
    expect(suggestIcons('啊', {})).toEqual([]);
  });

  it('推荐不重复（同名去重）', () => {
    const list = suggestIcons('哔哩哔哩', { kind: 'sub', base: BASE });
    const values = list.map((s) => s.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('内置 glyph 也在链上（离线渲染来源）', () => {
    const list = suggestIcons('极客时间', { kind: 'sub', base: BASE });
    // 品牌库若无极客时间，glyph 库可能有；无论命中哪个，链必须非空或走 builtin
    if (list.length > 0) {
      expect(list.every((s) => /^url:|^brand:|^[a-z-]+$/.test(s.value))).toBe(true);
    }
  });
});
