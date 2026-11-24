/** 错误类型与中文文案：所有网络异常在此归一化，UI 只展示 `message`。 */
export type ErrorKind =
  /** 地址不合法（归一化失败） */
  | 'invalid_url'
  /** DNS 失败 / 连接被拒 / 无网络 */
  | 'network'
  /** 超时 */
  | 'timeout'
  /** 证书不受信任（自签） */
  | 'tls'
  /** 有状态码但非 2xx */
  | 'http'
  /** 401 */
  | 'auth'
  /** 2xx 但不是预期 JSON */
  | 'parse';

/** 六类错误的中文文案模板（§6.3，逐字对齐）。 */
export const ERROR_TEXT: Record<ErrorKind, string> = {
  invalid_url: '地址格式不正确，示例：http://192.168.1.10:3030',
  network: '无法连接到服务器，请检查地址、端口与网络（是否在同一个局域网/VPN 内）',
  timeout: '连接超时，请确认手机与服务器在同一局域网或已连 VPN',
  tls: 'HTTPS 证书不受信任（多为自签证书），请改用 http 或在系统内安装该证书',
  http: '请求失败，请稍后重试',
  auth: '登录已过期，请重新登录',
  parse: '服务器已连通，但返回内容不是纳物服务端',
};

/** 按状态码取文案（无后端 error 字段时兜底）。 */
const STATUS_TEXT: Record<number, string> = {
  400: '请求参数有误（400）',
  401: '登录已过期，请重新登录',
  403: '服务器拒绝了请求（403）：可能是账号未验证或已被停用',
  404: '接口不存在（404），请确认这是纳物服务端',
  405: '请求方法不被支持（405）',
  409: '数据冲突（409），请刷新后重试',
  422: '请求无法处理（422），请检查输入内容',
  429: '操作过于频繁（429），请稍后再试',
};

/**
 * 统一错误类型。
 *
 * 约定（架构 §10.4）：网络层**只抛出 ApiError**，UI 只展示 `message`，
 * 禁止把原始堆栈或裸状态码暴露给用户。
 */
export class ApiError extends Error {
  /** 错误分类（驱动 UI 的图标与重试策略） */
  public readonly kind: ErrorKind;
  /** HTTP 状态码（可能为空，例如地址不合法） */
  public readonly status?: number;
  /** 原始响应体，便于排查 */
  public readonly raw?: unknown;
  /**
   * ★F5：注册流程专用。后端 `requireVerified=true` 时会要求验证码，
   * 此时置为 true，注册页据此追加「验证码」步骤。
   */
  public readonly requiresCode?: boolean;

  constructor(
    kind: ErrorKind,
    message: string,
    status?: number,
    raw?: unknown,
    requiresCode?: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.raw = raw;
    this.requiresCode = requiresCode;
  }
}

/** 生成带超时秒数的 timeout 文案（不同超时值文案可区分）。 */
export function timeoutText(seconds: number): string {
  return `连接超时（${seconds}s），请确认手机与服务器在同一局域网或已连 VPN`;
}

/** 生成带状态码的 parse 文案。 */
export function parseText(status?: number): string {
  return status
    ? `服务器已连通，但返回内容不是纳物服务端（HTTP ${status}）`
    : ERROR_TEXT.parse;
}

/** 生成 http 文案：优先用后端 `error` 字段，没有再按状态码兜底。 */
export function httpText(status: number, serverError?: string): string {
  if (serverError && serverError.trim()) return serverError.trim();
  if (STATUS_TEXT[status]) return STATUS_TEXT[status];
  if (status >= 500) return `服务器内部错误（${status}），请稍后重试`;
  return `请求失败（${status}）：未知错误`;
}

/** 类型守卫。 */
export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** 把任意异常兜底成 ApiError（禁止原始 Error 冒泡到 UI）。 */
export function toApiError(e: unknown, fallbackKind: ErrorKind = 'network'): ApiError {
  if (isApiError(e)) return e;
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return new ApiError(fallbackKind, msg || ERROR_TEXT[fallbackKind], undefined, e);
}

/** 取可直接展示给用户的中文文案。 */
export function humanMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return '未知错误，请稍后重试';
}
