"""生成小程序版 lib/categoryIcons.ts：lucide id 词表 + emoji 映射。

App 端用 lucide-react 组件渲染图标；小程序没有 DOM 组件体系，
这里把 lucide 图标 id 映射成 emoji（跨平台字体都有，零资源体积）。
id 词表直接从 App 源码提取，保证两端语义一致。
"""
import json
import pathlib
import re

APP = pathlib.Path(r'C:\Users\Administrator\WorkBuddy\纳物\纳物NaWu-纯净包-v1.6.2-20261030\工程\app\src')
OUT = pathlib.Path(r'C:\Users\Administrator\WorkBuddy\纳物\纳物NaWu-纯净包-v1.6.2-20261030\工程\miniprogram\src\core\lib\categoryIcons.ts')

src = (APP / 'lib' / 'categoryIcons.ts').read_text(encoding='utf-8')
# 形如 { id: 'smartphone', label: '手机', Icon: Smartphone } 的条目
pairs = re.findall(r"\{\s*id:\s*'([a-z0-9-]+)',\s*label:\s*'([^']+)'\s*,\s*Icon:\s*\w+\s*\}", src)
ids = sorted({i for i, _ in pairs})
labels = {i: l for i, l in pairs}
print('icon ids:', len(ids))

EMOJI = {
    'smartphone': '📱', 'shirt': '👕', 'sofa': '🛋️', 'spray-can': '🧴', 'cooking-pot': '🍳',
    'volleyball': '🏐', 'car': '🚗', 'refrigerator': '🧊', 'headphones': '🎧', 'laptop': '💻',
    'monitor': '🖥️', 'keyboard': '⌨️', 'gamepad-2': '🎮', 'camera': '📷', 'watch': '⌚',
    'footprints': '👟', 'glasses': '👓', 'book': '📖', 'brush': '🖌️', 'palette': '🎨',
    'guitar': '🎸', 'dumbbell': '🏋️', 'bike': '🚲', 'plane': '✈️', 'train-front': '🚄',
    'baby': '👶', 'dog': '🐶', 'cat': '🐱', 'flower': '🌸', 'gift': '🎁', 'shopping-bag': '🛍️',
    'wallet': '👛', 'utensils': '🍽️', 'coffee': '☕', 'wine': '🍷', 'pill': '💊',
    'heart-pulse': '❤️', 'scissors': '✂️', 'hammer': '🔧', 'plug': '🔌', 'lamp': '💡',
    'printer': '🖨️', 'music': '🎵', 'trophy': '🏆', 'umbrella': '☂️', 'key': '🔑',
    'backpack': '🎒', 'tv': '📺', 'speaker': '🔊', 'mic': '🎤', 'pencil': '✏️',
    'notebook-pen': '📓', 'stethoscope': '🩺', 'sprout': '🌱', 'couch': '🛋️', 'bed': '🛏️',
    'bath': '🛁', 'apple': '🍎', 'croissant': '🥐', 'pizza': '🍕', 'cup-soda': '🥤',
    'sandwich': '🥪', 'candy': '🍬', 'cake': '🍰', 'cookie': '🍪', 'ticket': '🎫',
    'house': '🏠', 'home': '🏠', 'build': '🏢', 'briefcase': '💼', 'graduation-cap': '🎓',
    'shirt-2': '👕', 'palette-2': '🎨', 'cup': '🥤', 'blender': '🥤', 'washing-machine': '🧺',
    'fan': '💨', 'router': '📶', 'battery-charging': '🔋', 'scooter': '🛴', 'yacht': '⛵',
    'tent': '⛺', 'fish': '🐟', 'bird': '🐦', 'rabbit': '🐰', 'leaf': '🍃', 'sun': '☀️',
    'cloud': '☁️', 'zap': '⚡', 'wrench': '🔨', 'pencil-ruler': '📏', 'scissors-line-dashed': '✂️',
    'baby-carriage': '🍼', 'toy-brick': '🧱', 'puzzle': '🧩', 'diamond': '💎', 'ring': '💍',
    'gem': '💎', 'crown': '👑', 'shield': '🛡️', 'scale': '⚖️', 'truck': '🚚',
}
missing = [i for i in ids if i not in EMOJI]
print('未映射（走兜底 📦）:', missing[:60])

emoji_map = {k: v for k, v in EMOJI.items() if v}
lines = [
    '/**',
    ' * 分类图标（小程序版）。',
    ' *',
    ' * App 端用 lucide-react 组件渲染；小程序没有 DOM 组件体系，这里把 lucide id',
    ' * 映射成 **emoji**（跨平台字体都有，零资源体积）。id 词表与 App 端',
    ' * lib/categoryIcons.ts 对齐（由 scripts 工具从源码提取），保证识别器给出的',
    ' * 图标 id 在两端语义一致。',
    ' *',
    ' * ★由 tools 工具生成，勿手改词表；emoji 映射可按需补充。',
    ' */',
    '',
    'export const CATEGORY_ICON_IDS: readonly string[] = ' + json.dumps(sorted(ids), ensure_ascii=False) + ';',
    '',
    '/** lucide id → 中文名（App 端 label，选择器/兜底展示用）。 */',
    'export const CATEGORY_ICON_LABELS: Record<string, string> = ' + json.dumps(labels, ensure_ascii=False) + ';',
    '',
    'const EMOJI_MAP: Record<string, string> = ' + json.dumps(emoji_map, ensure_ascii=False) + ';',
    '',
    '/** lucide id → emoji（未收录的走兜底）。 */',
    'export function categoryEmoji(id: string | null | undefined): string {',
    '  if (!id) return "📦";',
    '  if (EMOJI_MAP[id]) return EMOJI_MAP[id];',
    '  return "📦";',
    '}',
    '',
    '/** 展示名：有 emoji 用 emoji，否则退回中文名（再兜底 📦）。 */',
    'export function categoryIconGlyph(id: string | null | undefined): string {',
    '  if (id && EMOJI_MAP[id]) return EMOJI_MAP[id];',
    '  if (id && CATEGORY_ICON_LABELS[id]) return CATEGORY_ICON_LABELS[id].slice(0, 1);',
    '  return "📦";',
    '}',
    '',
    '/** 该 id 是否是已知的合法图标（与 App 端词表一致）。 */',
    'export function isKnownCategoryIcon(id: string | null | undefined): boolean {',
    '  return typeof id === "string" && CATEGORY_ICON_IDS.includes(id);',
    '}',
    '',
]
OUT.write_text('\n'.join(lines), encoding='utf-8')
print('已生成', OUT)
