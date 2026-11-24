/**
 * 跨组件「打开记录/生活流弹层」信号总线（v1.0.22）。
 *
 * 背景（恶性 bug 修复）：加号菜单原来靠「写 sessionStorage 标志 + navigate」
 * 让目标页弹出表单，但**同路由 push 不会重装页面**，mount effect 不跑、
 * 标志没人消费 —— 用户反复点菜单毫无反应；等某次跨路由往返后页面重装，
 * 攒下的多个标志被一次性消费，才出现「跳物品页紧接着又跳订阅页」。
 *
 * 现在：同路由（菜单与目标页在同一路径）走本总线直接发信号，页面立即弹层；
 * 跨路由才用 sessionStorage 标志 + navigate（目标页挂载时消费）。
 * 两条路径互斥，不会重复弹。
 *
 * ★v1.3.1：'ai' 移除——对话式记录改走全局 SmartRecordDock
 * （lib/smartRecordBus.ts），不再经弹层总线。
 */

export type SheetKey = 'record' | 'goods' | 'sub' | 'wish' | 'cooldown' | 'mood' | 'time';

const listeners = new Map<SheetKey, Set<() => void>>();

/** 订阅某弹层的打开信号；返回取消订阅函数（供 useEffect cleanup）。 */
export function onSheetOpen(key: SheetKey, fn: () => void): () => void {
  const set = listeners.get(key) ?? new Set<() => void>();
  set.add(fn);
  listeners.set(key, set);
  return () => {
    const cur = listeners.get(key);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listeners.delete(key);
  };
}

/**
 * 发信号打开弹层；返回是否有订阅者收到（false = 目标页未挂载，
 * 调用方应退回「sessionStorage 标志 + navigate」自愈）。
 */
export function emitSheetOpen(key: SheetKey): boolean {
  const set = listeners.get(key);
  if (!set || set.size === 0) return false;
  for (const fn of [...set]) fn();
  return true;
}
