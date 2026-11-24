/**
 * 备份导出编排：本地快照 / 云端备份 → .flyme 字节 → 落盘 + 系统分享。
 *
 * - 格式见 `flymeFile.ts`（与网页版二进制互通：AES-256-GCM + PBKDF2-SHA256 200k）
 * - 落盘：Capacitor Filesystem（Android Documents 优先，失败降级 App 外部目录）+ Share 弹系统面板
 * - 浏览器环境：走 `<a download>` 直接触发下载（dev/调试用）
 *
 * 分层说明：本文件是 lib 层的组合模块，页面只 import 本文件，
 * 对 store（快照组装）与 api（云备份详情）的依赖集中在此，避免污染页面。
 */

import { getBackup } from '../api/backups';
import type { ServerConfig } from '../types/entities';
import { humanMessage } from './error';
import { encodeFlyme, flymeFileName } from './flymeFile';
import { isNative } from '../net/env';
import { buildCurrentSnapshot } from '../store/backupActions';

/** 导出结果（供 Toast 文案）。 */
export interface BackupExportResult {
  /** 写入/下载的文件名 */
  fileName: string;
  /** 是否加密导出 */
  encrypted: boolean;
}

/**
 * 导出**本地当前数据**为 .flyme 文件并落盘/分享。
 * @param password 密码（可留空 = 不加密）
 */
export async function exportLocalBackup(password = ''): Promise<BackupExportResult> {
  const snapshot = await buildCurrentSnapshot();
  return exportBytes(snapshot, password, flymeLocalName());
}

/**
 * 导出**云端指定备份**为 .flyme 文件并落盘/分享。
 * @param id 云备份 id
 * @param password 密码（可留空 = 不加密）
 * @throws {ApiError} 云端取详情失败 / 加密失败 / 落盘失败
 */
export async function exportCloudBackup(server: ServerConfig | null, id: number | string, password = ''): Promise<BackupExportResult> {
  const detail = await getBackup(server, id);
  const payload = detail.payload;
  return exportBytes(payload, password, flymeCloudName());
}

/** 统一出口：加密 → 落盘 → 分享。 */
async function exportBytes(payload: unknown, password: string, fileName: string): Promise<BackupExportResult> {
  const bytes = await encodeFlyme(payload, password);
  await saveAndShare(fileName, bytes);
  return { fileName, encrypted: (password || '').trim().length > 0 };
}

/** 本地导出文件名（对齐网页版 `da()`：纳物备份_YYYY-MM-DD.flyme）。 */
function flymeLocalName(): string {
  return flymeFileName('纳物备份');
}

/** 云备份导出文件名：加 HHmm 避免同日多份在 Documents 里互相覆盖。 */
function flymeCloudName(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `纳物云备份_${d.toISOString().slice(0, 10)}_${pad(d.getHours())}${pad(d.getMinutes())}.flyme`;
}

/**
 * 把字节写入设备并与系统分享（真机），浏览器环境直接触发下载。
 *
 * @throws {Error} 真机写入与分享均失败时抛出（文案已中文化）
 */
export async function saveAndShare(fileName: string, bytes: Uint8Array): Promise<void> {
  if (isNative()) {
    await nativeSaveAndShare(fileName, bytes);
    return;
  }
  webDownload(fileName, bytes);
}

/** Android 分享面板被占用时的兜底文案（文件已落盘，不能让用户以为导出失败丢数据）。 */
export const SHARE_BUSY_FALLBACK_TEXT =
  '文件已保存到 Documents，分享面板被占用，可稍后在文件管理器中取用';

/** 关闭应用内弹层后、调起分享面板前的缓冲（避免与弹层关闭动画叠加触发并发分享）。 */
export const SHARE_DEFER_MS = 300;
/** 「分享进行中」错误的自动重试延迟（ms，v0.7.1 反馈：Android 分享面板并发冲突）。 */
export const SHARE_BUSY_RETRY_DELAY_MS = 1200;

/** 默认延时实现（可注入替换，便于单测）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 判定是否「分享面板被占用」类错误。
 * Android 上重复调 Share.share() 抛 "Can't share while sharing is in progress"。
 */
export function isShareBusyError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /in progress/i.test(msg);
}

/**
 * 带重试的分享：命中「sharing in progress」类错误时延迟后自动重试一次；
 * 重试仍占用 → 抛 {@link SHARE_BUSY_FALLBACK_TEXT}（文件此时已落盘）；
 * 其他错误原样上抛（如用户取消，由页面按普通失败提示）。
 *
 * @param doShare 实际执行分享的动作（可注入，便于单测）
 * @param opts.retries 重试次数（默认 1）
 * @param opts.delayMs 重试延迟（默认 {@link SHARE_BUSY_RETRY_DELAY_MS}）
 * @param opts.sleep 延时实现（可注入，便于单测）
 */
export async function shareWithRetry(
  doShare: () => Promise<void>,
  opts: { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const retries = opts.retries ?? 1;
  const delayMs = opts.delayMs ?? SHARE_BUSY_RETRY_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      await doShare();
      return;
    } catch (e) {
      if (!isShareBusyError(e)) throw e;
      if (attempt >= retries) throw new Error(SHARE_BUSY_FALLBACK_TEXT);
      await sleep(delayMs);
    }
  }
}

/**
 * 分享串行化队列（模块级）：保证同一时刻只有一个 Share intent 在途，
 * 防连点/排队重复触发 "Can't share while sharing is in progress"。
 */
let shareQueue: Promise<void> = Promise.resolve();

function enqueueShare(task: () => Promise<void>): Promise<void> {
  const run = shareQueue.then(task, task);
  // 无论成败，链条继续（吞掉结果只保留时序）
  shareQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 真机：Filesystem 写入 → Share 弹系统分享/保存面板。 */
async function nativeSaveAndShare(fileName: string, bytes: Uint8Array): Promise<void> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const data = bytesToBase64(bytes);
  let uri: string | undefined;
  // Documents 在 Android 10 旧版存储模式下可能不可写，逐级降级到应用专属目录
  const dirs = [Directory.Documents, Directory.External, Directory.Data];
  let lastError: unknown = null;
  for (const directory of dirs) {
    try {
      const res = await Filesystem.writeFile({ path: fileName, data, directory, recursive: true });
      uri = res.uri;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!uri) {
    throw new Error(`备份文件写入失败：${humanMessage(lastError)}`);
  }
  // ★时序：应用内密码弹层先关、等一拍再调起系统分享面板（v0.7.1 并发修复）
  await defaultSleep(SHARE_DEFER_MS);
  // ★防重：串行队列 + busy 错误自动重试一次（文件已落盘，重试只影响分享面板）
  await enqueueShare(() =>
    shareWithRetry(async () => {
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: fileName,
        url: uri,
        dialogTitle: '保存或分享备份文件',
      });
    }),
  );
}

/** 浏览器兜底：`<a download>` 触发下载。 */
function webDownload(fileName: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Uint8Array → base64（分块避免 String.fromCharCode 爆栈）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
