import {
  MonitorPlay,
  Tv,
  CirclePlay,
  Clapperboard,
  Music,
  Music2,
  Gamepad2,
  Cloud,
  CloudUpload,
  Server,
  Database,
  CloudCog,
  HardDrive,
  Utensils,
  UtensilsCrossed,
  Coffee,
  Dumbbell,
  Droplet,
  Zap,
  Flame,
  BedDouble,
  Package,
  Truck,
  Smartphone,
  Phone,
  Car,
  CarFront,
  Train,
  Plane,
  Bus,
  Bike,
  ShoppingBag,
  ShoppingCart,
  Store,
  FileText,
  BookOpen,
  GraduationCap,
  Newspaper,
  Laptop,
  Briefcase,
  MessageCircle,
  Mail,
  Crown,
  BadgeCheck,
  Gift,
  Palette,
  CreditCard,
  Puzzle,
  Lightbulb,
  Wrench,
  Repeat,
  Bot,
  Sparkles,
  Brain,
  Wand2,
  ScanLine,
  Keyboard,
  Mouse,
  Usb,
  Landmark,
  Wallet,
  Coins,
  TrendingUp,
  PiggyBank,
  ShieldCheck,
  Percent,
  Receipt,
  HeartPulse,
  Pill,
  Camera,
  Headphones,
  Mic,
  Film,
  Trophy,
  Shirt,
  Gem,
  Flower2,
  Dog,
  Wifi,
  Router,
  Monitor,
  Printer,
  Refrigerator,
  WashingMachine,
  Airplay,
  Lamp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SYSTEM_ICON_MAP } from './systemIcons';

/**
 * 订阅图标库（单色 lucide 线性图标，按真实场景分组；只归 eng-home 维护）。
 *
 * - `SUB_ICON_GROUPS`：IconPicker 分组展示（影音/云服务/生活/出行/购物/办公/通信/会员）。
 * - `SUB_ICON_MAP`：id → 图标（含 v0.6.0 旧 id 兼容别名，不进分组、不在选择器展示）。
 * - `subIconOf(id)`：渲染兜底 —— 旧 id 查得到用旧图标，emoji/未知/空一律回落 Repeat。
 */

/** 图标项（id 存进 Subscription.icon）。 */
export interface SubIconItem {
  id: string;
  icon: LucideIcon;
}

/** 分组（IconPicker 按组渲染小标题 + 网格）。 */
export interface SubIconGroup {
  label: string;
  items: SubIconItem[];
}

