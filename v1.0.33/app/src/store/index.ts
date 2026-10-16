/**
 * 状态层统一出口。
 *
 * 依赖方向：`pages → store → domain/api → net → storage/lib`。
 * 页面只应 import 本文件（或具体的 `useXxxStore`），**禁止**直接 import `net/` 与 `storage/`。
 */

export { useAppStore, isHydrated, refreshTheme } from './useAppStore';
export { useServerStore, currentServer, setServerChangedHandler } from './useServerStore';
export { useAuthStore, isLoggedIn, activeServer } from './useAuthStore';
export { useDataStore, collectionOf } from './useDataStore';
export { useSettingsStore, resolveTheme } from './useSettingsStore';
export {
  useUiStore,
  toastSuccess,
  toastError,
  toastInfo,
  type ToastItem,
  type ToastKind,
  type ConfirmOptions,
} from './useUiStore';

/** 备份相关（store 之上的一层编排，页面直接用这两个方法即可）。 */
export { uploadBackup, restoreBackup, fetchBackupList, deleteRemoteBackup } from './backupActions';
