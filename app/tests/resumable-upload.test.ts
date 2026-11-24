// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  UPLOAD_CHUNK,
  clearUploadProgress,
  readUploadProgress,
  splitChunks,
  toBase64,
  uploadKey,
  writeUploadProgress,
} from '../src/lib/resumableUpload';

/**
 * ★v1.5.1 分片断点续传（上传侧）的纯逻辑：
 * key 稳定性、分片切分、UTF-8 base64、进度持久化。
 */

beforeEach(() => {
  localStorage.clear();
});

describe('上传 key（断点续传的锚点）', () => {
  it('同一份内容 → 同一个 key（重启后能找回同一会话）', () => {
    const p = '{"goods":[1,2,3]}';
    expect(uploadKey(p)).toBe(uploadKey(p));
  });

  it('内容变化 → key 变化（不会把旧分片拼到新数据上）', () => {
    expect(uploadKey('a'.repeat(100))).not.toBe(uploadKey('a'.repeat(99)));
  });

  it('key 只含安全字符（可直接做目录名）', () => {
    expect(uploadKey('中文内容🙂')).toMatch(/^bk-[0-9]+-[0-9a-f]+$/);
  });
});

describe('分片切分', () => {
  it('按 chunk 大小切分，最后一片可短', () => {
    const payload = 'x'.repeat(UPLOAD_CHUNK + 10);
    const chunks = splitChunks(payload);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBe(UPLOAD_CHUNK);
    expect(chunks[1]!.length).toBe(10);
    expect(chunks.join('')).toBe(payload);
  });

  it('空内容也返回一片（保证 finish 能走到）', () => {
    expect(splitChunks('')).toHaveLength(1);
  });

  it('自定义片长', () => {
    expect(splitChunks('abcdef', 2)).toEqual(['ab', 'cd', 'ef']);
  });
});

describe('UTF-8 base64', () => {
  it('中文不炸（btoa 直接处理会抛异常）', () => {
    const b64 = toBase64('转卖「笔记本」净赚 120');
    expect(b64.length).toBeGreaterThan(0);
    expect(() => atob(b64)).not.toThrow();
  });
});

describe('进度持久化', () => {
  it('写入后可读回，清理后归零', () => {
    writeUploadProgress('bk-1-ff', 2048);
    expect(readUploadProgress('bk-1-ff')).toBe(2048);
    clearUploadProgress('bk-1-ff');
    expect(readUploadProgress('bk-1-ff')).toBe(0);
  });

  it('没写过的 key 返回 0', () => {
    expect(readUploadProgress('nope')).toBe(0);
  });
});
