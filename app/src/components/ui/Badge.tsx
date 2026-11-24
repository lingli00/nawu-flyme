/**
 * Badge 徽标（DESIGN-SYSTEM v1 §4.2）。
 *
 * 收编各页手写的 `rounded-full px-1.5 py-0.5 text-[10px] font-medium` 拼接，
 * 统一由语义令牌上色（tone 对应 --*-soft 底 + --* 字，深浅色自动跟随）。
 * 内部字号锁定 .t-mini（10/14，字重 500）；文字缩放由 t-mini 行高兜底。
 */

import type { ReactNode } from 'react';

export type BadgeTone = 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'neutral';

const TONES: Record<BadgeTone, string> = {
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  neutral: 'bg-surface-2 text-ink-2',
};

export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`t-mini inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
