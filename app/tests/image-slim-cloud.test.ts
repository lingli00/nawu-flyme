import { describe, expect, it } from 'vitest';
import {
  canonicalCloudRef,
  isCloudRef,
  slimCollectionsForSnapshot,
  slimRecordForSnapshot,
} from '../src/lib/imageCompress';

/**
 * ★v1.8.0 备份 / 同步 payload 瘦身（用户反馈：加了几张图本地就从 600KB 涨到 1.8MB，
 * 宽带小、每次备份全量重传 → 卡顿几秒）。
 *
 * 守住的点：
 * 1. 云端图进 payload **只留** `{source:'cloud', ref, sha256}` —— 本机渲染专用的
 *    缩略图（3~6KB dataURL）绝不上行；
 * 2. **没有云端图时原对象返回**（与旧版逐字节一致，老用户备份内容不变）；
 * 3. 本地 base64 / brand / lucide 一律不碰（那是还没托管的图，动了就丢图）。
 */

const SHA = 'c'.repeat(64);
const REF = `/api/user/images/${SHA}`;

describe('canonicalCloudRef', () => {
  it('对象 / cloud: 字符串 / url: 字符串 / 纯 sha 都归一到标准路径', () => {
    expect(canonicalCloudRef({ source: 'cloud', ref: REF })).toBe(REF);
    expect(canonicalCloudRef({ source: 'cloud', ref: `${REF}?t=1&s=2` })).toBe(REF);
    expect(canonicalCloudRef(`cloud:${REF}`)).toBe(REF);
    expect(canonicalCloudRef(`url:${REF}`)).toBe(REF);
    expect(canonicalCloudRef(SHA)).toBe(REF);
    expect(canonicalCloudRef(`https://nawu.example.com${REF}?t=1`)).toBe(REF);
  });

  it('非云端返回空串，不抛异常', () => {
    expect(canonicalCloudRef({ source: 'local', ref: 'data:image/png;base64,AA' })).toBe('');
    expect(canonicalCloudRef('https://a.cn/x.png')).toBe('');
    expect(canonicalCloudRef(null)).toBe('');
    expect(canonicalCloudRef(undefined)).toBe('');
    expect(canonicalCloudRef(123)).toBe('');
    expect(isCloudRef({ source: 'cloud', ref: REF })).toBe(true);
    expect(isCloudRef({ source: 'local', ref: 'data:x' })).toBe(false);
  });
});

describe('slimRecordForSnapshot', () => {
  it('云端图 → 只留 source/ref/sha256（丢掉本机缩略图）', () => {
    const row = {
      id: 'g1',
      name: '耳机',
      image: { source: 'cloud', ref: `${REF}?t=1&s=2`, sha256: SHA, thumb: 'data:image/jpeg;base64,' + 'A'.repeat(5000) },
    };
    const out = slimRecordForSnapshot(row);
    expect(out.image).toEqual({ source: 'cloud', ref: REF, sha256: SHA });
    // 单条记录从「≈5KB」降到「≈一百多字节」—— 这就是一笔备份省下的量
    expect(JSON.stringify(out.image as object).length).toBeLessThan(200);
    expect(JSON.stringify(row.image).length).toBeGreaterThan(5000);
  });

  it('已经是最精简形态 → 原对象返回（保持引用稳定，diff 不抖）', () => {
    const row = { id: 'g2', image: { source: 'cloud', ref: REF, sha256: SHA } };
    expect(slimRecordForSnapshot(row)).toBe(row);
  });

  it('★没有云端图 / 本地 base64 / brand / lucide → 原对象返回，绝不改', () => {
    const local = { id: 'g3', image: { source: 'local', ref: 'data:image/png;base64,AA' } };
    const brand = { id: 'g4', image: { source: 'brand', ref: 'brand:apple' } };
    const none = { id: 'g5', name: '无图' };
    expect(slimRecordForSnapshot(local)).toBe(local);
    expect(slimRecordForSnapshot(brand)).toBe(brand);
    expect(slimRecordForSnapshot(none)).toBe(none);
  });

  it('订阅 icon（字符串 cloud: 引用）不属于对象形态 → 不动（保住既有行为）', () => {
    const row = { id: 's1', icon: `cloud:${REF}` };
    // 字符串 icon 由 imageMigrate 负责；台账瘦身只处理对象形态的 image/icon
    expect(slimRecordForSnapshot(row)).toBe(row);
  });

  it('坏数据（image 是数组 / 字符串 / null）不崩', () => {
    expect(() => slimRecordForSnapshot({ id: 'x', image: [1, 2] })).not.toThrow();
    expect(slimRecordForSnapshot({ id: 'x', image: 'oops' })).toEqual({ id: 'x', image: 'oops' });
    expect(slimRecordForSnapshot(null)).toBe(null);
    expect(slimRecordForSnapshot(undefined)).toBe(undefined);
  });
});

describe('slimCollectionsForSnapshot', () => {
  it('整份集合瘦身：只有云端图的那几条被替换，其余保持同一引用', () => {
    const local = { id: 'g1', image: { source: 'local', ref: 'data:image/png;base64,AA' } };
    const cloud = { id: 'g2', image: { source: 'cloud', ref: REF, sha256: SHA, thumb: 'data:image/jpeg;base64,THUMB' } };
    const coll = { goods: [local, cloud] };
    const out = slimCollectionsForSnapshot(coll);
    expect(out.goods[0]).toBe(local);
    expect((out.goods[1] as { image: unknown }).image).toEqual({ source: 'cloud', ref: REF, sha256: SHA });
  });

  it('★没有任何云端图 → 原对象返回（老用户备份内容逐字节不变）', () => {
    const coll = { goods: [{ id: 'g', image: { source: 'local', ref: 'data:image/png;base64,AA' } }] };
    expect(slimCollectionsForSnapshot(coll)).toBe(coll);
  });

  it('缺失 / 非数组集合 → 补空数组（与 snapshot 层口径一致）', () => {
    const out = slimCollectionsForSnapshot({ goods: undefined as unknown as unknown[], walls: [{ id: 'w' }] });
    expect(out.goods).toEqual([]);
    expect(out.walls).toEqual([{ id: 'w' }]);
  });
});