import { isNoAuthPath } from '../api/endpoints';
import { ApiError, ERROR_TEXT } from '../lib/error';
import logger from '../lib/log';
import { joinUrl, normalizeServerUrl } from '../lib/url';
import type { ServerConfig } from '../types/entities';
import {
  classifyFetchError,
  classifyNativeError,
  classifyParseError,
  classifyStatus,
  classifyUnknownError,
  extractServerError,
} from './errors';
import { isDevProxy, isNative } from './env';

/**
 * ★R1 网络层唯一出口。
 *
 * - 真机：`CapacitorHttp`（原生层发请求，绕开同源策略与预检）
 * - 浏览器 dev：`fetch('/api/...')` + Vite `server.proxy`
 * - 浏览器生产（静态部署）：`fetch(server.url + path)`，会被 CORS 拦，仅作兜底
 *
 * 铁律：页面/组件/store **禁止**裸 `fetch` 或直接用 `CapacitorHttp`。
 */

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  /** 必须以 '/api' 开头 */
  path: string;
  /** 会被 JSON.stringify（★F1：后端只解析 JSON body） */
  body?: unknown;
  /** 原始请求体（v1.0.36：后台发布 APK 用，优先级高于 body，原样透传不做序列化） */
  rawBody?: ArrayBuffer | string;
  /** 覆盖 Content-Type（v1.0.36：APK 上传用 application/vnd.android.package-archive） */
  contentType?: string;
  query?: Record<string, string | number>;
  /** 默认 15000；health 用 8000 */
  timeoutMs?: number;
  /** 默认 true → 注入 Bearer；显式 false 或命中白名单时不注入 */
  auth?: boolean;
  /** 默认：GET=1，其它=0 */
  retry?: number;
  /** 仅 fetch 分支生效 */
  signal?: AbortSignal;
  /** 默认 true：要求响应体含 `ok` 字段，否则按 parse 错误处理 */
  expectOk?: boolean;
  /** true：401 只抛错，不触发用户登录态过期回调（管理后台等独立鉴权体系用） */
  ignoreUnauth?: boolean;
  headers?: Record<string, string>;
  /**
   * v1.1：响应按二进制原文返回（.flyme 备份下载用）——跳过 JSON 解析与 ok 校验，
   * data 为 ArrayBuffer；配合 wantHeaders 取出服务端自定义响应头
   * （如 X-Nawu-Backup-Summary）。大文件不重试。
   */
  responseType?: 'json' | 'arraybuffer';
  /** arraybuffer 模式下要透出的响应头名（小写） */
  wantHeaders?: string[];
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  /** wantHeaders 命中时的响应头（小写名 → 值） */
  headers?: Record<string, string>;
}

/** 默认超时（ms）。 */
export const DEFAULT_TIMEOUT_MS = 15000;
/** 探活超时（ms）。 */
export const HEALTH_TIMEOUT_MS = 8000;
/** GET 重试间隔（ms）。 */
export const RETRY_DELAY_MS = 400;

type TokenProvider = () => string | null;
type UnauthorizedHandler = (err: ApiError) => void;

let tokenProvider: TokenProvider | null = null;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * 注册 token 提供者（由 `store/useAuthStore` 在模块加载时调用）。
 *
 * 用回调而不是直接 import store，避免 `net → store → api → net` 的循环依赖。
 */
export function setTokenProvider(fn: TokenProvider | null): void {
  tokenProvider = fn;
}

/** 注册 401 回调（401 时除了抛错，还会通知上层把登录态置为过期）。 */
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  unauthorizedHandler = fn;
}

