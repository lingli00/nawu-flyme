/**
 * 桌面外观皮肤。★2026-10-18 定稿：默认 glass（方案 07 玻璃浮层）。
 *
 * ★ 只影响「桌面壳的材质与配色」，不碰任何业务组件、表单字段、交互流程。
 *   手机端（<1024px）与手机网页版完全不受影响（皮肤只在 data-shell="pc" 时生效）。
 *
 * 取值：
 *   glass   —— 07 玻璃浮层：渐变纸底 + 浮起圆角侧栏卡 + 白玻璃卡 —— **默认**
 *   classic —— 旧观感（深绿通栏侧栏 240 + 1240 内容区），留作对照
 *   night   —— 09 暗夜夜航：深色为默认 + 通栏扁平侧栏 + 发光高亮条（备选）
 *
 * ★ 不碰 data-theme：主题由 lib/theme.ts 独占（applyTheme 会覆盖它的值）。
 *   night 的深色只在 data-shell="pc" 下用 CSS 变量覆盖，
 *   因此手机端永远是用户自己的主题，不会因为开了皮肤而变暗。
 */

export type Skin = 'classic' | 'glass' | 'night';

const SKIN_KEY = 'gf.skin';
const PREVIEW_KEY = 'gf.skin.preview';

export const SKIN_LABEL: Record<Skin, string> = {
  glass: '玻璃浮层',
  classic: '原来那套',
  night: '暗夜夜航',
};

const SKINS: readonly Skin[] = ['glass', 'classic', 'night'];
/** 默认皮肤（2026-10-18 用户选定 07）。 */
const DEFAULT_SKIN: Skin = 'glass';

export function getSkin(): Skin {
  try {
    const v = localStorage.getItem(SKIN_KEY);
    if (v && (SKINS as readonly string[]).includes(v)) return v as Skin;
  } catch {
    /* 隐私模式忽略 */
  }
  return DEFAULT_SKIN;
}

/** 把当前皮肤写到 <html data-skin>，CSS 据此覆盖变量与壳层材质。 */
export function applySkin(skin: Skin): void {
  document.documentElement.dataset.skin = skin;
}

export function setSkin(skin: Skin): void {
  try {
    localStorage.setItem(SKIN_KEY, skin);
  } catch {
    /* ignore */
  }
  applySkin(skin);
  window.dispatchEvent(new Event('gf:skin'));
}

export function isPreviewOn(): boolean {
  return document.documentElement.dataset.skinPreview === '1';
}

export function setPreview(on: boolean): void {
  try {
    localStorage.setItem(PREVIEW_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.skinPreview = on ? '1' : '0';
  window.dispatchEvent(new Event('gf:skin'));
}

/**
 * 预览模式：★v1.1.8 定稿后切换条**默认隐藏**（皮肤已定 07，线上不再出现调试浮条）。
 * URL 带 ?skin=1 可强制打开，并把参数从地址栏抹掉；打开过一次会记住（gf.skin.preview=1），
 * 双击整条收起后写 0，此后不再打扰（皮肤本身继续生效）。
 */
export function bootSkin(): void {
  let preview = false;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('skin') === '1') {
      preview = true;
      localStorage.setItem(PREVIEW_KEY, '1');
      q.delete('skin');
      const rest = q.toString();
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash,
      );
    } else {
      preview = localStorage.getItem(PREVIEW_KEY) === '1';
    }
  } catch {
    /* ignore */
  }
  applySkin(getSkin());
  document.documentElement.dataset.skinPreview = preview ? '1' : '0';
}
