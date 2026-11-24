import { ApiError } from '../lib/error';
import logger from '../lib/log';
import type { AiConfig, ChatMessage } from '../types/ai';
import { classifyFetchError, classifyNativeError, classifyUnknownError } from './errors';
import { isNative } from './env';

/**
 * AI 客户端：直连第三方 OpenAI 兼容接口（**不走 PHP 后端**，架构 §2 第 4 条）。
 *
 * 未配置 endpoint/key 时由 `ai/parseService` 直接回落本地规则，本文件不抛业务错误。
 */

/** AI 请求超时（ms）：失败立即回落本地解析，不做重试。 */
export const AI_TIMEOUT_MS = 20000;

/** 把用户填的 endpoint 归一化成 `/chat/completions` 全路径。 */
export function normalizeAiEndpoint(endpoint: string): string {
  const raw = (endpoint ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+(?:alpha|beta)?$/i.test(raw)) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
}

/**
 * 从模型输出里抽取 JSON 数组。
 *
 * 兼容三种脏输出：```` ```json [...] ``` ````、前后带解释文字、直接就是数组。
 * @throws {ApiError} kind='parse'
 */
export function extractJsonArray(raw: string): unknown[] {
  const text = (raw ?? '').trim();
  if (!text) throw new ApiError('parse', 'AI 返回内容为空', undefined, raw);

  const fence = /```(?:json|jsonc)?\s*([\s\S]*?)```/i.exec(text);
  const body = fence ? fence[1]!.trim() : text;

  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new ApiError('parse', 'AI 返回内容不是 JSON 数组', undefined, raw);
  }
  const slice = body.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not array');
    return parsed;
  } catch {
    throw new ApiError('parse', 'AI 返回内容不是合法 JSON', undefined, slice);
  }
}

interface AiHttpResult {
  status: number;
  text: string;
}

/** 原生分支：CapacitorHttp。 */
async function aiNativeRequest(
  url: string,
  cfg: AiConfig,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<AiHttpResult> {
  let CapacitorHttp: {
    request: (o: Record<string, unknown>) => Promise<{ status: number; data: unknown }>;
  };
  try {
    const mod = await import('@capacitor/core');
    CapacitorHttp = mod.CapacitorHttp as unknown as typeof CapacitorHttp;
  } catch (e) {
    throw classifyUnknownError(e, Math.round(timeoutMs / 1000));
  }

  try {
    const res = await CapacitorHttp.request({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${cfg.key}`,
      },
      data: payload,
      dataType: 'json',
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
      shouldEncodeUrlParams: false,
    });
    const data = res.data;
    return { status: Number(res.status ?? 0), text: typeof data === 'string' ? data : JSON.stringify(data ?? '') };
  } catch (e) {
    throw classifyNativeError(e, Math.round(timeoutMs / 1000));
  }
}

/** 浏览器分支：fetch。 */
async function aiFetchRequest(
  url: string,
  cfg: AiConfig,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<AiHttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      credentials: 'omit',
    });
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) {
    throw classifyFetchError(e, Math.round(timeoutMs / 1000));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用 `/chat/completions`，返回模型输出的原始文本。
 *
 * @throws {ApiError} 网络/超时/非 2xx/解析失败
 */
export async function chatComplete(
  cfg: AiConfig,
  messages: ChatMessage[],
  timeoutMs: number = AI_TIMEOUT_MS,
): Promise<string> {
  const url = normalizeAiEndpoint(cfg.endpoint);
  if (!url) throw new ApiError('invalid_url', 'AI 接口地址未配置', undefined, cfg.endpoint);
  if (!cfg.key) throw new ApiError('invalid_url', 'AI 接口密钥未配置', undefined, cfg.endpoint);

  const payload = {
    model: cfg.model || 'gpt-4o-mini',
    messages,
    temperature: 0.2,
    stream: false,
  };

  logger.debug('ai', `POST ${url} model=${payload.model}`);
  const res = isNative()
    ? await aiNativeRequest(url, cfg, payload, timeoutMs)
    : await aiFetchRequest(url, cfg, payload, timeoutMs);

  if (res.status < 200 || res.status >= 300) {
    throw new ApiError('http', `AI 接口返回异常（HTTP ${res.status}）`, res.status, res.text.slice(0, 500));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text) as unknown;
  } catch {
    throw new ApiError('parse', 'AI 接口返回内容不是合法 JSON', res.status, res.text.slice(0, 500));
  }

  const choices = (parsed as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // 部分兼容实现返回 [{type:'text',text:'...'}]
    const text = (content as Array<{ text?: string }>).map((c) => c?.text ?? '').join('');
    if (text) return text;
  }
  throw new ApiError('parse', 'AI 返回结构缺少 choices[0].message.content', res.status, parsed);
}

/**
 * 调用并直接取 JSON 数组（chatComplete + extractJsonArray 的组合）。
 */
export async function chatJsonArray(
  cfg: AiConfig,
  messages: ChatMessage[],
  timeoutMs: number = AI_TIMEOUT_MS,
): Promise<unknown[]> {
  const content = await chatComplete(cfg, messages, timeoutMs);
  return extractJsonArray(content);
}
