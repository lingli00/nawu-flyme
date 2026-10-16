import type { ReactNode } from 'react';
import { create } from 'zustand';
import { newId } from '../lib/id';
import { haptic } from '../lib/haptics';

/**
 * 全局 UI 状态：Toast / 确认弹窗 / 底部弹层。
 *
 * 用法（页面里）：
 * ```ts
 * const toast = useUiStore((s) => s.toast);
 * toast('已保存 2 条', 'success', { actionLabel: '撤销', onAction: () => undo() });
 *
 * const ok = await useUiStore.getState().confirm({ title: '确认删除？' });
 * ```
 */

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
  id: string;
  message: string;
  kind: ToastKind;
  /** 右侧动作文案（通常是「撤销」） */
  actionLabel?: string;
  /** 点击动作时执行（不自动关闭的场景由调用方控制） */
  onAction?: () => void;
  createdAt: number;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确认按钮用 danger 色 */
  danger?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
  confirmText: string;
  cancelText: string;
  /** 内部用：Promise 的 resolve */
  resolver?: (ok: boolean) => void;
}

interface UiStoreState {
  toasts: ToastItem[];
  confirmRequest: ConfirmRequest | null;
  sheet: { key: string; node: ReactNode } | null;

  /** 弹出 Toast，3.5s 自动消失，返回 id。 */
  toast: (message: string, kind?: ToastKind, opts?: { actionLabel?: string; onAction?: () => void; durationMs?: number }) => string;
  /** 关闭指定 Toast。 */
  dismissToast: (id: string) => void;
  /** 清空全部 Toast。 */
  clearToasts: () => void;

  /** 打开确认弹窗，返回用户是否确认。 */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  /** 由 Dialog 组件调用，结束确认流程。 */
  resolveConfirm: (ok: boolean) => void;

  /** 打开底部弹层。 */
  openSheet: (node: ReactNode, key?: string) => void;
  /** 关闭底部弹层。 */
  closeSheet: () => void;
}

/** Toast 默认存活时长（ms）。 */
const TOAST_DURATION_MS = 3500;

/** 同时最多显示的 Toast 条数（超出挤掉最旧的）。 */
const MAX_TOASTS = 3;

export const useUiStore = create<UiStoreState>()((set, get) => ({
  toasts: [],
  confirmRequest: null,
  sheet: null,

  toast: (message, kind = 'info', opts = {}) => {
    const id = newId();
    const item: ToastItem = {
      id,
      message,
      kind,
      actionLabel: opts.actionLabel,
      onAction: opts.onAction,
      createdAt: Date.now(),
    };
    set((s) => {
      // ★防叠加：同文案的 toast 已存在时**原位替换**（重置位置与计时），不再叠一条。
      // 旧条目挂起的 setTimeout 之后 dismiss 的是旧 id，对新条目是 no-op，无需额外清理。
      const idx = s.toasts.findIndex((t) => t.message === message);
      if (idx !== -1) {
        const next = s.toasts.slice();
        next[idx] = item;
        return { toasts: next };
      }
      // ★最多 MAX_TOASTS 条：超出时挤掉最旧的（其旧定时器同样变 no-op）。
      const capped = s.toasts.slice(-(MAX_TOASTS - 1));
      return { toasts: [...capped, item] };
    });
    const duration = opts.durationMs ?? TOAST_DURATION_MS;
    setTimeout(() => {
      get().dismissToast(id);
    }, duration);
    return id;
  },

  // 自动消失 / 手动关闭都不触发 onAction：只有点「撤销」按钮才执行动作
  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  clearToasts: () => set({ toasts: [] }),

  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      set({
        confirmRequest: {
          ...opts,
          confirmText: opts.confirmText ?? '确定',
          cancelText: opts.cancelText ?? '取消',
          resolver: resolve,
        },
      });
    }),

  resolveConfirm: (ok) => {
    const req = get().confirmRequest;
    set({ confirmRequest: null });
    req?.resolver?.(ok);
  },

  openSheet: (node, key) => set({ sheet: { key: key ?? newId(), node } }),
  closeSheet: () => set({ sheet: null }),
}));

/**
 * 便捷：成功提示（v1.0.17 附带「成功」触感，竞品同款：保存即轻震一下）。
 * haptic 内部已节流且静默失败，不需要 await。
 */
export const toastSuccess = (message: string): string => {
  void haptic('success');
  return useUiStore.getState().toast(message, 'success');
};

/** 便捷：错误提示（附「失败」三段震）。 */
export const toastError = (message: string): string => {
  void haptic('error');
  return useUiStore.getState().toast(message, 'error');
};

/** 便捷：普通提示。 */
export const toastInfo = (message: string): string => useUiStore.getState().toast(message, 'info');
