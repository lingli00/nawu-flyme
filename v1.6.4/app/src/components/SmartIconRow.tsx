import { useEffect, useMemo, useState } from 'react';
import IconPicker, { IconPreview, iconBaseOf, type Tab } from './IconPicker';
import { topSuggestion, type SuggestKind } from '../lib/iconSuggest';

/**
 * ★v1.3.0 智能图标行（用户需求：物品/订阅/生活流条目「自动匹配图标」）。
 *
 * 交互（按用户原话实现）：
 * - 「订阅类优先读取系统本地缓存的 APP 图标」→ 推荐链首位是随包品牌资产
 *   （public/brand-icons/，含 B 站等 177 个，离线可用）；
 * - 「无本地图标时根据关键词联网检索图片自动推荐」→ 品牌库/glyph/代理链兜底；
 * - 「弹出卡片默认展示推荐图，满意直接确认保存」→ 名称一出且用户没选过，
 *   自动采纳推荐值（保存即带走，零操作）；
 * - 「不满意，一键跳转图片选择页更换」→ 点「更换」直接跳到 IconPicker 的
 *   网络图片 tab（可搜图/上传），并撤掉「已匹配」徽标。
 *
 * 铁律：本组件只管「推荐 + 采纳/更换」交互，图标存取三形态与宿主字段原样
 * （订阅 icon 字符串 / 物品经 goodsIcon 转换），不发明新存储。
 */
export default function SmartIconRow({
  name,
  value,
  onChange,
  kind,
  categoryIcon,
}: {
  /** 条目名（订阅名/物品名）——推荐的关键词来源。 */
  name: string;
  /** 当前 icon 值（三形态字符串）。 */
  value: string;
  onChange: (v: string) => void;
  kind: SuggestKind;
  /** 分类默认 lucide id（推荐链兜底）。 */
  categoryIcon?: string;
}): React.ReactNode {
  const base = useMemo(iconBaseOf, []);
  /** 自动采纳记录（value + 来源标签）；用户手动选过 → null。 */
  const [matched, setMatched] = useState<{ value: string; label: string } | null>(null);
  /** 「更换」后把 IconPicker 重挂载并直落网络图片 tab。 */
  const [pickerTab, setPickerTab] = useState<Tab>('lib');
  const [pickerKey, setPickerKey] = useState(0);

  const kw = name.trim();
  useEffect(() => {
    // 已手动选过（matched 被撤/值非自动采纳）→ 永不自动覆盖
    if (value) return;
    if (kw.length < 2) return;
    const top = topSuggestion(kw, { kind, base, categoryIcon });
    if (!top) return;
    onChange(top.value);
    setMatched({ value: top.value, label: top.label });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw]);

  /** 「更换」：撤徽标 + 一键跳网络图片 tab（搜图/上传都在这）。 */
  const onChangeTap = (): void => {
    setMatched(null);
    setPickerTab('web');
    setPickerKey((k) => k + 1);
  };

  const showBadge = !!matched && value === matched.value;

  return (
    <div>
      <div className="flex items-center gap-2">
        {value ? (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-2">
            <IconPreview icon={value} size={24} />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          {showBadge ? (
            <p className="flex items-center gap-1.5 text-[11px] leading-4 text-ink-3">
              <span className="shrink-0">✨ 已智能匹配 · {matched!.label}</span>
              <button
                type="button"
                onClick={onChangeTap}
                className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] text-accent active:scale-95"
              >
                更换
              </button>
            </p>
          ) : (
            <p className="text-[11px] leading-4 text-ink-3">
              {kw.length >= 2 ? '输入名称自动匹配图标，也可在下方手动选择' : '在下方选择图标'}
            </p>
          )}
        </div>
      </div>
      <div className="mt-1.5">
        <IconPicker key={pickerKey} value={value} onChange={onChange} initialTab={pickerTab} />
      </div>
    </div>
  );
}