export const SUB_ICON_GROUPS: SubIconGroup[] = [
  {
    label: '影音娱乐',
    items: [
      { id: 'bilibili', icon: MonitorPlay },
      { id: 'tv', icon: Tv },
      { id: 'play', icon: CirclePlay },
      { id: 'movie', icon: Clapperboard },
      { id: 'music', icon: Music },
      { id: 'music2', icon: Music2 },
      { id: 'game', icon: Gamepad2 },
      { id: 'palette', icon: Palette },
    ],
  },
  {
    label: '云服务',
    items: [
      { id: 'cloud', icon: Cloud },
      { id: 'cloud-up', icon: CloudUpload },
      { id: 'server', icon: Server },
      { id: 'database', icon: Database },
      { id: 'cloud-cog', icon: CloudCog },
      { id: 'drive', icon: HardDrive },
    ],
  },
  {
    label: '生活服务',
    items: [
      { id: 'food', icon: Utensils },
      { id: 'food2', icon: UtensilsCrossed },
      { id: 'coffee', icon: Coffee },
      { id: 'fitness', icon: Dumbbell },
      { id: 'power', icon: Zap },
      { id: 'water', icon: Droplet },
      { id: 'gas', icon: Flame },
      { id: 'hotel', icon: BedDouble },
      { id: 'express', icon: Package },
      { id: 'truck', icon: Truck },
      { id: 'phone', icon: Smartphone },
      { id: 'tel', icon: Phone },
    ],
  },
  {
    label: '出行',
    items: [
      { id: 'car', icon: Car },
      { id: 'car-front', icon: CarFront },
      { id: 'train', icon: Train },
      { id: 'plane', icon: Plane },
      { id: 'bus', icon: Bus },
      { id: 'bike', icon: Bike },
    ],
  },
  {
    label: '购物',
    items: [
      { id: 'shopping', icon: ShoppingBag },
      { id: 'cart', icon: ShoppingCart },
      { id: 'store', icon: Store },
    ],
  },
  {
    label: '办公学习',
    items: [
      { id: 'doc', icon: FileText },
      { id: 'book', icon: BookOpen },
      { id: 'course', icon: GraduationCap },
      { id: 'news', icon: Newspaper },
      { id: 'laptop', icon: Laptop },
      { id: 'work', icon: Briefcase },
      { id: 'mail', icon: Mail },
    ],
  },
  {
    label: '通信社交',
    items: [
      { id: 'chat', icon: MessageCircle },
      { id: 'phone-bill', icon: Smartphone },
      { id: 'pay', icon: CreditCard },
    ],
  },
  {
    label: '会员权益',
    items: [
      { id: 'crown', icon: Crown },
      { id: 'badge', icon: BadgeCheck },
      { id: 'gift', icon: Gift },
      { id: 'puzzle', icon: Puzzle },
      { id: 'bulb', icon: Lightbulb },
      { id: 'tool', icon: Wrench },
    ],
  },
  {
    label: 'AI 与效率',
    items: [
      { id: 'bot', icon: Bot },
      { id: 'sparkles', icon: Sparkles },
      { id: 'brain', icon: Brain },
      { id: 'wand', icon: Wand2 },
      { id: 'scan', icon: ScanLine },
      { id: 'keyboard', icon: Keyboard },
      { id: 'mouse', icon: Mouse },
      { id: 'usb', icon: Usb },
    ],
  },
  {
    label: '金融保险',
    items: [
      { id: 'bank', icon: Landmark },
      { id: 'wallet', icon: Wallet },
      { id: 'coins', icon: Coins },
      { id: 'trend', icon: TrendingUp },
      { id: 'piggy', icon: PiggyBank },
      { id: 'shield', icon: ShieldCheck },
      { id: 'percent', icon: Percent },
      { id: 'receipt', icon: Receipt },
    ],
  },
  {
    label: '健康与兴趣',
    items: [
      { id: 'heart-pulse', icon: HeartPulse },
      { id: 'pill', icon: Pill },
      { id: 'bike2', icon: Bike },
      { id: 'camera2', icon: Camera },
      { id: 'headphones', icon: Headphones },
      { id: 'mic', icon: Mic },
      { id: 'film', icon: Film },
      { id: 'trophy', icon: Trophy },
      { id: 'shirt', icon: Shirt },
      { id: 'gem', icon: Gem },
      { id: 'flower', icon: Flower2 },
      { id: 'dog', icon: Dog },
    ],
  },
  {
    label: '家居通讯',
    items: [
      { id: 'wifi', icon: Wifi },
      { id: 'router', icon: Router },
      { id: 'tv2', icon: Monitor },
      { id: 'printer', icon: Printer },
      { id: 'fridge', icon: Refrigerator },
      { id: 'washing', icon: WashingMachine },
      { id: 'airplay', icon: Airplay },
      { id: 'lamp', icon: Lamp },
    ],
  },
];

/** id → 图标总表（分组项 + v0.6.0 旧 id 兼容别名）。 */
export const SUB_ICON_MAP: Record<string, LucideIcon> = (() => {
  const map: Record<string, LucideIcon> = {};
  for (const g of SUB_ICON_GROUPS) {
    for (const it of g.items) map[it.id] = it.icon;
  }
  // 旧数据兼容别名（v0.6.0 选择器写入的 id）：不进分组，仅保证渲染不回落
  map.video = Tv;
  map.shopping = ShoppingBag;
  map.gamepad = Gamepad2;
  map.camera = Palette; // 旧 camera 无对应新图标，就近回落
  map.home = BedDouble;
  map.store = Store;
  map.book = BookOpen;
  map.news = Newspaper;
  map.work = Briefcase;
  map.pay = CreditCard;
  map.puzzle = Puzzle;
  map.bulb = Lightbulb;
  map.tool = Wrench;
  return map;
})();

/** 渲染兜底：未知 id / 旧 emoji 数据 / 空 → Repeat。
 *  v1.0.17：先查订阅库，再查物品系统图标库（14 分类 1090 个），都不中才回落。 */
export function subIconOf(id?: string): LucideIcon {
  if (!id) return Repeat;
  return SUB_ICON_MAP[id] ?? SYSTEM_ICON_MAP[id] ?? Repeat;
}
