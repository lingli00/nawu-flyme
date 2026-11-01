/**
 * 全局「打开对话式智能记录面板」信号（v1.3.1）。
 *
 * 背景：加号重构后，「对话记一笔」入口散布在多处——
 * 移动端加号右滑、电脑端加号菜单「对话记一笔」卡、生活流空态 CTA。
 * SmartRecordDock 由 MainShell 全局挂载，open 状态在组件内部，
 * 跨组件打开统一走本事件（与 gf:shell-pref / gf:skin 同风格）。
 */

const EVENT = 'gf:open-smart-record';

/** 请求打开对话面板（SmartRecordDock 监听后置 open=true）。 */
export function openSmartRecord(): void {
  window.dispatchEvent(new Event(EVENT));
}

/** 订阅打开请求；返回取消订阅函数。 */
export function onOpenSmartRecord(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
