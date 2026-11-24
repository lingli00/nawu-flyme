import { describe, expect, it } from 'vitest';
import {
  hydrateImages,
  imageNeedsMigration,
  isAlreadyCloud,
  isMigratable,
  looksBareBase64,
  migrateRecord,
  normalizeImageRefForDiff,
  normalizeRecordImageRefs,
  type ImageUploader,
  type MigrateStat,
} from '../src/lib/imageMigrate';
import type { UploadResult } from '../src/lib/imageCloud';

/**
 * ★v1.8.0 图片托管迁移 · 纯函数契约（上传器注入，不需要登录态）。
 *
 * 守住的点（任何一条破了都会「丢图」或「反复重传」）：
 * 1. **失败即回滚**：上传失败 → 记录原样返回（本地 base64 必须留着）；
 * 2. **幂等**：已云端化的记录再跑一遍 → changed=false，不再上传；
 * 3. **差异上传**：云端已有该 sha256 → 一个字节都不传（deduped）；
 * 4. **引用比较抹签名**：同一张图重签一次 URL 不该被当成「记录变了」；
 * 5. **不碰其它形态**：brand: / lucide id / url: 字符串字段一律原样。
 */

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const URL_A = `/api/user/images/${SHA_A}`;
const DATA_A = 'data:image/jpeg;base64,' + 'A'.repeat(400);

function stat(): MigrateStat {
  return { records: 0, uploaded: 0, deduped: 0, failed: 0 };
}

/** 假上传器：按 src 返回预设结果，并记录被真正「上传字节」的次数。 */
function fakeUploader(results: Record<string, UploadResult> = {}): ImageUploader & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (src: string) => {
    calls.push(src);
    return results[src] ?? { ok: true, sha256: SHA_A, url: URL_A, deduped: false };
  }) as ImageUploader & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('isAlreadyCloud / isMigratable / looksBareBase64', () => {
  it('云端引用四种写法都认', () => {
    expect(isAlreadyCloud({ source: 'cloud', ref: URL_A })).toBe(true);
    expect(isAlreadyCloud(`cloud:${URL_A}`)).toBe(true);
    expect(isAlreadyCloud(URL_A)).toBe(true);
    expect(isAlreadyCloud({ source: 'local', ref: DATA_A })).toBe(false);
    expect(isAlreadyCloud({ source: 'web', ref: 'https://a.cn/x.png' })).toBe(false);
  });

  it('可托管的：dataURL / 裸 base64 / http；不可托管：brand: / lucide / 空', () => {
    expect(isMigratable(DATA_A)).toBe(true);
    expect(isMigratable('img:' + DATA_A)).toBe(true);
    expect(isMigratable('https://a.cn/x.png')).toBe(true);
    expect(isMigratable('brand:apple')).toBe(false);
    expect(isMigratable('headphones')).toBe(false);
    expect(isMigratable('')).toBe(false);
  });

  it('裸 base64 阈值与 goodsIcon 一致（短串不碰，免得误伤文本）', () => {
    expect(looksBareBase64('A'.repeat(100))).toBe(false);
    expect(looksBareBase64('A'.repeat(101))).toBe(true);
    expect(looksBareBase64('A'.repeat(120))).toBe(true);
    expect(looksBareBase64('hello world 这是一段中文说明'.repeat(10))).toBe(false);
  });
});

describe('imageNeedsMigration（同步深比较前的预判）', () => {
  it('本地 dataURL → 需要迁移；brand/lucide/url 字符串 → 不动', () => {
    expect(imageNeedsMigration({ source: 'local', ref: DATA_A }, 'record')).toBe(true);
    expect(imageNeedsMigration({ source: 'brand', ref: 'brand:apple' }, 'record')).toBe(false);
    expect(imageNeedsMigration({ source: 'builtin', ref: 'cup' }, 'record')).toBe(false);
    expect(imageNeedsMigration('brand:apple', 'string')).toBe(false);
    expect(imageNeedsMigration('url:/brand-icons/x.png', 'string')).toBe(false);
    expect(imageNeedsMigration('img:' + DATA_A, 'string')).toBe(true);
  });

  it('已经是云端引用的 → 不需要再动（幂等）', () => {
    expect(imageNeedsMigration({ source: 'cloud', ref: URL_A }, 'record')).toBe(false);
    expect(imageNeedsMigration(`cloud:${URL_A}`, 'string')).toBe(false);
  });
});

