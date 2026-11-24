import { describe, expect, it } from 'vitest';
import {
  cloudSha256,
  cloudThumb,
  cloudUrl,
  goodsIconValue,
  goodsIconView,
  goodsImageFromIcon,
  hasOwnIcon,
  isCloudImage,
  isLocalImage,
  isWebImage,
} from '../src/lib/goodsIcon';

/**
 * ★v1.8.0 图片云托管 · Goods.image 第四形态（`source:'cloud'`）。
 *
 * 必须同时成立的三件事：
 * 1. **存量 base64 不受影响**：老记录 `{source:'local', ref:'data:…'}` 仍然输出 `img:<dataURL>`；
 * 2. **云端图走 url: 分支**：所有既有渲染（IconPreview / CachedUrlImg / 分享卡）零改动可用；
 * 3. **解析失败不崩**：缺字段 / 垃圾 ref 一律给空值，绝不让详情页白屏。
 */

const SHA = 'ab'.repeat(32);
const URL_REL = `/api/user/images/${SHA}`;
/** 一张「像真的」的缩略图 dataURL（jsdom 不解码，只当字符串用）。 */
const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';

describe('goodsIconValue · 云端形态', () => {
  it('{source:cloud, ref} → url:<云端路径>（复用既有 url: 渲染分支）', () => {
    const g = { image: { source: 'cloud', ref: `https://nawu.example.com${URL_REL}?t=1&s=2`, sha256: SHA } };
    expect(goodsIconValue(g)).toBe(`url:https://nawu.example.com${URL_REL}?t=1&s=2`);
  });

  it('字符串形态 url:/api/user/images/<sha> 也认（旧数据 / 导入数据）', () => {
    expect(goodsIconValue({ image: { source: 'web', ref: URL_REL } })).toBe(`url:${URL_REL}`);
    expect(goodsIconValue({ image: URL_REL })).toBe(`url:${URL_REL}`);
    expect(goodsIconValue({ image: `url:${URL_REL}` })).toBe(`url:${URL_REL}`);
  });

  it('cloud:<sha> 前缀（字符串字段里用）→ 标准路径', () => {
    expect(goodsIconValue({ image: `cloud:${SHA}` })).toBe(`url:${URL_REL}`);
  });

  it('hasOwnIcon / isCloudImage 判定正确', () => {
    expect(hasOwnIcon({ image: { source: 'cloud', ref: URL_REL } })).toBe(true);
    expect(isCloudImage({ image: { source: 'cloud', ref: URL_REL } })).toBe(true);
    expect(isCloudImage({ image: { source: 'local', ref: 'data:image/png;base64,AA' } })).toBe(false);
  });
});

describe('存量数据兼容（最重要的回归点）', () => {
  it('老记录 base64 → 仍然是 img:<dataURL>，一个字符都不变', () => {
    const ref = 'data:image/jpeg;base64,/9j/AAAAPHOTO';
    expect(goodsIconValue({ image: { source: 'local', ref } })).toBe(`img:${ref}`);
    expect(goodsIconValue({ image: { source: 'file', ref } })).toBe(`img:${ref}`);
    expect(isLocalImage({ image: { source: 'local', ref } })).toBe(true);
    // 云端形态绝不能被误判成本地图
    expect(isLocalImage({ image: { source: 'cloud', ref: URL_REL } })).toBe(false);
  });

  it('brand: / builtin / web 四形态完全没被云端改动带偏', () => {
    expect(goodsIconValue({ image: goodsImageFromIcon('brand:apple') })).toBe('brand:apple');
    expect(goodsIconValue({ image: goodsImageFromIcon('headphones') })).toBe('headphones');
    expect(goodsIconValue({ image: { source: 'web', ref: 'https://x.cn/f.ico' } })).toBe('url:https://x.cn/f.ico');
    expect(isWebImage({ image: { source: 'web', ref: 'https://x.cn/f.ico' } })).toBe(true);
  });
});

