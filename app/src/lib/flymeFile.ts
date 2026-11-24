/**
 * .flyme 备份文件格式（与纳物网页版**二进制互通**）。
 *
 * ★格式对齐网页版 SPA bundle（构建产物 assets/index-*.js，
 * 常量 `oa="FLYME1"`、`wm=2e5`，加密走 WebCrypto，降级 noble pbkdf2/gcm）：
 *
 * ```
 * 字节布局：
 *   [0..5]   魔数 ASCII "FLYME1"（6 字节）
 *   [6]      版本：0 = 未加密（后跟明文 JSON UTF-8）；1 = 加密
 *   -- 版本 1 --
 *   [7..22]   salt   16 字节随机（PBKDF2）
 *   [23..34]  iv     12 字节随机（AES-GCM nonce）
 *   [35..]    AES-256-GCM 密文（WebCrypto 输出，末尾含 16 字节 tag）
 * ```
 *
 * 密钥派生：PBKDF2(password, salt, iterations=200_000, hash=SHA-256)，dkLen=32 字节，
 * 用作 AES-GCM-256 密钥。明文为 `JSON.stringify(payload)` 的 UTF-8 编码。
 *
 * 与网页版互通性：网页版 `ca()`（导出）与 `vu()`（导入）按同样布局/参数处理，
 * 本模块的输出可直接被网页版「导入 .flyme」解开，反之亦然（tests/flyme-file.test.ts 覆盖往返）。
 */

import { ApiError } from './error';

/** 魔数（6 字节 ASCII，网页版常量 oa）。 */
const MAGIC = 'FLYME1';
/** 版本字节：未加密。 */
const VERSION_PLAIN = 0;
/** 版本字节：加密。 */
const VERSION_ENCRYPTED = 1;
/** PBKDF2 迭代次数（网页版常量 wm = 2e5）。 */
export const FLYME_PBKDF2_ITERATIONS = 200_000;
/** PBKDF2 salt 长度（字节）。 */
const SALT_LEN = 16;
/** AES-GCM IV 长度（字节）。 */
const IV_LEN = 12;
/** 加密头总长：魔数 6 + 版本 1 + salt 16 + iv 12。 */
const ENC_HEADER_LEN = 6 + 1 + SALT_LEN + IV_LEN;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function getSubtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new ApiError('parse', '当前环境不支持 Web Crypto，无法加解密备份', undefined, null);
  }
  return c.subtle;
}

/** 由密码派生 AES-GCM-256 密钥（参数与网页版逐字节一致）。 */
async function deriveKey(subtle: SubtleCrypto, password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: FLYME_PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 备份内容是否为 .flyme 格式（网页版 `x1()`：前 6 字节 == "FLYME1"）。 */
export function isFlyme(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 6) return false;
  const head = decoder.decode(bytes.subarray(0, 6));
  return head === MAGIC;
}

/** 是否「已加密的 .flyme」（网页版 `yu()`：魔数 + 版本字节 1）。 */
export function isEncryptedFlyme(bytes: Uint8Array): boolean {
  return isFlyme(bytes) && bytes.byteLength >= 7 && bytes[6] === VERSION_ENCRYPTED;
}

/**
 * 序列化备份为 .flyme 字节。
 *
 * @param payload 备份 JSON（SnapshotPayload 或任意可 JSON 化对象）
 * @param password 密码；trim 后为空 = 不加密（版本 0 明文）
 * @throws {ApiError} 环境不支持 Web Crypto 时抛出
 */
export async function encodeFlyme(payload: unknown, password = ''): Promise<Uint8Array> {
  const json = encoder.encode(JSON.stringify(payload));
  const pwd = (password || '').trim();

  if (!pwd) {
    const out = new Uint8Array(7 + json.length);
    out.set(encoder.encode(MAGIC), 0);
    out[6] = VERSION_PLAIN;
    out.set(json, 7);
    return out;
  }

  const subtle = getSubtle();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(subtle, pwd, salt);
  let ct: Uint8Array;
  try {
    ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, json as BufferSource));
  } catch (e) {
    throw new ApiError('parse', '备份加密失败', undefined, e instanceof Error ? e.message : e);
  }

  const out = new Uint8Array(ENC_HEADER_LEN + ct.length);
  out.set(encoder.encode(MAGIC), 0);
  out[6] = VERSION_ENCRYPTED;
  out.set(salt, 7);
  out.set(iv, 7 + SALT_LEN);
  out.set(ct, ENC_HEADER_LEN);
  return out;
}

/**
 * 解析 .flyme 字节为备份 JSON（网页版 `vu()` 同逻辑，含错误文案对齐）。
 *
 * @param bytes 文件字节
 * @param password 密码（未加密文件可留空）
 * @throws {ApiError} kind='parse'：不是 .flyme / 已损坏 / 缺密码 / 密码错误
 */
export async function decodeFlyme(bytes: Uint8Array, password = ''): Promise<unknown> {
  if (!isFlyme(bytes)) {
    // 网页版兼容：非魔数时尝试按纯 JSON 解
    try {
      return JSON.parse(decoder.decode(bytes));
    } catch {
      throw new ApiError('parse', '无法识别的文件（不是 .flyme 备份）', undefined, null);
    }
  }
  if (bytes.byteLength < 7) {
    throw new ApiError('parse', '备份文件已损坏', undefined, null);
  }
  const version = bytes[6];
  if (version === VERSION_PLAIN) {
    try {
      return JSON.parse(decoder.decode(bytes.subarray(7)));
    } catch {
      throw new ApiError('parse', '备份文件已损坏', undefined, null);
    }
  }

  const pwd = (password || '').trim();
  if (!pwd) throw new ApiError('parse', '该备份已加密，请输入密码', undefined, null);
  if (bytes.byteLength < ENC_HEADER_LEN) {
    throw new ApiError('parse', '备份文件已损坏', undefined, null);
  }

  const salt = bytes.subarray(7, 7 + SALT_LEN);
  const iv = bytes.subarray(7 + SALT_LEN, ENC_HEADER_LEN);
  const ct = bytes.subarray(ENC_HEADER_LEN);

  const subtle = getSubtle();
  const key = await deriveKey(subtle, pwd, salt);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource));
  } catch {
    throw new ApiError('parse', '密码错误，或文件已损坏', undefined, null);
  }
  try {
    return JSON.parse(decoder.decode(plain));
  } catch {
    throw new ApiError('parse', '备份文件已损坏', undefined, null);
  }
}

/** 导出文件名（对齐网页版 `da()`：`${prefix}_${YYYY-MM-DD}.flyme`）。 */
export function flymeFileName(prefix = '纳物备份', date = new Date()): string {
  return `${prefix}_${date.toISOString().slice(0, 10)}.flyme`;
}
