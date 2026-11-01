import { useEffect } from 'react';

/**
 * Android 返回手势/返回键关闭弹层（v1.0.9 引入，v1.0.16 栈式重写）。
 *
 * 原理：弹层打开时压入一个占位历史记录，popstate 到它时执行 onClose；
 * 用户点遮罩/按钮关闭时，组件卸载的 cleanup 里主动 history.back() 弹掉占位。
 *
 * ★ v1.0.16 修复「确认裁剪 → 整个表单被关掉回到首页」：
 * 嵌套弹层（表单 sheet 上叠裁剪层）时，内层 cleanup 的 history.back() 会产生
 * 一个 popstate —— 旧实现里外层守卫的监听器也收到它，把整个表单误关。
 * 现在改为模块级守卫栈 + 双重判定：
 *   ① 内层主动 back 前设置 150ms 抑制窗，其他层收到 popstate 直接忽略
 *     （它们自己的占位历史还在，守卫继续生效）；
 *   ② 真实返回手势只会弹出栈顶（最近压入）的占位，非栈顶的守卫同样忽略。
 *
 * ★ v1.0.22 修复「加号菜单点卡片点击没反应」：
 * 弹层关闭的同时若发生了前进导航（菜单点击 → nav 目标路由），
 * cleanup 不再主动 history.back()（否则会把刚 push 的目标页弹回去）。
 * 判定方式：挂载后记录 history.length，cleanup 时长度变了就跳过回退。
 */
type Guard = { onClose: () => void };

/** 活跃守卫栈：后进先出，对应历史记录的压入顺序。 */
const stack: Guard[] = [];
/** 内层 cleanup 主动 history.back() 的抑制窗截止时刻（其他守卫忽略这段内的 popstate）。 */
let suppressUntil = 0;

/** 挂载一个返回守卫：压历史占位 + 入栈；返回卸载函数（UI 关闭时调用）。
 *  useBackGuard 是它的 React 包装；抽成纯函数便于单测嵌套语义。 */
export function mountBackGuard(onClose: () => void): () => void {
  if (typeof window === 'undefined' || !window.history?.pushState) {
    return () => undefined;
  }
  try {
    window.history.pushState({ gfSheet: Date.now() }, '');
  } catch {
    return () => undefined;
  }
  // ★ v1.0.22 修复「加号菜单点卡片没反应」：守卫存活期间若发生了前进导航
  // （菜单点击后 nav 到目标路由），cleanup 不再主动 history.back()——
  // 那个 back 会把刚 push 进去的目标页弹回原位，用户看到的就是「点了没反应」。
  // 用 length 判定：pushState 会同步 +1；正常 UI 关闭时长度不变，照旧回退撤占位。
  const lenAtMount = window.history.length;
  const self: Guard = { onClose };
  stack.push(self);
  let consumed = false;

  const onPop = (): void => {
    // ① 内层弹层经 UI 关闭时主动 back 产生的 popstate：与本层无关，忽略。
    if (Date.now() < suppressUntil) return;
    // ② 真实返回只弹最近压入的占位：非栈顶说明弹的是更内层的，本层占位仍在，忽略。
    if (stack[stack.length - 1] !== self) return;
    // 弹的就是本层占位 → 关闭本层。
    const i = stack.indexOf(self);
    if (i !== -1) stack.splice(i, 1);
    consumed = true;
    window.removeEventListener('popstate', onPop);
    onClose();
  };
  window.addEventListener('popstate', onPop);
  return () => {
    window.removeEventListener('popstate', onPop);
    const i = stack.indexOf(self);
    if (i !== -1) stack.splice(i, 1);
    // 仅当守卫期间没有发生前进导航才撤占位（详见 lenAtMount 注释）。
    if (!consumed && window.history.length === lenAtMount) {
      // 本层经 UI 途径关闭：主动撤掉占位历史；抑制窗让外层守卫忽略随之而来的 popstate。
      suppressUntil = Date.now() + 150;
      try {
        window.history.back();
      } catch {
        /* ignore */
      }
    }
  };
}

export function useBackGuard(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    return mountBackGuard(onClose);
    // onClose 用闭包即可：随 active 变化重建监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
