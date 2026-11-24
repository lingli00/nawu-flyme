import { get, post } from '../net/httpClient';
import logger from './log';
import { isLoggedIn } from '../store/useAuthStore';
import { currentServer } from '../store/useServerStore';
import type { ServerConfig } from '../types/entities';

/**
 * ★v1.8.0 图片云托管（内容寻址）—— 本地与传输链路里不再出现 base64。
 *
 * 背景（用户反馈）：物品图片一直以 base64 内嵌在记录里，本地 localStorage
 * 从 600KB 涨到 1.8MB；每次备份/同步都把整张图重传一遍，弱网卡顿几秒。
 *
 * 形态演进（三段共存，渲染层全部兼容）：
 *   `{source:'local',  ref:'data:image/…'}`        ← 存量数据（离线/未登录仍用）
 *   `{source:'cloud',  ref:'/api/user/images/<sha>?t=&s=', sha256, …}`  ← 新形态
 *   `url:<远程直链>`（web 形态，老逻辑不动）
 *
 * 三条铁律（本文件的「保守」全部围绕它们）：
 *   1. **不丢图**：任何上传失败 → 记录保持 base64，下轮再试；只有确认云端已有该 sha256
 *      才允许把 base64 从本地抹掉（`dropLocalBase64` 只在 PUT/LIST 确认后进行）。
 *   2. **离线可用**：没登录 / 没服务器 / 离线 → 全部短路上报失败，绝不阻塞主流程。
 *   3. **渲染不崩**：解析失败一律返回空串，由调用方兜底；本层对外永不抛异常。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 托管后本地要保留的缩略图边长（px）：体积 ≈ 3~6KB，保证离线/URL 过期时仍能显示。 */
export const CLOUD_THUMB_DIM = 256;
/** 缩略图 JPEG 质量。 */
export const CLOUD_THUMB_QUALITY = 0.6;
/** 渲染签名 URL 有效期（与服务端 GF_ImageStore::SIGN_TTL 一致：24h）。 */
export const SIGN_TTL = 86400;
/** 传输链路瘦身时，base64 短于它才允许内嵌进 payload（否则只留引用，避免又把 base64 带上云端）。 */
export const INLINE_BASE64_MAX = 4096;

const EP_IMAGES = '/api/user/images';
const EP_IMAGES_LIST = '/api/user/images/list';
const EP_IMAGES_SIGN = '/api/user/images/sign';
const EP_IMAGES_GC = '/api/user/images/gc';

/* ------------------------------------------------------------------ */
/* sha256（浏览器 SubtleCrypto / Node webcrypto 通用）                  */
/* ------------------------------------------------------------------ */

/**
 * 任意字符串 → 小写十六进制 sha256；环境不支持 / 失败返回 null（调用方降级，不抛）。
 *
 * ⚠️ 这里算的是**字符串的 UTF-8 字节**的 sha256（不是 base64 解码后的图片字节），
 * 与服务端 `GF_ImageStore::put()` 完全一致 —— 两端必须同源，否则永远对不上、每次都重传。
 */
export async function sha256Hex(text: string): Promise<string | null> {
  try {
    const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
    if (!subtle) return null;
    const data = new TextEncoder().encode(text);
    const digest = await subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  } catch {
    return null;
  }
}