/** 当前 token（供调试与日志）。 */
export function currentToken(): string | null {
  try {
    return tokenProvider ? tokenProvider() : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 安全 JSON 解析（失败返回 null）。 */
function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 把响应体统一成对象（CapacitorHttp 的 data 可能是字符串）。 */
function coerceBody<T>(data: unknown): T | null {
  if (data === null || data === undefined) return null;
  if (typeof data === 'string') {
    const parsed = safeJsonParse<unknown>(data);
    return (parsed as T) ?? null;
  }
  return data as T;
}

/* ----------------------------------------------------------------------------
 * 分支实现
 * --------------------------------------------------------------------------*/

/** 原生分支：CapacitorHttp。 */
async function nativeRequest(
  url: string,
  opts: RequestOptions,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; data: unknown; headers?: Record<string, string> }> {
  let CapacitorHttp: {
    request: (o: Record<string, unknown>) => Promise<{ status: number; data: unknown; headers?: unknown; url?: string }>;
  };
  try {
    const mod = await import('@capacitor/core');
    CapacitorHttp = mod.CapacitorHttp as unknown as typeof CapacitorHttp;
  } catch (e) {
    throw classifyUnknownError(e, Math.round(timeoutMs / 1000));
  }

  // v1.1：二进制响应（.flyme 下载）。注意：
  //  - responseType 只影响**响应**解析；dataType 只影响**请求体**序列化（Android 源码
  //    HttpRequestHandler：responseType 走 ResponseType.parse，dataType 走 setRequestBody）；
  //  - Android 侧 arraybuffer → data 是 base64 字符串（Content-Type 非 JSON 时），
  //    这里统一转成 ArrayBuffer，与 fetch 分支形态一致。
  const wantBinary = opts.responseType === 'arraybuffer';
  const reqOpts: Record<string, unknown> = {
    url,
    method: opts.method ?? 'GET',
    headers,
    data: opts.rawBody !== undefined ? opts.rawBody : opts.body,
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
    shouldEncodeUrlParams: false, // query 自己拼，避免二次编码
  };
  if (wantBinary) {
    reqOpts.responseType = 'arraybuffer';
  } else {
    reqOpts.dataType = 'json'; // 响应按 JSON 解析；非 JSON 时 data 回落为字符串
  }

  try {
    const res = await CapacitorHttp.request(reqOpts);
    let data: unknown = res.data;
    if (wantBinary && typeof data === 'string') {
      data = base64ToArrayBuffer(data);
    }
    return { status: Number(res.status ?? 0), data, headers: pickHeaders(res.headers, opts.wantHeaders) };
  } catch (e) {
    throw classifyNativeError(e, Math.round(timeoutMs / 1000));
  }
}

/** base64 → ArrayBuffer（CapacitorHttp Android arraybuffer 响应的落地形态）。 */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** 从 Headers 对象 / 普通对象里挑出想要的响应头（小写名 → 值）。 */
function pickHeaders(source: unknown, names?: string[]): Record<string, string> | undefined {
  if (!source || !names || names.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const n of names) {
    const getter = (source as { get?: (k: string) => string | null }).get;
    const v = typeof getter === 'function' ? getter.call(source, n) : (source as Record<string, unknown>)[n];
    if (typeof v === 'string') out[n] = v;
  }
  return out;
}

/** 浏览器分支：fetch（dev 走 Vite 代理的相对路径）。 */
async function fetchRequest(
  fullUrl: string,
  path: string,
  opts: RequestOptions,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; data: unknown; headers?: Record<string, string> }> {
  const url = isDevProxy() ? path : fullUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      /* 忽略：controller 已 abort */
    }
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body:
        opts.rawBody !== undefined
          ? opts.rawBody
          : (opts.method ?? 'GET') === 'GET'
            ? undefined
            : JSON.stringify(opts.body ?? null),
      signal: opts.signal ?? controller.signal,
      credentials: 'omit',
    });
    if (opts.responseType === 'arraybuffer') {
      return { status: res.status, data: await res.arrayBuffer(), headers: pickHeaders(res.headers, opts.wantHeaders) };
    }
    const text = await res.text();
    return { status: res.status, data: text };
  } catch (e) {
    throw classifyFetchError(e, Math.round(timeoutMs / 1000));
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------------------------
 * 主入口
 * --------------------------------------------------------------------------*/

/**
 * 发起一次请求。
 *
 * @throws {ApiError} 任何失败都会被归一化成 ApiError（含中文文案）
 */
export async function request<T = unknown>(
  server: Pick<ServerConfig, 'url'> | null | undefined,
  opts: RequestOptions,
): Promise<HttpResponse<T>> {
  const method: HttpMethod = opts.method ?? 'GET';
  const norm = normalizeServerUrl(server?.url ?? '');
  if (!norm.ok) {
    throw new ApiError('invalid_url', norm.reason ?? ERROR_TEXT.invalid_url, undefined, server?.url);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSec = Math.round(timeoutMs / 1000);
  const fullUrl = joinUrl(norm.url, opts.path, opts.query);

  const headers: Record<string, string> = {
    // ★F1：后端 flyme_param() 只读 php://input 做 json_decode，
    // 必须无条件声明 JSON，否则参数被静默忽略（表现为「请输入正确的邮箱地址」）。
    'Content-Type': opts.contentType ?? 'application/json',
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };

  const needAuth = opts.auth !== false && !isNoAuthPath(opts.path);
  if (needAuth) {
    const token = currentToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  /* v1.1：二进制响应直达路径（.flyme 备份下载）——不重试、不解析 ok 字段，
     错误时把响应体按文本解出服务端文案（flyme_fail 输出 JSON）。 */
  if (opts.responseType === 'arraybuffer') {
    try {
      const res = isNative()
        ? await nativeRequest(fullUrl, opts, headers, timeoutMs)
        : await fetchRequest(fullUrl, joinUrl('', opts.path, opts.query), opts, headers, timeoutMs);
      const status = Number(res.status ?? 0);
      if (status < 200 || status >= 300) {
        const data = res.data;
        let text: string;
        if (typeof data === 'string') text = data;
        else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(data));
        else text = String(data ?? '');
        throw classifyStatus(status, coerceBody(text) ?? text);
      }
      return { status, data: res.data as T, headers: res.headers };
    } catch (e) {
      const err = e instanceof ApiError ? e : classifyUnknownError(e, timeoutSec);
      logger.error('http', `${method} ${opts.path} 失败(raw)`, err.kind, err.message);
      throw err;
    }
  }

  const maxRetry = opts.retry ?? (method === 'GET' ? 1 : 0);
  let lastError: ApiError | null = null;

  for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
    const startedAt = Date.now();
    try {
      const res = isNative()
        ? await nativeRequest(fullUrl, opts, headers, timeoutMs)
        : await fetchRequest(fullUrl, joinUrl('', opts.path, opts.query), opts, headers, timeoutMs);

      const status = Number(res.status ?? 0);
      logger.debug('http', `${method} ${opts.path} → ${status} (${Date.now() - startedAt}ms)`);

      // 401：抛 auth 错，同时通知上层清登录态（保留本地数据与服务器配置）
      if (status === 401) {
        // ★优先透传后端文案（如「该邮箱尚未注册，请先注册账号」「密码不正确」），
        //  没有才回落到「登录已过期」——否则登录页的错误提示全是误导。
        const serverMsg = extractServerError(coerceBody(res.data));
        const err = new ApiError('auth', serverMsg ?? ERROR_TEXT.auth, status, res.data);
        if (opts.ignoreUnauth !== true) {
          try {
            unauthorizedHandler?.(err);
          } catch {
            /* 回调异常不影响主流程 */
          }
        }
        throw err;
      }

      if (status < 200 || status >= 300) throw classifyStatus(status, coerceBody(res.data));

      const body = coerceBody<T>(res.data);
      if (body === null || typeof body !== 'object') {
        throw classifyParseError(status, res.data);
      }
      if (opts.expectOk !== false && (body as Record<string, unknown>).ok === undefined) {
        throw classifyParseError(status, res.data);
      }
      return { status, data: body };
    } catch (e) {
      const err = e instanceof ApiError ? e : classifyUnknownError(e, timeoutSec);
      lastError = err;
      const retriable = err.kind === 'network' || err.kind === 'timeout';
      if (retriable && attempt < maxRetry) {
        logger.warn('http', `${method} ${opts.path} 失败(${err.kind})，${RETRY_DELAY_MS}ms 后重试`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      logger.error('http', `${method} ${opts.path} 失败`, err.kind, err.message);
      throw err;
    }
  }

  throw lastError ?? new ApiError('network', ERROR_TEXT.network);
}

/** GET 快捷方法。 */
export function get<T = unknown>(
  server: Pick<ServerConfig, 'url'> | null | undefined,
  path: string,
  query?: Record<string, string | number>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HttpResponse<T>> {
  return request<T>(server, { method: 'GET', path, query, timeoutMs });
}

/** POST 快捷方法（请求体一律 JSON）。 */
export function post<T = unknown>(
  server: Pick<ServerConfig, 'url'> | null | undefined,
  path: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HttpResponse<T>> {
  return request<T>(server, { method: 'POST', path, body, timeoutMs, retry: 0 });
}

/** DELETE 快捷方法。 */
export function del<T = unknown>(
  server: Pick<ServerConfig, 'url'> | null | undefined,
  path: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HttpResponse<T>> {
  return request<T>(server, { method: 'DELETE', path, body, timeoutMs, retry: 0 });
}

/**
 * 原始 body POST（v1.0.36：管理后台上传 APK，绕过 JSON 序列化）。
 * 大文件不重试；超时默认 10 分钟。
 */
export function postRaw<T = unknown>(
  server: Pick<ServerConfig, 'url'> | null | undefined,
  path: string,
  rawBody: ArrayBuffer | string,
  contentType: string,
  query?: Record<string, string | number>,
  timeoutMs = 600000,
): Promise<HttpResponse<T>> {
  return request<T>(server, { method: 'POST', path, rawBody, contentType, query, timeoutMs, retry: 0 });
}
