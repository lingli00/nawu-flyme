import { useEffect, useState } from 'react';
import { SKIN_LABEL, getSkin, isPreviewOn, setPreview, setSkin, type Skin } from '../lib/skin';

/**
 * 桌面皮肤切换条（预览专用）。
 *
 * ★ 只在 `?skin=1` 打开过一次之后出现，且只在桌面壳（data-shell="pc"）显示。
 *   线上/手机端默认完全不可见，不影响任何现有界面。
 *   双击整条 → 收起（皮肤继续生效，不再打扰）。
 */
export default function SkinBar(): JSX.Element | null {
  const [skin, setLocal] = useState<Skin>(() => getSkin());
  const [on, setOn] = useState<boolean>(() => isPreviewOn());

  useEffect(() => {
    const sync = (): void => {
      setLocal(getSkin());
      setOn(isPreviewOn());
    };
    window.addEventListener('gf:skin', sync);
    return () => window.removeEventListener('gf:skin', sync);
  }, []);

  if (!on) return null;

  return (
    <div
      className="nw-skinbar"
      role="group"
      aria-label="桌面外观预览"
      onDoubleClick={() => {
        setOn(false);
        setPreview(false);
      }}
      title="双击可收起（皮肤继续生效）"
    >
      <span className="nw-skinbar-hint">外观</span>
      {(Object.keys(SKIN_LABEL) as Skin[]).map((k) => (
        <button key={k} type="button" aria-pressed={skin === k} onClick={() => setSkin(k)}>
          {SKIN_LABEL[k]}
        </button>
      ))}
    </div>
  );
}