/** 纯同步、零依赖的图片引用哈希（仅在 SubtleCrypto 不可用时兜底，只用于本地缓存键）。 */
export function weakHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `w${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/* ------------------------------------------------------------------ */
/* 形态判定（纯函数，渲染层与迁移共用）                                  */
/* ------------------------------------------------------------------ */

/** 云端图引用形态（localshape，可来自 dialogue / @deprecated 等任意文本）。 */
export interface CloudImageRef {
  url: string;
  sha256?: string;
}

const IMAGES_PATH_RE = /^\/api\/user\/images\/([0-9a-f]{64})(?:[?#]|$)/i;
const IMAGES_ABS_RE = /^https?:\/\/[^/]+\/api\/user\/images\/([0-9a-f]{64})/i;

/** 从任意云端图片 URL（相对/绝对/带签名）里取 sha256；取不到返回 ''。 */
export function shaFromImageUrl(url: string): string {
  const u = (url ?? '').trim();
  if (!u) return '';
  const abs = IMAGES_ABS_RE.exec(u);
  if (abs) return abs[1].toLowerCase();
  const rel = IMAGES_PATH_RE.exec(u);
  if (rel) return rel[1].toLowerCase();
  return '';
}

/** 是否云端图片 URL（`/api/user/images/<sha>` 或服务器上的绝对地址）。 */
export function isCloudImageUrl(url: string): boolean {
  return shaFromImageUrl(url) !== '';
}

/** 字符串是否「云端引用」：`cloud:<url>` / `cloud:<sha>` / 直接的 `/api/user/images/<sha>`。 */
export function isCloudRefString(v: string): boolean {
  const s = (v ?? '').trim();
  if (!s) return false;
  if (s.startsWith('cloud:')) return s.length > 6;
  return isCloudImageUrl(s);
}

/**
 * 云端引用 → 可用于 `<img src>` 的 URL（相对路径；App 内由渲染层拼服务器地址）。
 * 解析失败返回 ''（调用方兜底），**不抛异常**。
 */
export function cloudSrcOf(v: string): string {
  const s = (v ?? '').trim();
  if (!s) return '';
  if (s.startsWith('cloud:')) {
    const body = s.slice(6).trim();
    if (!body) return '';
    if (isCloudImageUrl(body)) return body;
    const sha = /^[0-9a-f]{64}$/i.test(body) ? body.toLowerCase() : '';
    return sha ? `${EP_IMAGES}/${sha}` : '';
  }
  if (isCloudImageUrl(s)) return s.startsWith('/') ? s : s.replace(/^https?:\/\/[^/]+/i, '');
  return '';
}

/* ------------------------------------------------------------------ */
/* 渲染签名：内存缓存 + 过期重签                                        */
/* ------------------------------------------------------------------ */

interface SignEntry {
  url: string;
  /** 签名过期时间（秒）。 */
  exp: number;
}

/** sha256 → 签名 URL（内存；页面刷新后重新签，不落盘 —— 签名不该进本地存储）。 */
const signCache = new Map<string, SignEntry>();

/** 从一条签名 URL 里读出 t 参数（秒）；读不到返回 0。 */
export function signExpiryOf(url: string): number {
  const m = /[?&]t=(\d+)/.exec(url ?? '');
  return m ? Number(m[1]) || 0 : 0;
}

/**
 * 取一张图的「当前可用」渲染 URL。
 *
 * - 缓存里的签名还剩 > 2 小时 → 直接返回（零网络）；
 * - 没有 / 快过期 / 传入的 URL 已过期 → 用 `cacheKey`（引用字符串哈希）做内存键，
 *   同步返回「旧 URL」先顶上（避免首帧空白），后台异步重签。
 *
 * ★同步函数：渲染层在 useState 初始化里直接调用，不能等。
 */
export function renderUrlFor(sha: string | undefined, givenUrl = '', cacheKey = ''): string {
  const s = (sha ?? '').trim().toLowerCase();
  void cacheKey;
  const now = Math.floor(Date.now() / 1000);
  if (s) {
    const hit = signCache.get(s);
    if (hit && hit.exp - now > 7200) return hit.url;
  }
  if (givenUrl) {
    const exp = signExpiryOf(givenUrl);
    if (exp === 0 || exp - now > 7200) return givenUrl;
    // 已过期：先用旧 URL（浏览器强缓存仍可命中），同时后台重签
  }
  if (s) {
    void resign(s).catch(() => undefined);
    // 手上没有任何 URL 时，先给一个**无签名**的路径顶上（同源 Cookie 还能救）
    return givenUrl || signCache.get(s)?.url || `${EP_IMAGES}/${s}`;
  }
  return givenUrl;
}

/** 批量重签（去重、失败静默）。渲染层发现 401/破图时可主动调用。 */
const resigning = new Map<string, Promise<void>>();
async function resign(sha: string): Promise<void> {
  const running = resigning.get(sha);
  if (running) return running;
  const task = (async () => {
    try {
      const server = currentServer();
      if (!server || !isLoggedIn()) return;
      const res = await get<{ ok?: boolean; urls?: Record<string, string> }>(server, EP_IMAGES_SIGN, { sha });
      const url = res.data?.urls?.[sha];
      if (typeof url === 'string' && url) {
        signCache.set(sha, { url, exp: signExpiryOf(url) || Math.floor(Date.now() / 1000) + SIGN_TTL });
      }
    } catch {
      /* 离线 / 未登录 / 老服务器：保留旧 URL，渲染层走兜底 */
    } finally {
      resigning.delete(sha);
    }
  })();
  resigning.set(sha, task);
  return task;
}

/**
 * ★v1.8.8：**可 await** 的签名入口（渲染层用）。
 *
 * 与 `renderUrlFor()` 的区别：后者是同步的，缓存未命中时只能返回裸路径 + 后台重签，
 * 组件不会因为后台完成而重渲染 → `<img>` 拿裸路径吃 401、永久白块（实测踩到）。
 * 这里返回 Promise，调用方 `await` 后 `signCache` 一定已更新，重渲染即可拿到签名 URL。
 *
 * @returns 签名后的相对 URL（失败返回空串，调用方据此兜底）
 */
export async function signCloudUrl(sha: string): Promise<string> {
  const s = (sha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) return '';
  const now = Math.floor(Date.now() / 1000);
  const hit = signCache.get(s);
  if (hit && hit.exp - now > 600) return hit.url;
  await resign(s);
  return signCache.get(s)?.url ?? '';
}

/** 把一条上传/列表接口返回的签名 URL 记进缓存（省一次重签请求）。 */
export function rememberSignedUrl(sha: string, url: string): void {
  if (!sha || !url) return;
  signCache.set(sha.toLowerCase(), {
    url,
    exp: signExpiryOf(url) || Math.floor(Date.now() / 1000) + SIGN_TTL,
  });
}

/**
 * 图片加载失败时的重签（★v1.8.0 渲染兜底）。
 *
 * 场景：签名 URL 放超过了有效期（记录在库里存的是最后一次签发的那条）、
 * 或服务器换了 secret —— `<img>` 直接 401/404。这里把缓存里的这条签名作废，
 * 后台重新签一张，下一次渲染自然换成新 URL。渲染层调用它**绝不能阻塞**。
 */
export function resignBrokenUrl(url: string): void {
  const sha = shaFromImageUrl(url);
  if (!sha) return;
  const cur = signCache.get(sha);
  if (cur && cur.url === url) signCache.delete(sha);
  void resign(sha).catch(() => undefined);
}

/** 测试 / 调试用：清空签名缓存。 */
export function clearSignCache(): void {
  signCache.clear();
}

/* ------------------------------------------------------------------ */
/* 渲染 URL → 服务器绝对地址（App 内 window 源是 https://localhost）     */
/* ------------------------------------------------------------------ */

/** 相对路径 → 服务器绝对地址（浏览器同源时原样返回）。 */
export function absoluteImageUrl(url: string, base?: string): string {
  const u = (url ?? '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  const b = (base ?? currentServer()?.url ?? '').replace(/\/+$/, '');
  if (b) return `${b}${u.startsWith('/') ? '' : '/'}${u}`;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${u.startsWith('/') ? '' : '/'}${u}`;
  }
  return u;
}

