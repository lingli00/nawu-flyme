import { ApiError } from '../lib/error';
import { get, post, request } from '../net/httpClient';
import type { ServerConfig } from '../types/entities';
import { EP } from './endpoints';

/**
 * ★v1.6.6 · AI 接入（Muse / 任意 AI 智能体）
 *
 * 页面做四件事：
 *   ① 展示 API 基址 + OpenAPI 规范地址（让用户填进自己 AI 后台）；
 *   ② 生成 / 撤销个人 API Key（nawu_sk_…，长期有效，可随时吊销）；
 *   ③ 把 AI 在云端记的账按「事件」逐条确认后合并进本机（支持全部 12 个集合）；
 *   ④ 拉取字段字典，向用户展示 API 究竟能调用什么，并可一键复制成给 AI 的能力说明。
 */

export interface AiKeyRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** 待入账事件里的一行明细（服务端 GF_AiSchema::summarize 产出）。 */
export interface AiInboxItem {
  collection: string;
  collectionLabel: string;
  id: string;
  title: string;
  amount: number | string | null;
  date: string;
  note: string;
  fields: string[];
}

/** 事件 payload：12 个集合的记录 + 局部更新 / 删除 / 整组替换。 */
export type AiEventRecords = Record<string, unknown> & {
  patches?: Record<string, Array<{ id: string; patch: Record<string, unknown> }>>;
  deletes?: Record<string, string[]>;
  replace?: Record<string, Array<Record<string, unknown>>>;
};

export interface AiInboxEvent {
  id: number;
  kind: string;
  source: string;
  createdAt: string;
  records: AiEventRecords;
  /** v1.6.6：逐条明细，页面默认展开 */
  summary: AiInboxItem[];
  itemCount: number;
}

export interface AiSchemaInfo {
  version: string;
  collectionNames: string[];
  collections: Record<string, {
    label: string;
    description: string;
    fieldCount: number;
    additionalFields: boolean;
    fields: Record<string, { type: string; label: string; note?: string; example?: unknown }>;
  }>;
  counts: Record<string, number>;
  judgementOptions: Array<{ value: string; label: string; aliases?: string[]; builtin?: boolean }>;
  customFields: Array<{ collection: string; name: string; type?: string; label?: string }>;
  actions: Array<{ name: string; description?: string }>;
  categories: Array<{ id: string; name: string; kind: string }>;
  rules: Record<string, unknown>;
}

/** 生成一把新 Key（明文只返回一次）。 */
export async function createAiKey(server: ServerConfig | null, name = 'Muse'): Promise<{ id: string; key: string }> {
  const res = await post<{ ok: boolean; id?: string; key?: string; error?: string }>(server, EP.aiKeys, { name });
  if (!res.data || res.data.ok !== true || !res.data.key) {
    throw new ApiError('http', res.data?.error ?? '生成密钥失败', res.status, res.data);
  }
  return { id: res.data.id ?? '', key: res.data.key };
}

export async function listAiKeys(server: ServerConfig | null): Promise<AiKeyRow[]> {
  const res = await get<{ ok: boolean; keys?: AiKeyRow[] }>(server, EP.aiKeys);
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', '读取密钥列表失败', res.status, res.data);
  }
  return res.data.keys ?? [];
}

export async function revokeAiKey(server: ServerConfig | null, id: string): Promise<void> {
  const res = await request<{ ok: boolean; revoked?: boolean; error?: string }>(server, {
    method: 'DELETE',
    path: EP.aiKeys,
    body: { id },
  });
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', res.data?.error ?? '撤销失败', res.status, res.data);
  }
}

export async function fetchAiInbox(server: ServerConfig | null): Promise<{ events: AiInboxEvent[]; count: number }> {
  const res = await get<{ ok: boolean; events?: AiInboxEvent[]; count?: number }>(server, EP.aiInbox);
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', '读取云端待入账失败', res.status, res.data);
  }
  return { events: res.data.events ?? [], count: res.data.count ?? 0 };
}

/** 确认若干事件已被客户端合并（只标记传进去的 id，其余继续留在待入账）。 */
export async function applyAiInbox(server: ServerConfig | null, ids: number[]): Promise<void> {
  if (!ids.length) return;
  await post(server, EP.aiInboxApply, { ids });
}

/** ★v1.6.6：丢弃若干待入账事件（服务端会同步清掉云快照里的对应记录）。 */
export async function discardAiInbox(server: ServerConfig | null, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const res = await request<{ ok: boolean; deleted?: number; error?: string }>(server, {
    method: 'DELETE',
    path: EP.aiInbox,
    body: { ids },
  });
  if (!res.data || res.data.ok !== true) {
    throw new ApiError('http', res.data?.error ?? '丢弃失败', res.status, res.data);
  }
  return res.data.deleted ?? ids.length;
}

/** ★v1.6.6：读取字段字典（含自定义归需选项 / 分类 / 自定义功能）。 */
export async function fetchAiSchema(server: ServerConfig | null): Promise<AiSchemaInfo> {
  const res = await get<{ ok: boolean; error?: string } & Partial<AiSchemaInfo>>(server, EP.aiSchema);
  if (!res.data || res.data.ok !== true || !res.data.collections) {
    throw new ApiError('http', res.data?.error ?? '读取接口能力失败', res.status, res.data);
  }
  return res.data as AiSchemaInfo;
}
