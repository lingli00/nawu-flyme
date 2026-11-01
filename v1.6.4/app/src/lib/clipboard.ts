/**
 * ★v1.3.6 剪贴板（对话记一笔「复制原文」用）。
 *
 * 为什么不用 `navigator.clipboard` 一处了事：
 * - Android WebView 在 `https://localhost` 源下一般可用，但部分 ROM 的 WebView
 *   在无用户手势/页面未聚焦时会 reject（NotAllowedError）；
 * - 老的 Android 5/6 内核根本没有 `navigator.clipboard`。
 *
 * 因此做成「新 API 优先，`execCommand('copy')` 兜底」，调用方只关心布尔结果，
 * 失败时给用户一句可读提示即可，不抛异常打断交互。
 */

/** 复制一段纯文本；成功返回 true。 */
export async function copyText(text: string): Promise<boolean> {
  const value = text ?? '';
  if (!value) return false;

  const nav = navigator as unknown as { clipboard?: { writeText?: (t: string) => Promise<void> } };
  if (nav.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(value);
      return true;
    } catch {
      /* 落到 execCommand 兜底 */
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    // 必须可见可聚焦才能选中；用透明 + 定位到屏幕外的方式，避免页面跳动
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = 'none';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