/* ------------------------------------------------------------------ */
/* 上传 / 差异比对                                                      */
/* ------------------------------------------------------------------ */

/** 上传结果（失败时 ok=false，调用方据此保留 base64）。 */
export interface UploadResult {
  ok: boolean;
  sha256: string;
  url: string;
  deduped: boolean;
  error?: string;
}

/** 该环境是否可能上传（登录 + 有服务器；离线时请求会失败并被吞掉）。 */
export function cloudAvailable(): boolean {
  try {
    return Boolean(currentServer()) && isLoggedIn();
  } catch {
    return false;
  }
}

/**
 * 上传一张图（dataURL / 裸 base64 / http(s) 直链）。
 *
 * - http(s) 直链：先走「本地图标缓存 / 网络层」抓成 dataURL 再上传（不裸连 WebView）；
 * - 服务器已存在同内容 → 服务端秒返回（deduped:true），客户端不会再下发字节；
 * - 任何失败都返回 `{ok:false}`，**绝不抛异常**（业务主流程不能被图片拖死）。
 */
export async function uploadImage(src: string): Promise<UploadResult> {
  const raw = (src ?? '').trim();
  if (!raw) return { ok: false, sha256: '', url: '', deduped: false, error: 'empty' };
  const server = currentServer();
  if (!server || !isLoggedIn()) {
    return { ok: false, sha256: '', url: '', deduped: false, error: 'offline-or-guest' };
  }
  try {
    let payload = raw;
    if (/^https?:\/\//i.test(raw)) {
      const fetched = await fetchRemoteDataUrl(raw);
      if (!fetched) return { ok: false, sha256: '', url: '', deduped: false, error: 'fetch-failed' };
      payload = fetched;
    }
    const res = await post<{
      ok?: boolean;
      sha256?: string;
      url?: string;
      deduped?: boolean;
      error?: string;
    }>(server, EP_IMAGES, { image: payload }, 30000);
    const d = res.data;
    if (!d || d.ok !== true || typeof d.sha256 !== 'string' || !d.sha256) {
      return { ok: false, sha256: '', url: '', deduped: false, error: d?.error ?? 'upload-failed' };
    }
    if (typeof d.url === 'string' && d.url) rememberSignedUrl(d.sha256, d.url);
    return { ok: true, sha256: d.sha256, url: d.url ?? '', deduped: d.deduped === true };
  } catch (e) {
    logger.warn('imageCloud', '图片上传失败（保留本地 base64，下轮重试）', e);
    return { ok: false, sha256: '', url: '', deduped: false, error: 'request-failed' };
  }
}

