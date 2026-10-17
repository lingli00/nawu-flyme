import type { LucideIcon } from 'lucide-react';
import {
  AirVent,
  Baby,
  Backpack,
  Bath,
  BatteryCharging,
  BedDouble,
  Bike,
  Blender,
  Book,
  BookOpen,
  Boxes,
  Briefcase,
  Brush,
  Bus,
  Calculator,
  Cable,
  Camera,
  Car,
  CarTaxiFront,
  Cast,
  ChefHat,
  CircleDot,
  Cloud,
  Coffee,
  Computer,
  CookingPot,
  Crown,
  CupSoda,
  Diamond,
  DoorOpen,
  Dumbbell,
  Droplets,
  Fan,
  Fish,
  Flame,
  Flower2,
  Footprints,
  Gamepad2,
  Gem,
  Gift,
  GlassWater,
  Glasses,
  GraduationCap,
  Guitar,
  Hammer,
  HardDrive,
  HardHat,
  Hand,
  HatGlasses,
  Headphones,
  Headset,
  HeartPulse,
  Helicopter,
  Home,
  Keyboard,
  Lamp,
  LampDesk,
  Laptop,
  Leaf,
  Link,
  Luggage,
  Map as MapIcon,
  Medal,
  Milk,
  Monitor,
  Microwave,
  Motorbike,
  Mouse,
  Music,
  NotebookPen,
  Package,
  Paperclip,
  PawPrint,
  Pencil,
  PersonStanding,
  Piano,
  Pill,
  Plane,
  Pizza,
  Plug,
  Printer,
  Projector,
  Refrigerator,
  Ribbon,
  Router,
  Ruler,
  Sailboat,
  Scissors,
  Ship,
  Shirt,
  ShoppingBag,
  Smartphone,
  SoapDispenserDroplet,
  Sofa,
  Sparkles,
  Speaker,
  SprayCan,
  Stethoscope,
  Tag,
  Tablet,
  Telescope,
  Tent,
  Tickets,
  Toothbrush,
  TrainFront,
  Trophy,
  Truck,
  Tv,
  Umbrella,
  Usb,
  Utensils,
  Video,
  Volleyball,
  WashingMachine,
  Watch,
  Wind,
  Wrench,
  Zap,
  Shield,
} from 'lucide-react';

/**
 * 物品分类图标库（lucide 极简线性，v0.7.1 扩充至 114 个 / 9 组）。
 *
 * ★数据迁移约定：
 * - 新增/编辑分类时，`Category.icon` 存本库的**图标 id 字符串**（如 'smartphone'）；
 * - 老用户的 `Category.icon` 里是旧的 emoji 字符串——渲染层统一走 `getCategoryIcon()`：
 *   按 id 查 lucide 组件，查不到（旧 emoji / 未知值）回落到 Tag 兜底图标，不报错；
 * - 分类名称展示不受影响。
 *
 * ★v0.7.1 核实说明：每个图标名都对照 lucide-react 1.52.0 实际导出验证过。
 * Sock / Scarf / Belt / Sunglasses / Eyeglasses / Oven 在该版本不存在，
 * 已用语义最近的替代：鞋袜→Footprints、手链丝巾→Ribbon、墨镜→HatGlasses、
 * 眼镜→Glasses、帽子→HardHat、手套→Hand、烤箱类→Microwave/CookingPot。
 */

/** 单个图标定义。 */
export interface CategoryIconDef {
  /** 存入 Category.icon 的 id。 */
  id: string;
  /** 中文名（网格里悬浮/无障碍提示用）。 */
  label: string;
  Icon: LucideIcon;
}

/** 图标分组（挑选效率：分组标题 + 每组一行网格）。 */
export interface CategoryIconGroup {
  group: string;
  icons: CategoryIconDef[];
}

