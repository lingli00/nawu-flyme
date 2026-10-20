import { isNative } from '../net/env';
import { get } from '../net/httpClient';
import type { ServerConfig } from '../types/entities';

/**
 * App 版本 / 更新相关接口（问题六 · 应用内一键更新）。
 *
 * 后端两条路由均免鉴权：
 * - `GET /api/app/version` → `{ ok, version, notes, fileSize, publishedAt }`
 * - `GET /api/app/download` → APK 文件流（由系统浏览器下载，不走本函数）
 *
 * 注意：路径未加进 `api/endpoints.ts` 的免鉴权白名单（该文件是并行改动热区，
 * 避免冲突），已登录时 httpClient 会带上 Authorization，后端会忽略它，无影响。
 */

/** `/api/app/version` 响应。 */
export interface AppVersionInfo {
  ok: boolean;
  /** 最新版本号；服务端未发布时为空串 */
  version: string;
  /** 更新说明 */
  notes: string;
  /** 安装包字节数（manifest 声明值，仅展示用） */
  fileSize: number;
  /** 发布时间 */
  publishedAt: string;
}

/** 拉取服务端发布的最新版本信息。 */
export async function checkAppVersion(server: Pick<ServerConfig, 'url'>): Promise<AppVersionInfo> {
  const res = await get<AppVersionInfo>(server, '/api/app/version');
  return res.data;
}

/**
 * 打开 APK 下载。
 *
 * - 原生环境：`@capacitor/browser`（Custom Tab / 系统浏览器）下载，
 *   用户点系统通知完成安装 —— WebView 内无法直接装 APK，必须借系统浏览器
 * - Web 环境：新标签页直接下载
 */
export async function openAppDownload(serverUrl: string): Promise<void> {
  const url = `${serverUrl.replace(/\/+$/, '')}/api/app/download`;
  if (isNative()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
  } else {
    window.open(url, '_blank');
  }
}