/** 远程图 → dataURL（走网络层并发闸，绕开 WebView 直连）。 */
async function fetchRemoteDataUrl(url: string): Promise<string | null> {
  try {
    const { fetchIconAsDataUrl } = await import('./iconCache');
    return await fetchIconAsDataUrl(url, 8_000_000);
  } catch {
    return null;
  }
}

/** 云端已托管图片的 sha256 列表（失败返回 null = 未知，调用方按「全都要上传」保守处理）。 */
const listCache = new Map<string, Set<string>>();

export async function fetchCloudHashes(server: Pick<ServerConfig, 'id' | 'url'> | null = currentServer()): Promise<Set<string> | null> {
  if (!server || !isLoggedIn()) return null;
  try {
    const res = await get<{ ok?: boolean; hashes?: unknown }>(server, EP_IMAGES_LIST, undefined, 20000);
    const arr = Array.isArray(res.data?.hashes) ? (res.data?.hashes as unknown[]) : [];
    const set = new Set(arr.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h)).map((h) => h.toLowerCase()));
    listCache.set(sidOf(server), set);
    return set;
  } catch (e) {
    logger.warn('imageCloud', '云端图片列表获取失败（按全量上传处理）', e);
    return null;
  }
}

function sidOf(server: Pick<ServerConfig, 'id' | 'url'>): string {
  return (server as ServerConfig).id || server.url || 'default';
}

/** 本进程内已确认存在的 sha256（上传/LIST 之后登记，少发一次 LIST）。 */
const knownCloud = new Map<string, Set<string>>();

function knownFor(sid: string): Set<string> {
  let s = knownCloud.get(sid);
  if (!s) {
    s = new Set<string>();
    knownCloud.set(sid, s);
  }
  return s;
}

/** 记录「这张图云端已经有了」（上传/LIST 成功后调用）。 */
export function markCloudKnown(sha: string, server: Pick<ServerConfig, 'id' | 'url'> | null = currentServer()): void {
  if (!sha || !server) return;
  knownFor(sidOf(server)).add(sha.toLowerCase());
}

