import { describe, expect, it } from 'vitest';
import {
  decodeFlyme,
  encodeFlyme,
  FLYME_PBKDF2_ITERATIONS,
  flymeFileName,
  isEncryptedFlyme,
  isFlyme,
} from '../src/lib/flymeFile';
import type { SnapshotPayload } from '../src/types/api';

/**
 * .flyme 格式测试（v0.6.0 导出增强）。
 *
 * ★格式来自网页版 SPA bundle 逆向（src/lib/flymeFile.ts 顶部注释）：
 * "FLYME1" 魔数 + 版本字节（0 明文 / 1 加密）+ salt16 + iv12 + AES-256-GCM，
 * PBKDF2-SHA256 200k 迭代 —— 与网页版导出/导入二进制互通。
 */

/** 造一份最小快照。 */
function fakePayload(): SnapshotPayload {
  return {
    collections: { goods: [{ id: 'g1', name: '雨伞' }], subscriptions: [], valueRecords: [] },
    settings: null,
    count: 1,
    app: 'flyme-web',
    version: 1,
    exportedAt: '2026-10-07T08:00:00.000Z',
  } as unknown as SnapshotPayload;
}

describe('lib/flymeFile · .flyme 备份格式（导出互通）', () => {
  it('未加密：魔数 + 版本 0 + 明文 JSON，可无损往返', async () => {
    const payload = fakePayload();
    const bytes = await encodeFlyme(payload, '');

    expect(isFlyme(bytes)).toBe(true);
    expect(isEncryptedFlyme(bytes)).toBe(false);
    expect(bytes[6]).toBe(0);
    // 头 7 字节之后就是 JSON.stringify 的 UTF-8
    expect(new TextDecoder().decode(bytes.subarray(7))).toBe(JSON.stringify(payload));

    const decoded = (await decodeFlyme(bytes)) as SnapshotPayload;
    expect(decoded).toEqual(payload);
  });

  it('加密：魔数 + 版本 1 + 16 字节 salt + 12 字节 iv + GCM 密文，可无损往返', async () => {
    const payload = fakePayload();
    const bytes = await encodeFlyme(payload, 'p@ss 明文密码');

    expect(isFlyme(bytes)).toBe(true);
    expect(isEncryptedFlyme(bytes)).toBe(true);
    expect(bytes[6]).toBe(1);
    // 加密头 35 字节 + 至少 GCM tag 16 字节
    expect(bytes.byteLength).toBeGreaterThanOrEqual(35 + 16);

    const decoded = (await decodeFlyme(bytes, 'p@ss 明文密码')) as SnapshotPayload;
    expect(decoded).toEqual(payload);
  });

  it('加密文件密码留空 → 明确报「该备份已加密，请输入密码」', async () => {
    const bytes = await encodeFlyme(fakePayload(), 'secret');
    await expect(decodeFlyme(bytes, '')).rejects.toThrow('该备份已加密，请输入密码');
  });

  it('密码错误 → 报「密码错误，或文件已损坏」', async () => {
    const bytes = await encodeFlyme(fakePayload(), 'right');
    await expect(decodeFlyme(bytes, 'wrong')).rejects.toThrow('密码错误，或文件已损坏');
  });

  it('非 .flyme 内容：纯 JSON 兜底解析；垃圾数据报「无法识别」', async () => {
    const json = await decodeFlyme(new TextEncoder().encode('{"app":"flyme-web"}'));
    expect(json).toEqual({ app: 'flyme-web' });

    await expect(decodeFlyme(new TextEncoder().encode('not-flyme-not-json'))).rejects.toThrow(
      '无法识别的文件（不是 .flyme 备份）',
    );
  });

  it('两次加密同一内容：salt/iv 随机 → 密文不同但都能解开', async () => {
    const payload = fakePayload();
    const a = await encodeFlyme(payload, 'same-pwd');
    const b = await encodeFlyme(payload, 'same-pwd');
    expect(Array.from(a.subarray(7, 23))).not.toEqual(Array.from(b.subarray(7, 23))); // salt 不同
    const da = (await decodeFlyme(a, 'same-pwd')) as SnapshotPayload;
    const db = (await decodeFlyme(b, 'same-pwd')) as SnapshotPayload;
    expect(da).toEqual(db);
  });

  it('文件名对齐网页版：纳物备份_YYYY-MM-DD.flyme；迭代次数为 200000', () => {
    expect(flymeFileName('纳物备份', new Date('2026-10-07T08:00:00Z'))).toBe('纳物备份_2026-10-07.flyme');
    expect(FLYME_PBKDF2_ITERATIONS).toBe(200_000);
  });
});