describe('migrateRecord · 记录形态（goods.image 等）', () => {
  it('成功后换成 {source:cloud, ref, sha256}，且带上本地缩略图', async () => {
    const row = { id: 'g1', name: '耳机', image: { source: 'local', ref: DATA_A } };
    const s = stat();
    const out = await migrateRecord(row, {
      upload: fakeUploader(),
      thumb: async () => 'data:image/jpeg;base64,THUMB',
    }, s);
    expect(out.changed).toBe(true);
    expect(out.row.image).toEqual({
      source: 'cloud',
      ref: URL_A,
      sha256: SHA_A,
      thumb: 'data:image/jpeg;base64,THUMB',
    });
    // 原对象绝不被就地修改（同步 diff 依赖旧值）
    expect(row.image).toEqual({ source: 'local', ref: DATA_A });
    expect(s.uploaded).toBe(1);
  });

  it('★上传失败 → 记录原样返回（本地 base64 必须留着）', async () => {
    const row = { id: 'g2', image: { source: 'local', ref: DATA_A } };
    const s = stat();
    const out = await migrateRecord(row, {
      upload: fakeUploader({ [DATA_A]: { ok: false, sha256: '', url: '', deduped: false, error: 'network' } }),
    }, s);
    expect(out.changed).toBe(false);
    expect(out.row).toBe(row);
    expect(s.failed).toBe(1);
    expect(s.uploaded).toBe(0);
  });

  it('★幂等：已云端的记录再跑一遍不再上传', async () => {
    const row = { id: 'g3', image: { source: 'cloud', ref: URL_A, sha256: SHA_A } };
    const upload = fakeUploader();
    const out = await migrateRecord(row, { upload }, stat());
    expect(out.changed).toBe(false);
    expect(upload.calls).toEqual([]);
  });

  it('brand / lucide / 空图：一个字节都不上传', async () => {
    const upload = fakeUploader();
    const brand = await migrateRecord({ id: 'g4', image: { source: 'brand', ref: 'brand:apple' } }, { upload }, stat());
    const builtin = await migrateRecord({ id: 'g5', image: { source: 'builtin', ref: 'headphones' } }, { upload }, stat());
    const none = await migrateRecord({ id: 'g6' }, { upload }, stat());
    expect([brand.changed, builtin.changed, none.changed]).toEqual([false, false, false]);
    expect(upload.calls).toEqual([]);
  });

  it('缩略图比原图还大 → 不收录（不许为了兜底反而把记录撑大）', async () => {
    const out = await migrateRecord({ id: 'g7', image: { source: 'local', ref: DATA_A } }, {
      upload: fakeUploader(),
      thumb: async () => 'data:image/jpeg;base64,' + 'Q'.repeat(1000),
    }, stat());
    expect(out.row.image).toMatchObject({ source: 'cloud', ref: URL_A });
    expect((out.row.image as { thumb?: string }).thumb).toBeUndefined();
  });

  it('上传器抛异常也不冒泡（记录原样返回，业务不中断）', async () => {
    const boom = (async () => {
      throw new Error('boom');
    }) as unknown as ImageUploader;
    const row = { id: 'g8', image: { source: 'local', ref: DATA_A } };
    // migrateRecord 对**单字段**兜 try/catch：上传器炸了也只是这条图不托管
    const out = await migrateRecord(row, { upload: boom }, stat());
    expect(out.changed).toBe(false);
    expect(out.row).toBe(row);
  });

  it('整条记录被脏数据破坏到无法遍历时，由上层兜底（这里验证单字段异常不影响其它字段）', async () => {
    const upload = fakeUploader();
    const row = { id: 'g9', image: { source: 'local', ref: DATA_A }, icon: 'cup' };
    const out = await migrateRecord(row, { upload }, stat());
    expect(out.changed).toBe(true);
    expect((out.row.image as { source: string }).source).toBe('cloud');
    expect(out.row.icon).toBe('cup');
  });
});

describe('migrateRecord · 字符串形态（wishlist.image / cooldowns.image）', () => {
  it('img:dataURL → cloud:<url>（字符串字段只能存一个 icon 字符串）', async () => {
    const row = { id: 'w1', image: `img:${DATA_A}` };
    const out = await migrateRecord(row, { upload: fakeUploader() }, stat());
    expect(out.changed).toBe(true);
    expect(out.row.image).toBe(`cloud:${URL_A}`);
  });

  it('url: / brand: 字符串原样（外链不能盲换成云端，品牌图标本来就几个字节）', async () => {
    const upload = fakeUploader();
    const a = await migrateRecord({ id: 'w2', image: 'url:/brand-icons/x.png' }, { upload }, stat());
    const b = await migrateRecord({ id: 'w3', image: 'brand:apple' }, { upload }, stat());
    expect([a.changed, b.changed]).toEqual([false, false]);
    expect(upload.calls).toEqual([]);
  });
});

