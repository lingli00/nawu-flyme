/**
 * ★★★ 光标保护（Caret Guard）· v1.6.4 关键逻辑 ★★★
 * ============================================================================
 * ⚠️⚠️  本文件是「输入框光标跳到末尾」这一恶性 Bug 的**唯一修复点**。
 * ⚠️⚠️  重构、精简、重写输入框时：**禁止删除本文件、禁止注释掉任何一处
 * ⚠️⚠️  readCaret / writeCaret / requestAnimationFrame 二次恢复**。
 * ⚠️⚠️  删掉它 = Bug 立刻复发（用户已明确要求这段逻辑长期保留）。
 * ============================================================================
 *
 * 症状（用户反复反馈）：
 *   在输入框里把光标点到**文字中间**，删掉一个字、或插入一个字，
 *   光标会瞬间跳到整句话的末尾，接着输入的字全部落在句尾。
 *
 * 两个真实成因（都已在本版修复，二者缺一不可）：
 *
 * ① 原生层：Capacitor `android.captureInput: true`（见 capacitor.config.ts）。
 *    Capacitor 的 CapacitorWebView.onCreateInputConnection() 一旦读到该开关，
 *    会返回自己 new 的 `BaseInputConnection`，而不是 Chromium 的
 *    `WebViewInputConnection`。BaseInputConnection 是给「硬键盘按键」用的简化实现，
 *    完全不参与输入法的组合区（composing region）管理：
 *      · 中文输入法组合期 setComposingText / commitText 走简化路径，
 *        光标的 selection 与组合区一脱节，WebView 只能把光标顶到末尾；
 *      · deleteSurroundingText（删一个字）在简化实现里退化为「整段重设文本」，
 *        同样把光标顶到末尾。
 *    → 修复：captureInput 改回 Capacitor 默认值 false。
 *
 * ② JS 层：输入事件里改 DOM 会重置光标。
 *    textarea 自适应高度（`style.height = scrollHeight`）、输入过滤/格式化替换
 *    `value`，都会触发布局与选区重算；Android WebView 在**输入法组合期**做这件事，
 *    会把 selection 重排到文本末尾。
 *    → 修复：本文件的「先存光标 → 再动 DOM → 立刻恢复 → 下一帧再确认恢复一次」。
 *
 * 铁律（后续迭代必须遵守）：
 *   1. 任何在 input / compositionEnd / 高度自适应 里改动 textarea 的代码，
 *      必须包在 `preserveCaret()` 或 `autoGrowTextarea()` 里；
 *   2. 输入框永远**非受控**（defaultValue），禁止因为改值把整个输入框 DOM
 *      卸载重建（key 变化、条件渲染切换都会丢光标）；
 *   3. requestAnimationFrame 那一帧的二次恢复不能省 —— 浏览器/WebView 的
 *      选区重排发生在事件处理之后的下一帧，同步恢复常被覆盖。
 */

/** 记录下来的光标位置（选区起点/终点，单位为字符索引）。 */
export interface CaretPos {
  start: number;
  end: number;
}

/** 可承载光标的元素（input / textarea）。 */
export type CaretElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * 读取当前光标/选区。
 *
 * 读不到（元素不存在、input 的 number/email 等不支持 selection 的类型会抛错）时返回 null，
 * 调用方保持原逻辑即可，不要因为读不到就中断输入。
 */
export function readCaret(el: CaretElement | null | undefined): CaretPos | null {
  if (!el) return null;
  try {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    return { start, end };
  } catch {
    return null;
  }
}

/**
 * 把光标恢复到记录的位置。
 *
 * - 位置越界（文本被截断/过滤变短）时夹到合法范围，绝不让 setSelectionRange 抛错；
 * - 位置没变就不调用 setSelectionRange —— 多余的调用本身会打断输入法组合；
 * - 元素未聚焦时不抢焦点（只对齐内部选区），避免影响页面里其它输入框。
 *
 * @returns 是否真的写入过选区（便于测试与日志）
 */
export function writeCaret(el: CaretElement | null | undefined, pos: CaretPos | null): boolean {
  if (!el || !pos) return false;
  // 长度以 DOM 真值为准：过滤/格式化后文本可能已经变短
  const max = el.value.length;
  const start = Math.min(Math.max(0, pos.start), max);
  const end = Math.min(Math.max(start, pos.end), max);
  try {
    if (el.selectionStart === start && el.selectionEnd === end) return false;
    el.setSelectionRange(start, end);
    return true;
  } catch {
    return false;
  }
}

