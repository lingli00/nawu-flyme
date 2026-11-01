import { ApiError, ERROR_TEXT, httpText, parseText, timeoutText } from '../lib/error';

/**
 * 异常 → ApiError 的分类器（§6.3）。
 *
 * CapacitorHttp 在 Android 上抛出的 Error 形态不统一（message 里带 Java 异常类名），
 * 只能做**关键词匹配**；fetch 侧按 DOMException / TypeError 判定。
 */

const TIMEOUT_RE = /timeout|timed?\s*out|sockettimeout|超时|aborted/i;
const NETWORK_RE =
  /unknownhost|connectexception|econnrefused|econnreset|failed to connect|network|unreachable|no address associated|cleartext|socket|host/i;
const TLS_RE = /ssl|sslhandshake|certificate|trust anchor|not trusted|cert path|javax\.net/i;

/** 从后端响应体里取中文原因（后端 `flyme_fail` 统一返回 `{ok:false,error}`）。 */
export function extractServerError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const err = (body as Record<string, unknown>).error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  const msg = (body as Record<string, unknown>).message;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  return undefined;
}

/** 判定是否「后端要求邮箱验证码」（F5，注册自适应流程用）。 */
export function looksLikeVerifyRequired(body: unknown, message?: string): boolean {
  const text = `${extractServerError(body) ?? ''} ${message ?? ''}`;
  return /验证|verify|verification|code/i.test(text);
}

/** 原生层（CapacitorHttp）异常分类。 */
export function classifyNativeError(e: unknown, timeoutSec = 15): ApiError {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e ?? {});
  const msg = String(raw ?? '');
  if (TLS_RE.test(msg)) return new ApiError('tls', ERROR_TEXT.tls, undefined, e);
  if (TIMEOUT_RE.test(msg)) return new ApiError('timeout', timeoutText(timeoutSec), undefined, e);
  if (NETWORK_RE.test(msg)) return new ApiError('network', ERROR_TEXT.network, undefined, e);
  return new ApiError('network', ERROR_TEXT.network, undefined, e);
}

/** 浏览器 fetch 异常分类。 */
export function classifyFetchError(e: unknown, timeoutSec = 15): ApiError {
  if (e instanceof DOMException || (e instanceof Error && e.name === 'AbortError')) {
    return new ApiError('timeout', timeoutText(timeoutSec), undefined, e);
  }
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (TIMEOUT_RE.test(msg)) return new ApiError('timeout', timeoutText(timeoutSec), undefined, e);
  if (TLS_RE.test(msg)) return new ApiError('tls', ERROR_TEXT.tls, undefined, e);
  // fetch 失败统一是 TypeError: Failed to fetch
  return new ApiError('network', ERROR_TEXT.network, undefined, e);
}

/** 任意未知异常兜底（优先识别超时/证书）。 */
export function classifyUnknownError(e: unknown, timeoutSec = 15): ApiError {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (TLS_RE.test(msg)) return new ApiError('tls', ERROR_TEXT.tls, undefined, e);
  if (TIMEOUT_RE.test(msg)) return new ApiError('timeout', timeoutText(timeoutSec), undefined, e);
  return new ApiError('network', ERROR_TEXT.network, undefined, e);
}

/**
 * 有状态码时的分类：
 * - 401 → auth
 * - 其它非 2xx → http（优先用后端 error 文案）
 */
export function classifyStatus(status: number, body: unknown): ApiError {
  const serverError = extractServerError(body);
  if (status === 401) return new ApiError('auth', ERROR_TEXT.auth, status, body);
  const requiresCode = status === 400 && looksLikeVerifyRequired(body);
  return new ApiError('http', httpText(status, serverError), status, body, requiresCode || undefined);
}

/** 2xx 但内容不是预期 JSON。 */
export function classifyParseError(status: number | undefined, body: unknown): ApiError {
  return new ApiError('parse', parseText(status), status, body);
}