describe('hydrateImages · 差异上传（用户要的「先查云端差异再上传」）', () => {
  it('云端已有该 sha256 → 不传字节，记为 deduped', async () => {
    const upload = fakeUploader();
    const res = await hydrateImages([{ src: DATA_A, sha256: SHA_A }], {
      upload,
      cloudHashes: new Set([SHA_A]),
    });
    expect(upload.calls).toEqual([]);
    expect(res.deduped).toBe(1);
    expect(res.uploaded).toBe(0);
    expect(res.results.get(DATA_A)).toMatchObject({ ok: true, sha256: SHA_A, deduped: true });
  });

  it('云端没有 → 才真传；相同内容只传一次（多物品共用一张图）', async () => {
    const upload = fakeUploader();
    const res = await hydrateImages(
      [
        { src: DATA_A, sha256: SHA_A },
        { src: DATA_A, sha256: SHA_A },
        { src: DATA_A, sha256: SHA_A },
      ],
      { upload, cloudHashes: new Set([SHA_B]) },
    );
    expect(upload.calls).toHaveLength(1);
    expect(res.uploaded).toBe(1);
    expect(res.results.size).toBe(1);
  });

  it('云端列表未知（老服务器 / 离线）→ 全部交给 PUT 自己判重', async () => {
    const upload = fakeUploader({ [DATA_A]: { ok: true, sha256: SHA_A, url: URL_A, deduped: true } });
    const res = await hydrateImages([{ src: DATA_A, sha256: SHA_A }], { upload, cloudHashes: null });
    expect(upload.calls).toEqual([DATA_A]);
    expect(res.deduped).toBe(1);
    expect(res.uploaded).toBe(0);
  });

  it('合计统计：uploaded / deduped / failed 各就各位，进度回调跑满', async () => {
    const upload = fakeUploader({
      [DATA_A]: { ok: false, sha256: '', url: '', deduped: false, error: 'x' },
    });
    const progress: number[] = [];
    const res = await hydrateImages(
      [
        { src: DATA_A, sha256: SHA_A },
        { src: 'data:x2', sha256: SHA_B },
      ],
      { upload, cloudHashes: new Set(), onProgress: (d) => progress.push(d) },
    );
    expect(res.failed).toBe(1);
    expect(res.uploaded).toBe(1);
    expect(progress.length).toBe(2);
  });
});

describe('normalizeImageRefForDiff（同步深比较抹签名参数）', () => {
  it('同一张图不同签名 → 归一后相等（否则每次重签都被当成「记录变了」重推）', () => {
    const a = normalizeImageRefForDiff(`${URL_A}?t=111&s=aaa`);
    const b = normalizeImageRefForDiff(`https://nawu.example.com${URL_A}?t=999&s=zzz`);
    expect(a).toBe(URL_A);
    expect(a).toBe(b);
  });

  it('cloud: 前缀 / 纯 sha 也归一到标准路径', () => {
    expect(normalizeImageRefForDiff(`cloud:${SHA_A}`)).toBe(URL_A);
    expect(normalizeImageRefForDiff(`cloud:${URL_A}?t=1&s=2`)).toBe(URL_A);
  });

  it('非云端引用原样返回（不能误伤普通外链）', () => {
    expect(normalizeImageRefForDiff('https://a.cn/x.png')).toBe('https://a.cn/x.png');
    expect(normalizeImageRefForDiff('brand:apple')).toBe('brand:apple');
    expect(normalizeImageRefForDiff('')).toBe('');
  });

  it('normalizeRecordImageRefs 只改图片字段，其余字段与记录引用保持不变', () => {
    const row = { id: 'g', name: '耳机', image: { source: 'cloud', ref: `${URL_A}?t=1&s=2` }, price: 100 };
    const out = normalizeRecordImageRefs(row);
    expect(out).not.toBe(row);
    expect((out.image as { ref: string }).ref).toBe(URL_A);
    expect(out.price).toBe(100);
    // 没有可归一的引用时原对象返回（零赋值）
    const plain = { id: 'g2', image: { source: 'cloud', ref: URL_A } };
    expect(normalizeRecordImageRefs(plain)).toBe(plain);
  });
});