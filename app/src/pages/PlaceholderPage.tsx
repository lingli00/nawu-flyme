import type { ReactNode } from 'react';

/**
 * 页面占位组件（T01 阶段）。
 *
 * T04/T05 交付真实页面后，只需把 `src/router.tsx` 里对应路由的
 * `element={<PlaceholderPage .../>}` 换成真实页面组件即可，本文件可整体删除。
 */
export interface PlaceholderPageProps {
  /** 页面标题（同时用于展示与未来 TopBar 标题） */
  title: string;
  /** 对应 PRD 页面编号，如 P07 */
  code?: string;
  /** 该页面后续由哪个文件承接，便于交接 */
  future?: string;
  children?: ReactNode;
}

export default function PlaceholderPage({
  title,
  code,
  future,
  children,
}: PlaceholderPageProps): JSX.Element {
  return (
    <div className="min-h-screen bg-paper px-4 pt-safe">
      <div className="h-14 flex items-center justify-center">
        <span className="t-h3">{title}</span>
      </div>
      <div className="mt-2 rounded-card bg-surface shadow-card p-4">
        <div className="t-body text-ink-2">
          {code ? `${code} · ` : ''}
          {title}
        </div>
        {future ? (
          <div className="mt-2 t-caption text-ink-3">由 {future} 承接（T04/T05 交付）</div>
        ) : null}
        {children ? <div className="mt-3">{children}</div> : null}
      </div>
    </div>
  );
}
