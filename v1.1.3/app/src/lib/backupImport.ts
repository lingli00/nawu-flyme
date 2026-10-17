/**
 * 备份**导入**编排（v1.0.34 补齐「只能导出、不能导入」的缺口）。
 *
 * 之前的闭环是：本机/云端数据 → 导出成 .flyme 文件（`backupExport.ts`），
 * 但**没有任何入口把 .flyme 文件塞回应用**——用户换机、误删、重装后
 * 手里拿着备份文件却无处可用。本模块补上「文件 → 预览 → 落到本机」这一段。
 *
 * 分层与导出侧对称：
 *   - 本文件（lib）：读文件字节 + 解析 .flyme + 算出给用户看的摘要；
 *   - `store/backupActions.ts`：真正落库（覆盖本机数据 + 图标缓存）；
 *   - `pages/BackupPage.tsx`：只负责交互与文案。
 *
 * 格式完全复用 `flymeFile.ts`（AES-256-GCM + PBKDF2-SHA256 200k，与网页版互通），
 * 因此 App 能导入网页版导出的文件，反之亦然。
 */

import { decodeFlyme, isEncryptedFlyme, isFlyme } from './flymeFile';
import { applySnapshot, snapshotItemCount } from '../storage/snapshot';
import type { SnapshotPayload } from '../types/api';

/** 解析成功的备份文件摘要（预览弹层用）。 */
export interface BackupFilePreview {
  /** 选中文件的文件名 */
  fileName: string;
  /** 是否加密（加密文件必须输对密码才能走到这里） */
  encrypted: boolean;
  /** 备份里的记录条数（12 个集合合计） */
  count: number;
  /** 备份导出时间（ISO 字符串，快照里没有时为空串） */
  exportedAt: string;
  /** 快照声明的来源标识（flyme-web / flyme-android，缺失为空串） */
  app: string;
  /** 解析后的原始 payload，交给 store 落地 */
  payload: unknown;
}

/** 浏览器 / WebView 允许选择的备份文件扩展名（含网页版可能存在的 .json 明文备份）。 */
export const BACKUP_FILE_ACCEPT = '.flyme,.json,application/octet-stream,application/json';

/**
 * 读取用户选中的备份文件为字节。
 *
 * ★用 FileReader 而不是 `file.arrayBuffer()`：后者在低版本 Android WebView
 * （系统内核 76 以下）不存在，而 FileReader 从 Android 4.4 起就有。
 *
 * @throws {Error} 读取失败（文案已中文化）
 */
export function readBackupFile(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取备份文件失败，请确认文件未损坏'));
    reader.onload = () => {
      const buf = reader.result;
      if (buf instanceof ArrayBuffer) {
        resolve(new Uint8Array(buf));
      } else {
        reject(new Error('读取备份文件失败，请确认文件未损坏'));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * 解析备份字节 → 预览摘要。
 *
 * @param bytes 文件字节
 * @param password 密码（未加密文件可留空）
 * @throws {ApiError} kind='parse'：不是备份文件 / 已损坏 / 缺密码 / 密码错误
 */
export async function previewBackupBytes(
  fileName: string,
  bytes: Uint8Array,
  password = '',
): Promise<BackupFilePreview> {
  const encrypted = isEncryptedFlyme(bytes);
  const payload = await decodeFlyme(bytes, password);
  // applySnapshot 负责把集合补成 12 个并校验结构，坏文件会在这里抛 parse 错误
  const applied = applySnapshot(payload as SnapshotPayload, null);
  const src = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const app = typeof src.app === 'string' ? src.app : '';
  return {
    fileName,
    encrypted,
    count: snapshotItemCount(applied),
    exportedAt: applied.exportedAt,
    app,
    payload,
  };
}

/** 文件是否「看起来像」备份（.flyme 魔数或 JSON 明文），用于选错文件时提前给提示。 */
export function looksLikeBackup(bytes: Uint8Array): boolean {
  if (isFlyme(bytes)) return true;
  // 允许网页版/手工导出的纯 JSON 备份：跳过 BOM 与空白后首字符是 {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf || bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) {
    i += 1;
  }
  return bytes[i] === 0x7b;
}