/**
 * 包住「会动 DOM 的操作」，动完把光标放回原处。
 *
 * 时序（缺一不可）：
 *   1. 事件最开始 → 读 selectionStart / selectionEnd；
 *   2. 执行真正的校验 / 过滤 / 格式化 / 高度自适应；
 *   3. 同步恢复一次（覆盖绝大多数桌面浏览器与老 WebView）；
 *   4. requestAnimationFrame 里再确认一次（覆盖「选区重排发生在下一帧」的
 *      Android WebView；只在光标确实被挪走时才写入）。
 *
 * @param el     目标输入框
 * @param mutate 需要执行的 DOM 变更（返回原值，便于链式使用）
 * @param caret  可选：**函数入口处**就记下的光标。传了就以它为准，不再现场读。
 *               为什么需要：读取布局（scrollHeight / offsetHeight）本身就可能
 *               触发 WebView 的选区重排 —— 现场的 selection 可能已经被甩到末尾，
 *               拿它去恢复等于「恢复到了错误的位置」。
 */
export function preserveCaret<T>(
  el: CaretElement | null | undefined,
  mutate: () => T,
  caret?: CaretPos | null,
): T {
  const saved = caret === undefined ? readCaret(el) : caret;
  const out = mutate();
  if (!el || !saved) return out;

  writeCaret(el, saved);

  // ★关键：下一帧再确认一次。此段禁止删除（见文件头说明）。
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      writeCaret(el, saved);
    });
  }
  return out;
}

/** 缓存「单行高度」用（WeakMap，不污染 DOM、组件卸载自动回收）。 */
const oneLineHeights = new WeakMap<HTMLTextAreaElement, number>();

/**
 * 单行高度 = 行高 + 上下内边距 + 上下边框（border-box 口径，与 offsetHeight 一致）。
 *
 * 用计算样式算而不是「量空输入框」：自适应调用时输入框里通常已经有字了，
 * 那时量到的可能是两行；计算样式则任何时刻都准。
 */
function singleLineHeight(el: HTMLTextAreaElement): number {
  const cached = oneLineHeights.get(el);
  if (cached && cached > 0) return cached;

  let h = 0;
  try {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight);
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;
    if (Number.isFinite(lh) && lh > 0) h = lh + pt + pb + bt + bb;
  } catch {
    /* 老 WebView / 非浏览器环境拿不到计算样式：走下面的兜底 */
  }
  // 兜底：空输入框时 offsetHeight 就是单行高度
  if (h <= 0 && el.value === '') h = el.offsetHeight;
  if (h > 0) oneLineHeights.set(el, h);
  return h;
}

/**
 * textarea 自适应高度（★光标安全版）。
 *
 * 旧实现（v1.3.7 ~ v1.6.3）：
 *   `el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px';`
 * —— 每次输入都改两次高度，Android WebView 在输入法组合期因此把光标甩到末尾。
 *
 * 现在：
 *   · 先只读测量（scrollHeight vs clientHeight），**内容没超过一行时完全不动样式**，
 *     单行连续输入这条最高频路径上零 DOM 变更 → 光标不可能被重排；
 *   · 确实需要变高/变矮时才改高度，且改完立刻按 `preserveCaret` 的时序恢复光标；
 *   · 上限仍由 CSS 的 `max-h-40` 兜住，超出则内部滚动。
 */
export function autoGrowTextarea(el: HTMLTextAreaElement | null | undefined): void {
  if (!el) return;

  const caret = readCaret(el);
  const prevBox = el.offsetHeight; // 含边框的实际高度
  const border = Math.max(0, prevBox - el.clientHeight);
  const client = el.clientHeight;
  const scroll = el.scrollHeight;

  /** 单行高度（换算 border-box 口径）：判断「盒子是不是被撑高了」用。 */
  const oneLine = singleLineHeight(el);

  let target = prevBox;

  if (scroll > client + 1) {
    // ① 内容已超出可视区：scrollHeight 就是需要的总高度，只读即可算出，无需先置 auto
    target = scroll + border;
  } else if (oneLine > 0 && prevBox > oneLine + 2) {
    // ② 内容装得下、但盒子此前被撑高了（删掉了一行）→ 才做一次 auto 往返测量
    //    （这条分支只在「从多行收回到更少行」时走，普通单行输入不会进来）
    const restoreH = el.style.height;
    el.style.height = 'auto';
    const natural = el.scrollHeight + border;
    el.style.height = restoreH;
    if (natural < prevBox - 1) target = natural;
  }

  if (Math.abs(target - prevBox) <= 1) {
    // 高度不变：一行都不改样式，只兜一次光标（防止别处重排后没人恢复）
    writeCaret(el, caret);
    return;
  }

  preserveCaret(
    el,
    () => {
      el.style.height = `${target}px`;
    },
    // ★必须把入口处记下的光标传进去：上面读 scrollHeight 时可能已经跳过一次，
    // 再现场读一次得到的就是「末尾」这个错误位置。
    caret,
  );
}
