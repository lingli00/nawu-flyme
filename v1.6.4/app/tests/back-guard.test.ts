// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { mountBackGuard } from '../src/lib/backGuard';

/**
 * v1.0.16 回归：嵌套弹层的返回守卫。
 * 旧实现：内层弹层经 UI 关闭时 cleanup 里的 history.back() 产生 popstate，
 * 外层守卫也收到 → 误关整个表单（用户实测「确认裁剪 → 回到首页，什么都没保存」）。
 *
 * 注意：UI 关闭后有 150ms 抑制窗（让外层忽略随之而来的 popstate），
 * 所以每个 firePop 前要等窗口过期。
 */

let popListeners: Array<() => void> = [];
const origAdd = window.addEventListener.bind(window);
const origRemove = window.removeEventListener.bind(window);

beforeAll(() => {
  window.addEventListener = ((type: string, fn: EventListener) => {
    if (type === 'popstate') popListeners.push(fn as () => void);
    return origAdd(type as never, fn as never);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, fn: EventListener) => {
    if (type === 'popstate') popListeners = popListeners.filter((f) => f !== fn);
    return origRemove(type as never, fn as never);
  }) as typeof window.removeEventListener;
});

/** 模拟浏览器「返回」：触发所有 popstate 监听。 */
function firePop(): void {
  for (const fn of [...popListeners]) fn();
}

/** 等过 UI 关闭后的 150ms 抑制窗。 */
const wait = (ms = 170): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('backGuard · 嵌套弹层', () => {
  it('内层 UI 关闭（cleanup back）不误关外层', async () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();

    const unmountOuter = mountBackGuard(outerClose);
    const unmountInner = mountBackGuard(innerClose);

    // 内层经 UI 关闭：卸载 → cleanup history.back() + 抑制窗
    unmountInner();
    firePop(); // 这次 pop 是内层自己的 back 产生的（在抑制窗内）
    expect(innerClose).not.toHaveBeenCalled();
    expect(outerClose).not.toHaveBeenCalled(); // ★旧实现这里会误关

    await wait(); // 等抑制窗过期
    // 外层仍守着：再返回一次才关外层
    firePop();
    expect(outerClose).toHaveBeenCalledTimes(1);
    unmountOuter();
  });

  it('返回手势只关栈顶（内层），外层保留', async () => {
    await wait(); // 隔开上一个用例 cleanup 的抑制窗
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    const unmountOuter = mountBackGuard(outerClose);
    mountBackGuard(innerClose);

    firePop(); // 真实返回：弹的是内层占位
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
    unmountOuter();
  });

  it('单层弹层返回手势正常关闭', async () => {
    await wait();
    const close = vi.fn();
    const unmount = mountBackGuard(close);
    firePop();
    expect(close).toHaveBeenCalledTimes(1);
    unmount();
  });
});

/**
 * v1.0.22 回归：「加号菜单点卡片没反应」恶性 bug。
 * 根因：弹层关闭（cleanup 主动 history.back()）与点击里的前进导航
 * （nav → pushState）竞争 —— back 把刚 push 的目标页弹回原位。
 * 修复：守卫挂载后记录 history.length，cleanup 时长度变了就跳过回退。
 */
describe('backGuard · 守卫期间的前进导航', () => {
  it('UI 关闭时若发生过 pushState（前进导航），cleanup 不再 back', async () => {
    await wait();
    const close = vi.fn();
    const backSpy = vi.spyOn(window.history, 'back');
    const unmount = mountBackGuard(close);
    // 模拟菜单点击后的前进导航（react-router nav → history.push）
    window.history.pushState({ route: '/ai' }, '');
    unmount(); // 弹层卸载：长度已变 → 不应再 back（否则会把 /ai 弹掉）
    expect(backSpy).not.toHaveBeenCalled();
    backSpy.mockRestore();
  });

  it('无导航时纯 UI 关闭照旧撤占位（back 被调用）', async () => {
    await wait();
    const close = vi.fn();
    const backSpy = vi.spyOn(window.history, 'back');
    const unmount = mountBackGuard(close);
    unmount();
    expect(backSpy).toHaveBeenCalledTimes(1);
    backSpy.mockRestore();
  });
});
