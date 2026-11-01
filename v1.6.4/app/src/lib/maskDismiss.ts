import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * ★v1.6.2 遮罩「点击外部关闭」的正确实现。
 *
 * 旧实现把 `onClick={onClose}` 直接挂在遮罩上，配合面板的 `stopPropagation`：
 * 看起来没问题，但**面板内长按拖拽选文字**时，指针移出面板、在遮罩上松开 ——
 * click 事件的 target 会变成按下与抬起两点的共同祖先（也就是遮罩），
 * 于是「选一段字」直接把整个抽屉关掉，用户刚编辑的内容全丢。
 *
 * 现在的判定条件（三条同时满足才算一次有效的「点外部」）：
 * 1. `pointerdown` 的 target 就是遮罩本身（不是面板里的任何元素）；
 * 2. 指针移动距离 ≤ 8px（拖拽 / 滑动不算点击）；
 * 3. `pointerup` 的 target 仍是遮罩本身，且此刻没有非空文本选区。
 *
 * 因此：面板内选字、粘贴、鼠标临时移出面板边界再回来、面板内滚动，
 * 全都不会关闭面板；只有真正点一下面板外的空白处才关。
 */
export function useMaskDismiss(onDismiss: () => void): {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
} {
  const st = useRef({ armed: false, x: 0, y: 0, moved: false });

  return {
    onPointerDown: (e) => {
      st.current = { armed: e.target === e.currentTarget, x: e.clientX, y: e.clientY, moved: false };
    },
    onPointerMove: (e) => {
      if (!st.current.armed || st.current.moved) return;
      const dx = e.clientX - st.current.x;
      const dy = e.clientY - st.current.y;
      if (Math.hypot(dx, dy) > 8) st.current.moved = true;
    },
    onPointerUp: (e) => {
      const armed = st.current.armed;
      const moved = st.current.moved;
      st.current.armed = false;
      if (!armed || moved) return;
      if (e.target !== e.currentTarget) return;
      // 拖拽选文字后松手会清掉选区，但某些内核会保留 → 有选区就不关
      const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
      if (sel && !sel.isCollapsed && (sel.toString() ?? '').trim()) return;
      onDismiss();
    },
    onPointerCancel: () => {
      st.current.armed = false;
    },
  };
}
