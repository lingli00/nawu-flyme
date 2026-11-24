import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

/**
 * P1-9 · 基础输入控件。
 *
 * 原先前端在 tsx 里重复了 48 处输入框样式串（h-11 w-full rounded-btn border-line
 * bg-surface-2 …），改一次样式要动 48 个位置。现在样式底座是 index.css 的
 * .nw-input / .nw-textarea（@layer components），本组件只做语义包装。
 *
 * 铁律不变（HomePage 踩坑总结）：文本输入一律非受控 —— defaultValue + onChange
 * 收集，无 value prop（安卓 IME 组合输入期受控显示值与实际值不同步）。
 */

type BaseProps = {
  /** 错误态：红边 + 红色提示（校验失败时由调用方切换）。 */
  error?: string;
};

export function Input({
  error,
  className = '',
  ...rest
}: BaseProps & InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <div className="w-full">
      <input
        {...rest}
        aria-invalid={error ? true : undefined}
        className={`nw-input ${error ? 'border-danger' : ''} ${className}`}
      />
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
    </div>
  );
}

export function Textarea({
  error,
  className = '',
  ...rest
}: BaseProps & TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return (
    <div className="w-full">
      <textarea
        {...rest}
        aria-invalid={error ? true : undefined}
        className={`nw-textarea ${error ? 'border-danger' : ''} ${className}`}
      />
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
    </div>
  );
}
