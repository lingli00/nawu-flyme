import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * 「输入即搜」的输入框绑定（IME 铁律，v1.3.5）。
 *
 * ## 为什么不能只用 onChange
 * Android WebView + 中文输入法在**选词提交**那一刻，浏览器偶尔不派发 `input` /
 * `change`（同一现象在本项目 IconPicker 里已经踩过一次，见那里的「IME 铁律」注释）。
 * 结果就是用户把「馒头」两个字都输完了，React 侧还是上一帧的 state —— 列表毫无反应；
 * 再随手删掉一个字，`input` 事件这次派发了，搜索突然又好了。
 * 这就是「必须删一个字符才能搜」的全部原因，不是过滤逻辑写错。
 *
 * ## 做法
 * 事件 + 轮询双保险：
 * - 监听 `input / change / keyup / paste / cut / compositionupdate / compositionend / search / blur`；
 * - 再用 150ms 轮询直接读 `el.value` 兜底 —— 只要 DOM 值变了就同步，绝不漏最后一次输入。
 *
 * 输入框本身保持**非受控**（`defaultValue`），避免中文输入法组词时受控回写把光标顶到末尾。
 *
 * 用法：
 * ```tsx
 * const searchRef = useLiveInput((v) => setKeyword(v), searchOpen);
 * <input ref={searchRef} defaultValue="" placeholder="搜索" />
 * ```
 */
export function useLiveInput(
  onValue: (value: string) => void,
  active: boolean = true,
  pollMs: number = 150,
): RefObject<HTMLInputElement> {
  const ref = useRef<HTMLInputElement | null>(null);
  /* 回调放 ref：父组件每次渲染都传新函数也不会反复重建监听。 */
  const cb = useRef(onValue);
  cb.current = onValue;

  useEffect(() => {
    if (!active) return undefined;
    const el = ref.current;
    if (!el) return undefined;

    let last = el.value;
    const sync = (): void => {
      if (el.value === last) return;
      last = el.value;
      cb.current(el.value);
    };

    const events = [
      'input',
      'change',
      'keyup',
      'paste',
      'cut',
      'compositionupdate',
      'compositionend',
      'search',
      'blur',
    ] as const;
    for (const name of events) el.addEventListener(name, sync);

    /* 轮询兜底：事件全部丢失（IME 提交、WebView 合成输入）也能在 150ms 内同步。 */
    const timer = window.setInterval(sync, pollMs);

    return () => {
      window.clearInterval(timer);
      for (const name of events) el.removeEventListener(name, sync);
    };
  }, [active, pollMs]);

  return ref;
}
