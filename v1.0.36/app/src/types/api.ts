import type { CollectionName, Settings, Session, UserInfo } from './entities';

/* ============================================================================
 * 后端接口 DTO（唯一真实来源：服务端 app/Api.php）
 * ==========================================================================*/

/** `GET /api/health`：★DB 挂了也返回 `ok:true`，判定连通必须再看 `db`（F3）。 */
export interface HealthResp {
  ok: boolean;
  db: boolean;
  dbError?: string;
  time?: string;
  runtime?: string;
}

/** `GET /api/settings`：需要登录（F2），返回 `{ok, settings}`。 */
export interface SettingsResp {
  ok: boolean;
  settings: Record<string, unknown>;
}

/** `POST /api/auth/login` 与 `register`（★注册成功也直接返回 token，= 自动登录）。 */
export interface LoginResp {
  ok: boolean;
  token?: string;
  user?: UserInfo;
  error?: string;
  /** 服务端要求邮箱验证时为 true */
  requireVerified?: boolean;
}

/** `GET /api/auth/me`。 */
export interface MeResp {
  ok: boolean;
  user: UserInfo;
  error?: string;
}

/** `POST /api/auth/send-code`。 */
export interface SendCodeResp {
  ok: boolean;
  error?: string;
  /** 调试环境下后端可能回传验证码 */
  code?: string;
}

/** 通用「只有 ok」的响应。 */
export interface OkResp {
  ok: boolean;
  error?: string;
}

/** `POST /api/user/rules`（自定义识别规则 JSON）。 */
export interface RulesResp {
  ok: boolean;
  rules: unknown;
  error?: string;
}

/** `GET /api/user/profile`。 */
export interface ProfileResp {
  ok: boolean;
  profile: Record<string, unknown>;
  error?: string;
}

/* ----------------------------------------------------------------------------
 * 备份
 * --------------------------------------------------------------------------*/

/**
 * 备份快照（★`app` 固定写 `flyme-web`，不能写 flyme-android，
 * 否则与 Web 版备份互斥，跨端恢复直接失败）。
 */
export interface SnapshotPayload {
  collections: Partial<Record<CollectionName, unknown[]>>;
  settings: Settings | null;
  /** 只算 goods + subscriptions + valueRecords，与 Web 版同口径 */
  count: number;
  app: 'flyme-web';
  version: number;
  exportedAt: string;
  /** v1.0.15：本地图标缓存快照（键=归一化 src，值=dataURL）。
   *  老版本备份/网页版没有此字段 —— 可选，恢复端按缺省跳过。 */
  icons?: Record<string, string> | null;
}

/** `POST /api/user/backups` 请求体。 */
export interface CreateBackupBody {
  payload: SnapshotPayload;
  label: string;
  item_count: number;
  /** `Android/型号`，截 60 字符 */
  device: string;
}

/** `POST /api/user/backups` 响应。 */
export interface CreateBackupResp {
  ok: boolean;
  id?: number;
  error?: string;
}

/** 备份列表项（★后端字段是 `rows`，不是 `backups`）。 */
export interface BackupRow {
  id: number;
  label: string;
  item_count: number;
  bytes: number;
  device: string;
  created_at: string;
}

/** `GET /api/user/backups`（列表）。 */
export interface BackupListResp {
  ok: boolean;
  /** ★F4：字段名为 rows */
  rows: BackupRow[];
  error?: string;
}

/**
 * `GET /api/user/backups/:id`（详情）。
 * ★F4：`payload` 可能是对象也可能是 JSON 字符串，反序列化必须双兼容。
 */
export interface BackupDetail {
  payload: SnapshotPayload | string;
  label: string;
}

export interface BackupDetailResp {
  ok: boolean;
  payload?: SnapshotPayload | string;
  label?: string;
  error?: string;
}

/** 同步（App 端 P1 备用，业务数据仍以整体快照为准）。 */
export interface SyncListResp {
  ok: boolean;
  rows?: unknown[];
  error?: string;
}

/** 登录结果（store 层用）。 */
export interface LoginResult {
  session: Session;
}
