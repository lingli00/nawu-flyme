import { useUiStore } from '../../store/useUiStore';
import type { ConfirmRequest, ToastItem } from '../../store/useUiStore';
import { haptic } from '../../lib/haptics';

/**
 * 全局 UI 宿主：Toast / Dialog / Sheet 的统一挂载点（挂在 App 根节点下）。
 *
 * T04 会把这三块替换成完整的 `Toast.tsx` / `Dialog.tsx` / `Sheet.tsx` 组件，
 * 但挂载点与 store 契约不变，因此这里保留最小可用实现。
 */
export function UiHost(): JSX.Element {
  const toasts = useUiStore((s) => s.toasts);
  const confirm = useUiStore((s) => s.confirmRequest);
  const dismissToast = useUiStore((s) => s.dismissToast);
  const resolveConfirm = useUiStore((s) => s.resolveConfirm);

  return (
    <>
      {/* Toast 区（顶部，3.5s 自动消失，可点「撤销」） */}
      <div className="fixed left-0 right-0 top-0 z-[80] flex flex-col items-center gap-2 pt-safe">
        {toasts.map((t) => (
          <ToastView
            key={t.id}
            toast={t}
            onDismiss={dismissToast}
            onAction={() => {
              t.onAction?.();
              dismissToast(t.id);
            }}
          />
        ))}
      </div>

      {/* 居中确认弹窗（最大宽 320dp） */}
      {confirm ? <DialogView request={confirm} onResolve={resolveConfirm} /> : null}
    </>
  );
}

function ToastView({
  toast,
  onDismiss,
  onAction,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
  /** 点击右侧动作（通常是「撤销」）时执行 */
  onAction: () => void;
}): JSX.Element {
  const tone =
    toast.kind === 'error'
      ? 'bg-danger-soft text-danger'
      : toast.kind === 'success'
        ? 'bg-accent-soft text-accent'
        : 'bg-surface text-ink';
  return (
    <div
      className={`toast-enter mx-4 mt-2 w-[min(92vw,420px)] rounded-2xl border border-line/60 px-4 py-3 shadow-lg ${tone}`}
      onClick={() => onDismiss(toast.id)}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="t-body flex-1">{toast.message}</span>
        {toast.actionLabel ? (
          <button
            type="button"
            className="min-h-[44px] px-2 t-body font-medium text-accent"
            onClick={(e) => {
              e.stopPropagation();
              void haptic('select');
              onAction();
            }}
          >
            {toast.actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DialogView({
  request,
  onResolve,
}: {
  request: ConfirmRequest;
  onResolve: (ok: boolean) => void;
}): JSX.Element {
  return (
    <div className="fade-enter fixed inset-0 z-[90] flex items-center justify-center bg-black/40 px-6">
      <div className="pop-enter w-full max-w-[320px] rounded-2xl bg-surface p-5 shadow-2xl">
        <div className="t-h3 text-ink">{request.title}</div>
        {request.message ? (
          <div className="mt-2 t-body text-ink-2">{request.message}</div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="min-h-[44px] px-4 rounded-btn t-body text-ink-2 active:bg-surface-2"
            onClick={() => {
              void haptic('select');
              onResolve(false);
            }}
          >
            {request.cancelText}
          </button>
          <button
            type="button"
            className="min-h-[44px] px-4 rounded-btn t-body font-medium text-accent active:bg-accent-soft"
            onClick={() => {
              void haptic('medium');
              onResolve(true);
            }}
          >
            {request.confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
