// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { emitSheetOpen, onSheetOpen } from '../src/lib/sheetBus';

/**
 * v1.0.22：加号菜单同路由开层信号总线。
 * 旧实现（sessionStorage 标志 + 无脑 navigate）在同路由时 push 不重装页面，
 * mount effect 不跑 → 标志没人消费 →「反复点菜单没反应」。
 * 现在同路由走本总线：页面订阅 → 菜单 emit → 立即开层。
 */
describe('sheetBus', () => {
  it('订阅后 emit 立即触发；退订后不再触发', () => {
    const fn = vi.fn();
    const off = onSheetOpen('wish', fn);
    emitSheetOpen('wish');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    emitSheetOpen('wish');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('不同 key 互不干扰', () => {
    const wish = vi.fn();
    const mood = vi.fn();
    const offW = onSheetOpen('wish', wish);
    const offM = onSheetOpen('mood', mood);
    emitSheetOpen('mood');
    expect(wish).not.toHaveBeenCalled();
    expect(mood).toHaveBeenCalledTimes(1);
    offW();
    offM();
  });

  it('v1.0.24：emit 返回是否有订阅者（false 时调用方走标志+导航自愈）', () => {
    const fn = vi.fn();
    const off = onSheetOpen('goods', fn);
    expect(emitSheetOpen('goods')).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    expect(emitSheetOpen('goods')).toBe(false);
  });

  it('多个订阅者都能收到', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onSheetOpen('time', a);
    const offB = onSheetOpen('time', b);
    emitSheetOpen('time');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });
});
