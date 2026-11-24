import type { JSX } from 'react';

/**
 * ★v1.8.0 页面/分区加载骨架。
 *
 * 由 `MainShell.tsx` 里的实现转出（两者互相依赖会形成循环 import：
 * MainShell → 页面（经 App 注入）→ 页面又 import PageShell…，
 * 所以骨架必须放在叶子模块里，MainShell 与 router 都从这取）。
 *
 * 结构：标题条 + 三张卡片行，宽度/圆角与真实页面同构；
 * `full` 用于二级页整屏兜底（垂直居中，不贴顶）。
 */
export default function PaneFallback({ full = false }: { full?: boolean }): JSX.Element {
  return (
    <div
      className="nw-pane-fallback"
      data-full={full ? 'true' : undefined}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="nw-pane-fallback-title" />
      <div className="nw-pane-fallback-card" />
      <div className="nw-pane-fallback-card" />
      <div className="nw-pane-fallback-card nw-pane-fallback-card--short" />
      <span className="sr-only">正在载入页面…</span>
    </div>
  );
}