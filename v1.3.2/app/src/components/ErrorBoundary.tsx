import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { recentErrors, recordBoundaryError, clearErrors } from '../lib/errlog';

interface Props {
  children: ReactNode;
}

interface State {
  err: Error | null;
}

/**
 * 根级错误边界（v1.0.30 · 白屏根治）。
 *
 * React 18 渲染期抛出未捕获异常时会把**整棵树卸载**——用户看到的就是纯白屏，
 * 只能手动刷新，刷新后还可能误以为数据丢了。这里兜住：显示可读的错误页
 * （含最近错误现场，用户截图即可反馈），并提供一键重载。
 */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  override componentDidCatch(err: Error, info: ErrorInfo): void {
    recordBoundaryError(err);
    if (info.componentStack) {
      // 补上 componentStack（定位哪棵子树崩的），直接落盘一次
      try {
        const logs = recentErrors();
        if (logs[0]) {
          logs[0].stack = `${logs[0].stack ?? ''}\n--componentStack--${info.componentStack}`.slice(0, 800);
          localStorage.setItem('flyme.errlog', JSON.stringify(logs.slice(0, 20).reverse()));
        }
      } catch {
        /* 配额不足就丢 */
      }
    }
  }

  private reload = (): void => {
    location.reload();
  };

  override render(): ReactNode {
    const { err } = this.state;
    if (!err) return this.props.children;
    const logs = recentErrors().slice(0, 5);
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-paper px-6 text-center text-ink">
        <AlertTriangle size={40} className="text-amber-600" />
        <div>
          <p className="text-base font-medium">页面出了点问题</p>
          <p className="mt-1 text-xs text-ink-3">你的数据安全地存在本地，重载即可继续使用</p>
        </div>
        <p className="max-w-md break-all rounded-card bg-surface-2 px-3 py-2 text-left text-[11px] text-ink-2">
          {err.message || String(err)}
        </p>
        <button
          type="button"
          onClick={this.reload}
          className="flex items-center gap-1.5 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-white active:scale-95"
        >
          <RotateCcw size={16} />
          重新加载
        </button>
        {logs.length > 0 ? (
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-[11px] text-ink-3">错误详情（反馈时请截图）</summary>
            <div className="mt-2 space-y-1.5">
              {logs.map((r, i) => (
                <p key={i} className="break-all rounded bg-surface-2 px-2 py-1 text-[11px] leading-relaxed text-ink-3">
                  [{new Date(r.t).toLocaleTimeString()}] {r.kind}: {r.msg}
                </p>
              ))}
              <button
                type="button"
                onClick={() => {
                  clearErrors();
                  this.reload();
                }}
                className="mt-1 text-[11px] text-ink-3 underline"
              >
                清除错误记录并重载
              </button>
            </div>
          </details>
        ) : null}
      </div>
    );
  }
}
