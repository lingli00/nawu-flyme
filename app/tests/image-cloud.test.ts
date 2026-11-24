import { describe, expect, it } from 'vitest';
import {
  absoluteImageUrl,
  cloudSrcOf,
  isCloudImageUrl,
  isCloudRefString,
  renderUrlFor,
  shaFromImageUrl,
  signExpiryOf,
  weakHash,
  clearSignCache,
  rememberSignedUrl,
  INLINE_BASE64_MAX,
  CLOUD_THUMB_DIM,
} from '../src/lib/imageCloud';

/**
 * ★v1.8.0 图片云托管 · 前端引用解析的纯函数契约。
 *
 * 守住的点（任何一条破了都会「丢图」或「云端图渲染不出来」）：
 * 1. sha256 只从 **标准路径** `/api/user/images/<64hex>` 解析（相对 / 绝对 / 带签名都行）；
 * 2. 解析失败必须返回空串 —— **绝不抛异常**（渲染层直接拿它拼 <img src>）；
 * 3. 签名 URL 的过期时间要能被独立读出（渲染层据此判断是否要重签）；
 * 4. 相对路径在 App 里要能补成服务器绝对地址（window 源是 https://localhost）。
 */

const SHA = 'a'.repeat(64);

describe('shaFromImageUrl / isCloudImageUrl', () => {
  it('相对路径 / 绝对路径 / 带签名参数都能解析出 sha256', () => {
    expect(shaFromImageUrl(`/api/user/images/${SHA}`)).toBe(SHA);
    expect(shaFromImageUrl(`/api/user/images/${SHA}?t=1790000000&s=abcdef`)).toBe(SHA);
    expect(shaFromImageUrl(`https://nawu.example.com/api/user/images/${SHA}?t=1&s=2`)).toBe(SHA);
    expect(shaFromImageUrl(`/api/user/images/${SHA.toUpperCase()}`)).toBe(SHA);
  });

  it('不是云端路径一律返回空串（不抛异常）', () => {
    expect(shaFromImageUrl('')).toBe('');
    expect(shaFromImageUrl('/api/icon/img?d=abc')).toBe('');
    expect(shaFromImageUrl('/api/user/images/not-a-sha')).toBe('');
    expect(shaFromImageUrl('/api/user/images/' + 'b'.repeat(63))).toBe('');
    expect(shaFromImageUrl(null as unknown as string)).toBe('');
  });

  it('isCloudImageUrl 与 sha 解析口径一致', () => {
    expect(isCloudImageUrl(`/api/user/images/${SHA}`)).toBe(true);
    expect(isCloudImageUrl('/api/img/get?u=x')).toBe(false);
    expect(isCloudImageUrl('')).toBe(false);
  });
});

describe('isCloudRefString / cloudSrcOf（`cloud:` 前缀）', () => {
  it('cloud:<url> / cloud:<sha> / 直接路径都能认', () => {
    expect(isCloudRefString(`cloud:/api/user/images/${SHA}`)).toBe(true);
    expect(isCloudRefString(`cloud:${SHA}`)).toBe(true);
    expect(isCloudRefString(`/api/user/images/${SHA}`)).toBe(true);
    expect(isCloudRefString('img:data:image/png;base64,AA')).toBe(false);
    expect(isCloudRefString('cloud:')).toBe(false);
  });

  it('cloudSrcOf 归一到标准路径，垃圾输入返回空串', () => {
    expect(cloudSrcOf(`cloud:/api/user/images/${SHA}?t=1&s=2`)).toBe(`/api/user/images/${SHA}?t=1&s=2`);
    expect(cloudSrcOf(`cloud:${SHA}`)).toBe(`/api/user/images/${SHA}`);
    expect(cloudSrcOf(`/api/user/images/${SHA}`)).toBe(`/api/user/images/${SHA}`);
    expect(cloudSrcOf('cloud:')).toBe('');
    expect(cloudSrcOf('cloud:garbage')).toBe('');
    expect(cloudSrcOf('')).toBe('');
  });
});

describe('签名 URL（过期判断 / 渲染取值）', () => {
  it('signExpiryOf 读出 t 参数', () => {
    expect(signExpiryOf(`/api/user/images/${SHA}?t=1790000000&s=abc`)).toBe(1790000000);
    expect(signExpiryOf(`/api/user/images/${SHA}`)).toBe(0);
    expect(signExpiryOf('')).toBe(0);
  });

  it('缓存里有新鲜签名 → 直接返回（零网络）', () => {
    clearSignCache();
    const future = Math.floor(Date.now() / 1000) + 3600 * 5;
    const url = `/api/user/images/${SHA}?t=${future}&s=fresh`;
    rememberSignedUrl(SHA, url);
    expect(renderUrlFor(SHA)).toBe(url);
  });

  it('没有签名缓存、也没有给定 URL → 退回无签名路径（同源 Cookie 还能救，页面不空）', () => {
    clearSignCache();
    expect(renderUrlFor(SHA)).toBe(`/api/user/images/${SHA}`);
  });

  it('给定 URL 未过期 → 原样返回', () => {
    clearSignCache();
    const future = Math.floor(Date.now() / 1000) + 3600 * 5;
    const url = `/api/user/images/${SHA}?t=${future}&s=x`;
    expect(renderUrlFor(SHA, url)).toBe(url);
  });

  it('过期 / 垃圾 sha 不抛异常', () => {
    clearSignCache();
    expect(() => renderUrlFor('', '', '')).not.toThrow();
    expect(renderUrlFor(undefined)).toBe('');
    expect(renderUrlFor('')).toBe('');
  });
});

describe('absoluteImageUrl（App 内 window 源是 https://localhost）', () => {
  it('相对路径补服务器地址，绝对地址原样返回', () => {
    expect(absoluteImageUrl(`/api/user/images/${SHA}`, 'https://nawu.example.com')).toBe(
      `https://nawu.example.com/api/user/images/${SHA}`,
    );
    expect(absoluteImageUrl('https://cdn.example.com/x.png', 'https://nawu.example.com')).toBe('https://cdn.example.com/x.png');
    expect(absoluteImageUrl('', 'https://nawu.example.com')).toBe('');
    expect(absoluteImageUrl('/brand-icons/x.png', 'https://nawu.example.com/')).toBe('https://nawu.example.com/brand-icons/x.png');
  });
});

describe('常量与弱哈希（无 SubtleCrypto 环境的兜底）', () => {
  it('缩略图边长 / 内嵌阈值是「小而够用」的量级', () => {
    expect(CLOUD_THUMB_DIM).toBeLessThanOrEqual(320);
    expect(INLINE_BASE64_MAX).toBeLessThan(8 * 1024);
  });

  it('weakHash 稳定且能区分不同输入', () => {
    expect(weakHash('abc')).toBe(weakHash('abc'));
    expect(weakHash('abc')).not.toBe(weakHash('abd'));
    expect(weakHash('')).toBe(weakHash(''));
  });
});