import { useCallback, useRef, useState, type ReactNode, type TouchEvent } from 'react';

/**
 * 下拉刷新（★v1.7.1，PRD H-03）。
 *
 * 手势规则：
 * - 只有**滚动容器已在顶部**时才进入拉取（从列表中间下拉不触发）；
 * - 横向位移大于纵向 → 立即放弃（不与主壳「左右滑动切页」抢手势）；
 * - 输入框 / 文本域内的触摸不触发；
 * - 指示器为覆盖层（不挤压内容布局），拉动距离带阻尼。
 */

const MAX_PULL = 64;
const TRIGGER = 56;
const DAMPING = 0.42;
const MIN_SPINNER_MS = 450;

function editableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

/** 触点向上找第一个可滚动祖先，判断是否已滚到顶部。 */
function scrollAtTop(t: EventTarget | null): boolean {
  let el = t as HTMLElement | null;
  while (el && el !== document.body) {
    if (el instanceof Element) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el.scrollTop <= 0;
    }
    el = el.parentElement;
  }
  return true;
}

export default function PullToRefresh({
  onRefresh,
  children,
  className,
}: {
  onRefresh: () => Promise<void> | void;
  children: ReactNode;
  className?: string;
}) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const startY = useRef(0);
  const startX = useRef(0);
  const engaged = useRef(false);
  const busyRef = useRef(false);

  const finish = useCallback(async () => {
    setBusy(true);
    const startedAt = Date.now();
    try {
      await onRefresh();
    } catch {
      /* 刷新失败不打扰（同步引擎自己会记错误状态） */
    }
    const wait = Math.max(0, MIN_SPINNER_MS - (Date.now() - startedAt));
    window.setTimeout(() => {
      setBusy(false);
      setPull(0);
    }, wait);
  }, [onRefresh]);

  const onTouchStart = useCallback((e: TouchEvent<HTMLDivElement>) => {
    if (busyRef.current || e.touches.length !== 1) return;
    if (editableTarget(e.target)) return;
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    engaged.current = false;
  }, []);

  const onTouchMove = useCallback(
    (e: TouchEvent<HTMLDivElement>) => {
      if (busyRef.current || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - startX.current;
      const dy = t.clientY - startY.current;
      if (!engaged.current) {
        // 还没进入拉取态：横移占优 / 不在顶部 → 整段放弃
        if (Math.abs(dx) > Math.abs(dy)) return;
        if (dy <= 8 || !scrollAtTop(t.target)) return;
        engaged.current = true;
      }
      if (dy <= 0) {
        setPull(0);
        return;
      }
      e.preventDefault(); // 拉取中阻断原生橡皮筋（必须 non-passive）
      setPull(Math.min(MAX_PULL, dy * DAMPING));
    },
    [],
  );

  const onTouchEnd = useCallback(() => {
    if (busyRef.current) return;
    if (pull >= TRIGGER) {
      busyRef.current = true;
      setPull(TRIGGER);
      void finish().finally(() => {
        busyRef.current = false;
      });
    } else {
      setPull(0);
    }
    engaged.current = false;
  }, [pull, finish]);

  const shown = busy ? TRIGGER : pull;
  const opacity = Math.min(1, shown / TRIGGER);
  const label = busy ? '刷新中…' : shown >= TRIGGER ? '松手刷新' : '下拉刷新';

  return (
    <div
      className={`relative ${className ?? ''}`}
      // ★v1.7.9：由 pan-y 改为 pan-x pan-y。pan-y 会把横向手势从浏览器原生滚动里剔除，
      // 令外层 .nw-pager-track（原生 scroll-snap 分页器）永远收不到横向拖动 → 左右滑不动。
      // 本组件的 onTouchMove 只在「纵向、已到顶、且进入拉取态」时才 preventDefault，
      // 横向手势不会被它拦截，因此放开到双向后仍能正常横滑切页。
      style={{ touchAction: 'pan-x pan-y' }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {/* 覆盖式指示器：不挤压内容，随拉动下滑淡入 */}
      <div
        aria-hidden={!busy && shown === 0}
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 overflow-hidden text-xs text-ink-3"
        style={{
          height: TRIGGER,
          transform: `translateY(${shown - TRIGGER}px)`,
          opacity,
          transition: busy ? 'transform .18s ease-out' : 'none',
        }}
      >
        <span
          className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line"
          style={{ borderTopColor: 'var(--accent)' }}
        />
        <span>{busy ? '正在同步最新数据…' : label}</span>
      </div>
      {children}
    </div>
  );
}
