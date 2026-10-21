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
    <div className="fade-enter fixed inset-0 z-[90] flex items-center justify-center bg-black/40 px-4 py-4">
      {/* ★v1.3.5：弹窗改成「头/身/脚」三段的纵向 flex ——
          正文与明细各自滚动、最多占视口 86%，按钮是独立的一段，永远贴在弹窗底部。
          旧版是单块内容 + items-center：在线更新要列几十个待删文件时，弹窗比屏幕还高，
          上下两端（标题、确认按钮）一起被挤出可视区，用户根本点不到「开始更新」。 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        className="pop-enter flex max-h-[min(86vh,44rem)] w-full max-w-[360px] flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl"
      >
        {/* 头部 + 正文 + 明细：整段可滚动，内容再长也只在自己的框里滚 */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-3 pt-5">
          <div className="t-h3 break-words text-ink">{request.title}</div>
          {request.message ? (
            <div className="mt-2 whitespace-pre-wrap break-words t-body text-ink-2">{request.message}</div>
          ) : null}
          {request.detail ? (
            <div className="mt-2.5">
              {request.detailLabel ? (
                <p className="mb-1 text-[11px] font-medium text-ink-3">{request.detailLabel}</p>
              ) : null}
              <pre className="max-h-[38vh] overflow-auto overscroll-contain whitespace-pre-wrap break-all rounded-btn border border-line bg-paper p-2 text-[11px] leading-relaxed text-ink-2">
                {request.detail}
              </pre>
            </div>
          ) : null}
        </div>
        {/* 底部操作区：独立一段，不随内容滚动 */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-4 py-3">
          <button
            type="button"
            className="min-h-[44px] rounded-btn px-4 t-body text-ink-2 active:bg-surface-2"
            onClick={() => {
              void haptic('select');
              onResolve(false);
            }}
          >
            {request.cancelText}
          </button>
          <button
            type="button"
            className={`min-h-[44px] rounded-btn px-4 t-body font-medium active:opacity-80 ${
              request.danger ? 'bg-danger text-white' : 'text-accent active:bg-accent-soft'
            }`}
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
