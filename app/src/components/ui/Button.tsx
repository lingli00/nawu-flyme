import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { haptic } from '../../lib/haptics';

/**
 * ★v1.7.6：全站唯一按钮组件。
 *
 * 背景：DESIGN-SYSTEM v1 承诺的 `components/Button.tsx` 从未落地，导致
 * 298 个 `<button>` 散落成 219 种内联 className，按钮间距在 5 个页面里
 * 出现 4/6/8/10px 四种值，PC 端仅 2.2% 做过 `dt:` 增高适配。本组件把
 * 样式来源收敛到 CSS 底座 `.nw-btn`（见 index.css @layer components），
 * 组件本身不拼任何 Tailwind 类 —— 改一次底座，全站按钮同步更新。
 *
 * 用法：
 *   <Button variant="primary" onClick={save}>保存</Button>
 *   <Button variant="outline">取消</Button>          ← 默认就是 outline
 *   <Button variant="primary" block size="lg">记下这笔</Button>
 *   <Button icon={Plus} variant="ghost" aria-label="新增" />  ← 纯图标
 *
 * 铁律：新代码禁止再手写按钮内联样式。并排的按钮必须包在
 * `<ButtonRow>` 里，不要自己写 gap。
 */

export type ButtonVariant = 'primary' | 'soft' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 撑满父容器宽度 */
  block?: boolean;
  /** 左侧图标 */
  icon?: LucideIcon;
  /** 右侧图标 */
  trailingIcon?: LucideIcon;
  /** 加载中：禁用交互 + 图标位换成旋转指示 */
  loading?: boolean;
  children?: ReactNode;
  /** 关闭默认的按压震动（例如在弹层里连续点击时不想要反馈） */
  noHaptic?: boolean;
}

/**
 * 按钮。默认 `variant="outline"`（用于「取消」「返回」等场景），
 * 主操作必须显式传 `variant="primary"` —— 与 DESIGN-SYSTEM §4.1 一致。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'outline',
    size = 'md',
    block = false,
    icon: Icon,
    trailingIcon: Trailing,
    loading = false,
    noHaptic = false,
    disabled,
    children,
    onClick,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      type={type}
      className="nw-btn"
      data-variant={variant}
      data-size={size}
      /*
        ★v1.7.6 修复：block 不能用 `w-full`。
        在外层 flex 容器里 `w-full` 会让按钮撑满并挤压同排其它按钮
        （实测未登录态「注册新账号」被挤出可视区、右侧出现深色残块）。
        改用 `flex-1` + `min-w-0`，让同一组内的按钮等分宽度且能正确收缩。
      */
      style={block ? { flex: '1 1 0%', minWidth: 0, width: '100%' } : undefined}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      onClick={(e) => {
        if (!noHaptic) void haptic('select');
        onClick?.(e);
      }}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : Icon ? (
        <Icon size={size === 'lg' ? 18 : 16} strokeWidth={1.8} aria-hidden />
      ) : null}
      {children}
      {Trailing ? <Trailing size={16} strokeWidth={1.8} aria-hidden /> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> {
  icon: LucideIcon;
  /** 无障碍名称，同时作为 title 提示 */
  label: string;
  size?: number;
  /** 危险操作：图标用 danger 色 */
  danger?: boolean;
}

/**
 * 圆形图标按钮：36px 视觉（PC 40px）+ 44px 隐形命中区。
 * 旧代码里 84 个按钮没有高度类，这一层把它们统一起来。
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = 18, danger = false, disabled, onClick, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className="nw-icon-btn"
      style={danger ? { color: 'var(--danger)' } : undefined}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        void haptic('select');
        onClick?.(e);
      }}
      {...rest}
    >
      <Icon size={size} strokeWidth={1.8} aria-hidden />
    </button>
  );
});

/**
 * 按钮组容器 —— 全站按钮间距的唯一来源。
 *
 * 间距由 `.nw-btn-group` 决定（8px，PC 10px），页面不得自己写 gap。
 * 这解决了旧代码里同一类按钮组在 5 个页面用 4/6/8/10px 四种值的问题。
 */
export function ButtonRow({
  children,
  align = 'start',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'end' | 'between';
  /** 仅允许用于布局微调（如 mt-2），禁止在此写 gap */
  className?: string;
}) {
  return (
    <div className={`nw-btn-group${className ? ` ${className}` : ''}`} data-align={align === 'start' ? undefined : align}>
      {children}
    </div>
  );
}

/**
 * 卡片底部操作行：取消在左、确认在右。
 * 与 `ButtonRow` 的区别是确认键更宽（`flex-[2]`），符合表单心智。
 */
export function ButtonRowActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`nw-btn-row${className ? ` ${className}` : ''}`}>{children}</div>;
}
