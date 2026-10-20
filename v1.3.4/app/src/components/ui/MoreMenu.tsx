import { createPortal } from 'react-dom';
import { useState } from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { useBackGuard } from '../../lib/backGuard';
import { haptic } from '../../lib/haptics';
import { useMediaQuery } from '../../lib/useMediaQuery';

/**
 * P0-1 / P1-9 · 「⋯」更多菜单。
 *
 * 背景：物品编辑原先只能靠「长按 500ms」触发，界面零提示，大量用户永远发现不了。
 * 现在每张卡片常驻 ⋯ 按钮（44px 触达），点击弹出菜单；长按保留为快捷方式。
 *
 * 用法（卡片内嵌，自足式，自管开合）：
 *   <MoreMenuButton items={[
 *     { key: 'detail', label: '查看详情', onSelect: () => setDetailId(g.id) },
 *     { key: 'edit', label: '编辑', onSelect: () => setEditing(g) },
 *     { key: 'del', label: '删除', danger: true, onSelect: () => void del(g) },
 *   ]} />
 *
 * 注意：卡片本体有点击/长按手势，按钮内部已 stopPropagation 指针事件，不会误触卡片。
 */

export type MoreMenuItem = {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** 破坏性操作（删除）：陶土色 + 确认由调用方负责。 */
  danger?: boolean;
  onSelect: () => void;
};

/** 菜单面板本体（受控，便于宿主自定义触发器）。 */
export function MoreMenu({ items, onClose }: { items: MoreMenuItem[]; onClose: () => void }): JSX.Element {
  const wide = useMediaQuery('(min-width: 1024px)');
  useBackGuard(true, onClose);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex bg-black/40"
      style={wide ? { alignItems: 'center', justifyContent: 'center' } : { alignItems: 'flex-end' }}
      onClick={onClose}
    >
      <div
        className={
          wide
            ? 'pop-enter mx-auto w-full max-w-xs rounded-2xl bg-surface p-2 shadow-2xl'
            : 'sheet-enter mx-auto w-full max-w-xl rounded-t-3xl bg-surface p-2 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-2xl'
        }
        onClick={(e) => e.stopPropagation()}
      >
        {/* 小把手：底部弹层统一语言（v1.3.1） */}
        {!wide ? (
          <div className="flex justify-center pt-1.5 pb-1">
            <span className="h-1 w-9 rounded-full bg-line-2" aria-hidden />
          </div>
        ) : null}
        {items.map((it) => (
          <button
            key={it.key}
            onClick={() => {
              void haptic('select');
              onClose();
              it.onSelect();
            }}
            className="flex min-h-[48px] w-full items-center gap-3 rounded-btn px-3 text-left text-sm active:bg-surface-2"
          >
            {it.icon ? (
              <it.icon
                size={17}
                strokeWidth={1.8}
                aria-hidden
                style={{ color: it.danger ? 'var(--fou)' : 'var(--ink-3)' }}
              />
            ) : null}
            <span className={it.danger ? 'font-medium' : 'text-ink'} style={it.danger ? { color: 'var(--fou)' } : undefined}>
              {it.label}
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** 自足式「⋯」触发器：卡片 / 列表行内嵌，44px 触达，自管开合。 */
export function MoreMenuButton({
  items,
  label = '更多操作',
  /** 紧凑态（36px）：用于网格卡图片区浮层，配半透明底保证图上可读。 */
  compact = false,
}: {
  items: MoreMenuItem[];
  label?: string;
  compact?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          void haptic('select');
          setOpen(true);
        }}
        // 阻止冒泡到卡片的指针手势（否则会同时触发长按/详情）
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        aria-label={label}
        aria-expanded={open}
        className={`flex shrink-0 items-center justify-center rounded-full text-ink-2 transition-transform active:scale-95 ${
          compact
            ? 'h-9 w-9 bg-surface/85 backdrop-blur-sm'
            : 'h-11 w-11 active:bg-surface-2'
        }`}
      >
        <MoreHorizontal size={compact ? 16 : 18} aria-hidden />
      </button>
      {open ? <MoreMenu items={items} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