/** 这张图云端是否已确认存在（只看内存，不发请求）。 */
export function isCloudKnown(sha: string, server: Pick<ServerConfig, 'id' | 'url'> | null = currentServer()): boolean {
  if (!sha || !server) return false;
  const s = sha.toLowerCase();
  return knownFor(sidOf(server)).has(s) || (listCache.get(sidOf(server))?.has(s) ?? false);
}

/* ------------------------------------------------------------------ */
/* 缩略图（离线兜底）                                                   */
/* ------------------------------------------------------------------ */

/**
 * dataURL → 一张小缩略图（≤256px JPEG，约 3~6KB）。
 *
 * 为什么托管后**还要留**一张缩略图：云端进不去的场景（离线、URL 过期、老服务器、
 * 换服务器）用户至少还能看见图，而不是满屏灰块 —— 这是「不丢图」的最后一层。
 * 任何失败原样返回（宁可大一点，也不能丢图）。
 */
export async function makeThumbDataUrl(dataUrl: string, dim = CLOUD_THUMB_DIM, quality = CLOUD_THUMB_QUALITY): Promise<string> {
  const src = (dataUrl ?? '').trim();
  if (!src.startsWith('data:image/')) return src;
  try {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return compressFallback(src, dim);
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      const t = setTimeout(() => resolve(null), 6000);
      el.onload = () => {
        clearTimeout(t);
        resolve(el);
      };
      el.onerror = () => {
        clearTimeout(t);
        resolve(null);
      };
      el.src = src;
    });
    if (!img) return src;
    const nw = img.naturalWidth || img.width;
    const nh = img.naturalHeight || img.height;
    if (!nw || !nh) return src;
    const scale = Math.min(1, dim / Math.max(nw, nh));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(nw * scale));
    cv.height = Math.max(1, Math.round(nh * scale));
    const ctx = cv.getContext('2d');
    if (!ctx) return src;
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const out = cv.toDataURL('image/jpeg', quality);
    return out.startsWith('data:image/jpeg') && out.length < src.length ? out : src;
  } catch {
    return src;
  }
}

/** 无 canvas 环境（测试 / 特殊 WebView）回落既有压缩器。 */
async function compressFallback(src: string, dim: number): Promise<string> {
  try {
    const { compressDataUrlUnder } = await import('./imageCompress');
    return await compressDataUrlUnder(src, 8, dim);
  } catch {
    return src;
  }
}

/* ------------------------------------------------------------------ */
/* 回收（可选、手动）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 让服务端回收「本账号已不再被引用」的图。
 *
 * 只有调用方**明确传了**本机在用的 sha256 列表才发请求（服务端也拒绝空清单之外的口径）——
 * 任何拿不准的情况（本地列表不全）都不该清云端，宁可留冗余也不能丢图。
 */
export async function gcCloudImages(referenced: string[]): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const server = currentServer();
  if (!server || !isLoggedIn()) return { ok: false, deleted: 0, error: 'offline-or-guest' };
  try {
    const res = await post<{ ok?: boolean; deleted?: number; error?: string }>(server, EP_IMAGES_GC, { referenced });
    if (!res.data || res.data.ok !== true) {
      return { ok: false, deleted: 0, error: res.data?.error ?? 'gc-failed' };
    }
    return { ok: true, deleted: Number(res.data.deleted ?? 0) || 0 };
  } catch (e) {
    logger.warn('imageCloud', '云端图片回收失败（不影响本地）', e);
    return { ok: false, deleted: 0, error: 'request-failed' };
  }
}

/**
 * 探测服务器是否支持图片托管（老服务器没有 `/api/user/images/list`）。
 * `request` 直接引用是为了保留统一错误归类；返回 false 时上层**完全不启用**云端图。
 */
export async function cloudSupported(): Promise<boolean> {
  const server = currentServer();
  if (!server || !isLoggedIn()) return false;
  try {
    const res = await get<{ ok?: boolean }>(server, EP_IMAGES_LIST, undefined, 8000);
    return res.status === 200 && res.data !== null;
  } catch {
    return false;
  }
}