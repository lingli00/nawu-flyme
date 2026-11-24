import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

/**
 * v1.0.36 · 原生「应用内更新」插件封装（android/.../ApkUpdatePlugin.java）。
 *
 * 仅 App 端可用：网页端 registerPlugin 拿到的是会抛错的代理，
 * 调用方必须先用 isNative() 分流（见 api/appUpdate.ts）。
 */

export interface ApkDownloadResult {
  /** 缓存目录中的绝对路径 */
  path: string;
  size: number;
  sha256: string;
}

export interface ApkUpdatePluginApi {
  getInfo(): Promise<{ sourceDir: string; versionName: string; versionCode: number }>;
  download(options: {
    url: string;
    sha256?: string;
    fileName?: string;
  }): Promise<ApkDownloadResult>;
  applyPatch(options: { patchPath: string; fileName?: string }): Promise<ApkDownloadResult>;
  sha256File(options: { path: string }): Promise<{ sha256: string; size: number }>;
  install(options: { path: string }): Promise<{ started: boolean; reason?: string }>;
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  addListener(
    event: 'downloadProgress',
    handler: (data: { received: number; total: number }) => void,
  ): Promise<PluginListenerHandle>;
}

const ApkUpdate = registerPlugin<ApkUpdatePluginApi>('ApkUpdate');

export default ApkUpdate;
