// @vitest-environment jsdom
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import MainShell from '../src/components/layout/MainShell';

/**
 * ★v1.8.0 整站可渲染冒烟测试（防「白屏」类回归）。
 *
 * 为什么需要它：v1.8.0 上线时出过一次**整站白屏** ——
 *   `App.tsx` 把 `const renderTabPane = useCallback(...)` 写在了**模块顶层**（组件之外），
 *   Hook 在 React 渲染上下文外执行 → `ReactCurrentDispatcher.current === null` →
 *   启动即抛 `Cannot read properties of null (reading 'useCallback')` → `#root` 全空。
 *
 * 当时 **627 个单测全部通过**却完全没抓到：没有一条用例真正去挂载 `<App />` 本身
 * （现有用例都是单独测 MainShell / 各页面）。这条测试补上这个盲区：
 *   · 用例 1 守「整站别死」——挂载 `<App/>` 不许抛错，且要渲染出东西；
 *   · 用例 2 守「壳层结构」——直接挂 MainShell（绕开 App 的 hydrate 门槛，
 *     jsdom 里 store 不会真的 hydrate 完成，App 会一直停在开屏层）。
 */

function stubBrowserApis(): void {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  const g = globalThis as unknown as { ResizeObserver?: unknown };
  if (!g.ResizeObserver) {
    g.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
}

describe('App 整站冒烟（防白屏）', () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  let errors: unknown[] = [];
  let onWinError: ((ev: ErrorEvent) => void) | null = null;

  beforeEach(() => {
    stubBrowserApis();
    // 强制移动壳：壳层按 useShellMode() 判定（视口够宽 + 无偏好时走桌面壳）。
    localStorage.setItem('gf.shellPref', 'mobile');
    host = document.createElement('div');
    document.body.appendChild(host);

    // React 18.3 的 RootOptions 没有 onUncaughtError，用全局 error 事件兜住
    errors = [];
    onWinError = (ev: ErrorEvent): void => {
      errors.push(ev.error ?? ev.message);
    };
    window.addEventListener('error', onWinError);
  });

  afterEach(async () => {
    if (onWinError) window.removeEventListener('error', onWinError);
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    host.remove();
    localStorage.removeItem('gf.shellPref');
  });

  it(
    '挂载 <App/> 不抛错，且渲染出可见内容（白屏回归防线）',
    { timeout: 20000 },
    async () => {
      let renderError: unknown = null;
      try {
        root = createRoot(host);
        await act(async () => {
          root?.render(
            createElement(MemoryRouter, { initialEntries: ['/home'] }, createElement(App)),
          );
        });
        // 给启动链路一点时间跑（bootstrap / 懒加载 / effects）
        await act(async () => {
          await new Promise((r) => setTimeout(r, 1500));
        });
      } catch (e) {
        renderError = e;
      }

      // 1) 渲染不许抛错 —— 白屏类 bug 必然落这里。
      //    典型错误：`Cannot read properties of null (reading 'useCallback')`（模块级 Hook）
      if (renderError) errors.push(renderError);
      expect(errors, `挂载期间抛错：${errors.map((e) => String(e)).join(' | ')}`).toHaveLength(0);
      // 2) 必须渲染出内容 —— 白屏时 host.innerHTML 为空。
      expect(host.innerHTML.length).toBeGreaterThan(100);
    },
  );

  it(
    'MainShell 挂出移动壳结构：pager / 底栏 wrapper / 把手，且把手在 nav 外',
    { timeout: 20000 },
    async () => {
      root = createRoot(host);
      await act(async () => {
        root?.render(
          createElement(
            MemoryRouter,
            { initialEntries: ['/home'] },
            createElement(MainShell, {
              children: null,
              tabPane: (p: string): ReactNode => createElement('i', { 'data-pane': p }, p),
            }),
          ),
        );
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
      });

      expect(errors, `挂载期间抛错：${errors.map((e) => String(e)).join(' | ')}`).toHaveLength(0);

      // 分页器
      expect(document.querySelector('.nw-pager-track')).not.toBeNull();
      // 底栏 wrapper 与把手（v1.8.0 bug4 新结构）
      expect(document.querySelector('.nw-tabbar-wrap')).not.toBeNull();
      expect(document.querySelector('.nw-tabbar-grip')).not.toBeNull();
      // 把手必须在 <nav> 之外：底栏里仍只有四个页签，不许混进按钮
      const nav = document.querySelector('nav');
      expect(nav).not.toBeNull();
      expect(nav!.querySelector('.nw-tabbar-grip')).toBeNull();
      expect(nav!.querySelectorAll('button')).toHaveLength(0);
    },
  );
});