/** 全量分组图标库（114 个，风格统一单色线性）。 */
export const CATEGORY_ICON_GROUPS: CategoryIconGroup[] = [
  {
    group: '数码',
    icons: [
      { id: 'smartphone', label: '手机', Icon: Smartphone },
      { id: 'tablet', label: '平板', Icon: Tablet },
      { id: 'laptop', label: '笔记本', Icon: Laptop },
      { id: 'computer', label: '台式机', Icon: Computer },
      { id: 'monitor', label: '显示器', Icon: Monitor },
      { id: 'keyboard', label: '键盘', Icon: Keyboard },
      { id: 'mouse', label: '鼠标', Icon: Mouse },
      { id: 'headphones', label: '耳机', Icon: Headphones },
      { id: 'headset', label: '耳麦', Icon: Headset },
      { id: 'camera', label: '相机', Icon: Camera },
      { id: 'video', label: '摄像机', Icon: Video },
      { id: 'watch', label: '手表', Icon: Watch },
      { id: 'tv', label: '电视', Icon: Tv },
      { id: 'speaker', label: '音箱', Icon: Speaker },
      { id: 'gamepad', label: '游戏机', Icon: Gamepad2 },
      { id: 'router', label: '路由器', Icon: Router },
      { id: 'harddrive', label: '硬盘', Icon: HardDrive },
      { id: 'usb', label: 'U盘', Icon: Usb },
      { id: 'battery-charging', label: '充电宝', Icon: BatteryCharging },
      { id: 'cable', label: '数据线', Icon: Cable },
      { id: 'plug', label: '插头', Icon: Plug },
      { id: 'cast', label: '投屏', Icon: Cast },
      { id: 'projector', label: '投影仪', Icon: Projector },
    ],
  },
  {
    group: '交通',
    icons: [
      { id: 'car', label: '汽车', Icon: Car },
      { id: 'car-taxi', label: '出租车', Icon: CarTaxiFront },
      { id: 'bus', label: '公交', Icon: Bus },
      { id: 'plane', label: '飞机', Icon: Plane },
      { id: 'helicopter', label: '直升机', Icon: Helicopter },
      { id: 'train', label: '火车', Icon: TrainFront },
      { id: 'bike', label: '自行车', Icon: Bike },
      { id: 'motorbike', label: '摩托车', Icon: Motorbike },
      { id: 'ship', label: '轮船', Icon: Ship },
      { id: 'sailboat', label: '帆船', Icon: Sailboat },
      { id: 'truck', label: '货车', Icon: Truck },
    ],
  },
  {
    group: '家居家电',
    icons: [
      { id: 'home', label: '房屋', Icon: Home },
      { id: 'bed', label: '床', Icon: BedDouble },
      { id: 'sofa', label: '沙发', Icon: Sofa },
      { id: 'door-open', label: '门柜', Icon: DoorOpen },
      { id: 'lamp', label: '落地灯', Icon: Lamp },
      { id: 'lamp-desk', label: '台灯', Icon: LampDesk },
      { id: 'refrigerator', label: '冰箱', Icon: Refrigerator },
      { id: 'washing-machine', label: '洗衣机', Icon: WashingMachine },
      { id: 'air-vent', label: '空调', Icon: AirVent },
      { id: 'microwave', label: '微波炉', Icon: Microwave },
      { id: 'cooking-pot', label: '锅具', Icon: CookingPot },
      { id: 'blender', label: '搅拌机', Icon: Blender },
      { id: 'coffee', label: '咖啡机', Icon: Coffee },
      { id: 'fan', label: '风扇', Icon: Fan },
    ],
  },
  {
    group: '首饰配件',
    icons: [
      { id: 'gem', label: '珠宝', Icon: Gem },
      { id: 'diamond', label: '钻饰', Icon: Diamond },
      { id: 'crown', label: '冠饰', Icon: Crown },
      { id: 'medal', label: '吊坠', Icon: Medal },
      { id: 'ring', label: '戒指', Icon: CircleDot },
      { id: 'necklace', label: '项链', Icon: Link },
      { id: 'ribbon', label: '手链丝巾', Icon: Ribbon },
      { id: 'watch-accessory', label: '腕表配饰', Icon: Watch },
      { id: 'glasses', label: '眼镜', Icon: Glasses },
      { id: 'sunglasses', label: '墨镜', Icon: HatGlasses },
    ],
  },
  {
    group: '运动健康',
    icons: [
      { id: 'dumbbell', label: '健身', Icon: Dumbbell },
      { id: 'footprints', label: '跑鞋鞋袜', Icon: Footprints },
      { id: 'volleyball', label: '球类', Icon: Volleyball },
      { id: 'trophy', label: '竞技奖杯', Icon: Trophy },
      { id: 'person-standing', label: '瑜伽', Icon: PersonStanding },
      { id: 'pill', label: '药品', Icon: Pill },
      { id: 'stethoscope', label: '医疗', Icon: Stethoscope },
      { id: 'heart-pulse', label: '健康', Icon: HeartPulse },
      { id: 'bath', label: '浴具', Icon: Bath },
    ],
  },
  {
    group: '服饰箱包',
    icons: [
      { id: 'shirt', label: '衣服', Icon: Shirt },
      { id: 'hard-hat', label: '帽子', Icon: HardHat },
      { id: 'hand', label: '手套', Icon: Hand },
      { id: 'shopping-bag', label: '包袋', Icon: ShoppingBag },
      { id: 'backpack', label: '背包', Icon: Backpack },
      { id: 'briefcase', label: '公文包', Icon: Briefcase },
      { id: 'luggage', label: '行李箱', Icon: Luggage },
      { id: 'scissors', label: '理发', Icon: Scissors },
      { id: 'umbrella', label: '雨伞', Icon: Umbrella },
    ],
  },
  {
    group: '个护日用',
    icons: [
      { id: 'toothbrush', label: '电动牙刷', Icon: Toothbrush },
      { id: 'soap', label: '洗护', Icon: SoapDispenserDroplet },
      { id: 'wind', label: '吹风机', Icon: Wind },
      { id: 'droplets', label: '加湿器', Icon: Droplets },
      { id: 'flame', label: '香薰', Icon: Flame },
      { id: 'sparkles', label: '香氛', Icon: Sparkles },
      { id: 'spray-can', label: '美妆喷雾', Icon: SprayCan },
      { id: 'brush', label: '化妆刷', Icon: Brush },
      { id: 'package', label: '纸巾日化', Icon: Package },
      { id: 'boxes', label: '收纳', Icon: Boxes },
      { id: 'glass-water', label: '水杯', Icon: GlassWater },
      { id: 'baby', label: '母婴', Icon: Baby },
    ],
  },
  {
    group: '学习办公',
    icons: [
      { id: 'book', label: '书', Icon: Book },
      { id: 'book-open', label: '阅读', Icon: BookOpen },
      { id: 'notebook', label: '笔记', Icon: NotebookPen },
      { id: 'pencil', label: '文具', Icon: Pencil },
      { id: 'calculator', label: '计算器', Icon: Calculator },
      { id: 'printer', label: '打印机', Icon: Printer },
      { id: 'paperclip', label: '回形针', Icon: Paperclip },
      { id: 'ruler', label: '尺子', Icon: Ruler },
      { id: 'graduation-cap', label: '学位帽', Icon: GraduationCap },
      { id: 'telescope', label: '望远镜', Icon: Telescope },
    ],
  },
  {
    group: '通用场景',
    icons: [
      { id: 'utensils', label: '餐饮', Icon: Utensils },
      { id: 'zap', label: '效率', Icon: Zap },
      { id: 'cloud', label: '云服务', Icon: Cloud },
      { id: 'shield', label: '保险', Icon: Shield },
      { id: 'wrench', label: '维修', Icon: Wrench },
      { id: 'bus', label: '公交', Icon: Bus },
      { id: 'home', label: '居住', Icon: Home },
      { id: 'heart-pulse', label: '健康', Icon: HeartPulse },
      { id: 'headphones', label: '娱乐', Icon: Headphones },
      { id: 'gift', label: '人情', Icon: Gift },
      { id: 'headset', label: '通讯', Icon: Headset },
      { id: 'tag', label: '其他', Icon: Tag },
    ],
  },
  {
    group: '兴趣生活',
    icons: [
      { id: 'music', label: '音乐', Icon: Music },
      { id: 'guitar', label: '吉他', Icon: Guitar },
      { id: 'piano', label: '钢琴', Icon: Piano },
      { id: 'tickets', label: '演出', Icon: Tickets },
      { id: 'tent', label: '帐篷', Icon: Tent },
      { id: 'map', label: '旅行', Icon: MapIcon },
      { id: 'fish', label: '水族', Icon: Fish },
      { id: 'paw-print', label: '宠物', Icon: PawPrint },
      { id: 'flower', label: '花卉', Icon: Flower2 },
      { id: 'leaf', label: '植物', Icon: Leaf },
      { id: 'gift', label: '礼品', Icon: Gift },
      { id: 'milk', label: '食品', Icon: Milk },
      { id: 'pizza', label: '零食', Icon: Pizza },
      { id: 'cup-soda', label: '饮品', Icon: CupSoda },
      { id: 'chef-hat', label: '厨具', Icon: ChefHat },
      { id: 'hammer', label: '五金', Icon: Hammer },
    ],
  },
];

/** 旧数据 / 未知 id 的兜底图标。 */
export const FALLBACK_CATEGORY_ICON: LucideIcon = Tag;

/** 全量 id → 组件映射（扁平，供渲染层 O(1) 查询）。 */
const CATEGORY_ICON_MAP: Map<string, LucideIcon> = new Map(
  CATEGORY_ICON_GROUPS.flatMap((g) => g.icons).map((d) => [d.id, d.Icon]),
);

/**
 * 渲染层取分类图标：新数据按 lucide id 查；
 * 旧 emoji 字符串 / 未知值回落 Tag，绝不抛错。
 */
export function getCategoryIcon(id: string | undefined | null): LucideIcon {
  return (id && CATEGORY_ICON_MAP.get(id)) || FALLBACK_CATEGORY_ICON;
}

/** 该值是否为可渲染的已知分类图标 id（v1.0.14 种子迁移用：空值/未知值都要补）。 */
export function isKnownCategoryIcon(id: string | null | undefined): boolean {
  return !!id && CATEGORY_ICON_MAP.has(id);
}
