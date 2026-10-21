import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_FILE_ACCEPT,
  looksLikeBackup,
  previewBackupBytes,
  readBackupFile,
} from '../src/lib/backupImport';
import { encodeFlyme, flymeFileName } from '../src/lib/flymeFile';

/**
 * v1.0.34 补齐「只能导出、不能导入」的缺口。
 *
 * 覆盖导入链路的三个环节：
 *  ① looksLikeBackup —— 选错文件时提前拦下，而不是等解码报「无法识别」；
 *  ② previewBackupBytes —— .flyme（明文/加密）→ 用户可读摘要（条数/时间/来源/是否加密）；
 *  ③ readBackupFile —— 真机与浏览器共用的读文件实现（FileReader 路径 + 失败分支）。
 */

const enc = new TextEncoder();

/** 一份最小但结构完整的快照（applySnapshot 会补齐缺失的集合）。 */
function makePayload(): Record<string, unknown> {
  return {
    collections: {
      goods: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }],
      subscriptions: [{ id: 's1' }, { id: 's2' }],
      valueRecords: [{ id: 'v1' }],
    },
    settings: { theme: 'auto' },
    count: 6,
    app: 'flyme-web',
    version: 1,
    exportedAt: '2026-10-16T02:00:00.000Z',
  };
}

describe('lib/backupImport · 文件类型识别', () => {
  it('FLYME1 魔数 → 是备份文件', () => {
    expect(looksLikeBackup(enc.encode('FLYME1\x00{}'))).toBe(true);
  });

  it('纯 JSON 明文（网页版手工导出）→ 是备份文件，BOM/空白不干扰', () => {
    expect(looksLikeBackup(enc.encode('{"collections":{}}'))).toBe(true);
    expect(looksLikeBackup(enc.encode('\n\n  {"collections":{}}'))).toBe(true);
    expect(looksLikeBackup(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toBe(true);
  });

  it('图片/压缩包等二进制 → 不是备份文件', () => {
    expect(looksLikeBackup(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(looksLikeBackup(new Uint8Array([]))).toBe(false);
  });

  it('accept 属性同时列出 .flyme 与 .json（Android WebView 靠扩展名过滤）', () => {
    expect(BACKUP_FILE_ACCEPT).toContain('.flyme');
    expect(BACKUP_FILE_ACCEPT).toContain('.json');
  });
});

describe('lib/backupImport · 解析与摘要', () => {
  it('未加密 .flyme → 摘要含条数 / 备份时间 / 来源，且标记未加密', async () => {
    const bytes = await encodeFlyme(makePayload(), '');
    const p = await previewBackupBytes('纳物备份_2026-10-16.flyme', bytes);
    expect(p.encrypted).toBe(false);
    expect(p.count).toBe(6);
    expect(p.exportedAt).toBe('2026-10-16T02:00:00.000Z');
    expect(p.app).toBe('flyme-web');
    expect(p.fileName).toBe('纳物备份_2026-10-16.flyme');
    // payload 原样交给 store 落地，供 applyRestorePayload 使用
    expect(p.payload).toMatchObject({ app: 'flyme-web', count: 6 });
  });

  it('加密 .flyme + 正确密码 → 摘要标记已加密，条数一致', async () => {
    const bytes = await encodeFlyme(makePayload(), 'nawu-2026');
    const p = await previewBackupBytes('cloud.flyme', bytes, 'nawu-2026');
    expect(p.encrypted).toBe(true);
    expect(p.count).toBe(6);
  });

  it('加密 .flyme + 错误密码 → 抛「密码错误，或文件已损坏」', async () => {
    const bytes = await encodeFlyme(makePayload(), 'nawu-2026');
    await expect(previewBackupBytes('cloud.flyme', bytes, 'wrong')).rejects.toThrow('密码错误，或文件已损坏');
  });

  it('加密 .flyme + 密码留空 → 提示需要密码（页面据此弹密码框）', async () => {
    const bytes = await encodeFlyme(makePayload(), 'nawu-2026');
    await expect(previewBackupBytes('cloud.flyme', bytes, '')).rejects.toThrow('该备份已加密，请输入密码');
  });

  it('非备份内容 → 抛「无法识别的文件（不是 .flyme 备份）」', async () => {
    await expect(previewBackupBytes('random.bin', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow(
      '无法识别的文件（不是 .flyme 备份）',
    );
  });

  it('纯 JSON 明文也能导入（跳过 12 集合结构校验的容错），条数按集合实算', async () => {
    const bytes = enc.encode(JSON.stringify({ collections: { goods: [{ id: 'x' }] } }));
    const p = await previewBackupBytes('manual.json', bytes);
    expect(p.count).toBe(1);
    expect(p.encrypted).toBe(false);
  });

  it('文件名为 .flyme 的往返：导出名 → 再解析，条数不丢', async () => {
    const name = flymeFileName('纳物备份', new Date('2026-10-16T02:00:00.000Z'));
    expect(name).toBe('纳物备份_2026-10-16.flyme');
    const bytes = await encodeFlyme(makePayload(), '');
    const p = await previewBackupBytes(name, bytes);
    expect(p.count).toBe(6);
  });
});

describe('lib/backupImport · 读文件（FileReader 路径）', () => {
  const RealFileReader = (globalThis as { FileReader?: unknown }).FileReader;

  afterEach(() => {
    (globalThis as { FileReader?: unknown }).FileReader = RealFileReader;
  });

  /** 注入一个最小 FileReader 替身（node 环境没有 DOM）。 */
  function stubFileReader(result: ArrayBuffer | string | null, fail = false): void {
    class Fake {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result: ArrayBuffer | string | null = null;
      readAsArrayBuffer(): void {
        queueMicrotask(() => {
          if (fail) {
            this.onerror?.();
            return;
          }
          this.result = result;
          this.onload?.();
        });
      }
    }
    (globalThis as { FileReader?: unknown }).FileReader = Fake;
  }

  it('成功：File 的字节被完整读出（保留原始长度与内容）', async () => {
    const raw = await encodeFlyme(makePayload(), '');
    // Uint8Array.buffer 的静态类型是 ArrayBufferLike（ArrayBuffer | SharedArrayBuffer），
    // 而 FileReader.result 只可能是 ArrayBuffer；运行时这里必然是 ArrayBuffer，故断言收窄。
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    stubFileReader(ab);
    const fakeFile = { name: 'a.flyme' } as unknown as File;
    const bytes = await readBackupFile(fakeFile);
    expect(bytes.length).toBe(raw.length);
    expect(looksLikeBackup(bytes)).toBe(true);
  });

  it('失败：读取异常 → 抛中文提示', async () => {
    stubFileReader(null, true);
    await expect(readBackupFile({ name: 'a.flyme' } as unknown as File)).rejects.toThrow('读取备份文件失败');
  });

  it('异常结果类型（非 ArrayBuffer）→ 同样走失败提示，不静默返回空数据', async () => {
    stubFileReader('not-an-arraybuffer');
    await expect(readBackupFile({ name: 'a.flyme' } as unknown as File)).rejects.toThrow('读取备份文件失败');
  });
});