describe('goodsIconView · 云端图优先本地缩略图', () => {
  it('有 thumb → kind:cloud，src=缩略图、url=网络地址（离线也能看见图）', () => {
    const v = goodsIconView({ image: { source: 'cloud', ref: URL_REL, sha256: SHA, thumb: THUMB } });
    expect(v.kind).toBe('cloud');
    expect(v.src).toBe(THUMB);
    expect(v.url).toBe(URL_REL);
  });

  it('无 thumb → kind:cloud，src 为空（渲染层走网络），但 url 一定给出来', () => {
    const v = goodsIconView({ image: { source: 'cloud', ref: URL_REL, sha256: SHA } });
    expect(v.kind).toBe('cloud');
    expect(v.src).toBe('');
    expect(v.url).toBe(URL_REL);
  });

  it('thumb 不是 dataURL（脏数据）→ 当没有缩略图处理，不崩', () => {
    const v = goodsIconView({ image: { source: 'cloud', ref: URL_REL, thumb: 'http://evil/x.png' } });
    expect(v.kind).toBe('cloud');
    expect(v.src).toBe('');
  });

  it('本地图 / 空值 / 垃圾值：返回结构永远完整（调用方不需要空值防御）', () => {
    const local = goodsIconView({ image: { source: 'local', ref: 'data:image/png;base64,AA' } });
    expect(local).toMatchObject({ kind: 'img', url: '' });
    const none = goodsIconView({});
    expect(none).toEqual({ kind: 'none', value: '', src: '', url: '' });
    // 脏数据（source:cloud + 不可解析的 ref）：必须落 'none'，**不许**掉进 builtin 分支
    const junk = goodsIconView({ image: { source: 'cloud', ref: 'not-a-url' } });
    expect(junk).toEqual({ kind: 'none', value: '', src: '', url: '' });
  });
});

describe('cloudThumb / cloudUrl / cloudSha256 解析辅助', () => {
  it('thumb 只收 data:image/ 前缀', () => {
    expect(cloudThumb({ image: { ref: URL_REL, thumb: THUMB } })).toBe(THUMB);
    expect(cloudThumb({ image: { ref: URL_REL, thumb: '' } })).toBe('');
    expect(cloudThumb({ image: { ref: URL_REL } })).toBe('');
    expect(cloudThumb({ image: 'img:data:image/png;base64,AA' })).toBe('');
  });

  it('cloudUrl 只对云端形态返回地址', () => {
    expect(cloudUrl({ image: { source: 'cloud', ref: URL_REL } })).toBe(URL_REL);
    expect(cloudUrl({ image: { source: 'local', ref: 'data:image/png;base64,AA' } })).toBe('');
    expect(cloudUrl({ image: `cloud:/api/user/images/${SHA}?t=1` })).toBe(`/api/user/images/${SHA}?t=1`);
  });

  it('cloudSha256 优先字段、其次 URL；脏值返回空串', () => {
    expect(cloudSha256({ image: { source: 'cloud', ref: URL_REL, sha256: SHA } })).toBe(SHA);
    expect(cloudSha256({ image: { source: 'cloud', ref: URL_REL } })).toBe(SHA);
    expect(cloudSha256({ image: { source: 'cloud', ref: URL_REL, sha256: 'bad' } })).toBe(SHA);
    expect(cloudSha256({ image: { source: 'local', ref: 'data:image/png;base64,AA' } })).toBe('');
  });
});

describe('goodsImageFromIcon · 云端形态往返', () => {
  it('url:<云端路径> → {source:cloud}（而不是误落成 web）', () => {
    expect(goodsImageFromIcon(`url:${URL_REL}`)).toEqual({ source: 'cloud', ref: URL_REL });
    expect(goodsImageFromIcon(`cloud:${SHA}`)).toEqual({ source: 'cloud', ref: URL_REL });
  });

  it('普通外链仍然落 web（不被云端判定误伤）', () => {
    expect(goodsImageFromIcon('url:https://a.com/i.png')).toEqual({ source: 'web', ref: 'https://a.com/i.png' });
  });

  it('往返一致：cloud → icon → cloud', () => {
    const icon = goodsIconValue({ image: { source: 'cloud', ref: URL_REL } });
    expect(goodsImageFromIcon(icon)).toEqual({ source: 'cloud', ref: URL_REL });
  });
});