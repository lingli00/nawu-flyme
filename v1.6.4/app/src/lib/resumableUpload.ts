/**
 * ★v1.5.1 分片断点续传上传（云备份用；接口见 server/app/Api.php /api/user/uploads/*）。
 *
 * 需求：上传类要支持分片断点续传——退出界面、断网、App 重启后重新进入，
 * 能从上次进度继续，不能从头再传。
 *
 * 做法：
 * - 备份内容算一个稳定的 `key`（大小 + 内容哈希），服务端按 key 落分片目录；
 * - 首片前先 `init`，服务端返回**已收字节**，客户端据此算出下一片序号；
 * - 每片单独 POST（1MB 一片，base64），失败按 3 次退避重试；
 * - 全部片到齐后 `finish`，服务端拼接 + 校验总长度 + 落库 + 清理分片；
 * - 进度另存 localStorage（`nawu-upload-<key>`），用于界面提示与断点判断。
 *
 * 老服务器没有这些接口（404）时抛 `UPLOAD_UNSUPPORTED`，调用方回落单次 POST。
 */

export const UPLOAD_UNSUPPORTED = 'upload-unsupported';

/** 默认分片大小（1MB，base64 后约 1.4MB，稳在常见 PHP post_max_size 之下）。 */
export const UPLOAD_CHUNK = 1024 * 1024;

export interface UploadProgress {
  sent: number;
  total: number;
  pct: number;
}

/** 稳定 key：大小 + FNV-1a 32 位哈希（同一份备份重试时 key 不变）。 */
export function uploadKey(payload: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `bk-${payload.length}-${h.toString(16)}`;
}

/** 续传进度（localStorage，key 维度）。 */
export function readUploadProgress(key: string): number {
  try {
    return Number(localStorage.getItem(`nawu-upload-${key}`) ?? '0') || 0;
  } catch {
    return 0;
  }
}

export function writeUploadProgress(key: string, sent: number): void {
  try {
    localStorage.setItem(`nawu-upload-${key}`, String(sent));
  } catch {
    /* 隐私模式忽略 */
  }
}

export function clearUploadProgress(key: string): void {
  try {
    localStorage.removeItem(`nawu-upload-${key}`);
  } catch {
    /* 忽略 */
  }
}

/** 按分片切分（返回 base64 片段；纯函数，便于单测）。 */
export function splitChunks(payload: string, chunk = UPLOAD_CHUNK): string[] {
  const out: string[] = [];
  for (let i = 0; i < payload.length; i += chunk) out.push(payload.slice(i, i + chunk));
  return out.length ? out : [''];
}

/** UTF-8 安全的 base64（中文字符串不能直接 btoa）。 */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}
