import { GoodsFormSheet } from '../pages/HomePage';
import { SubAddSheet } from '../pages/SubListPage';
import { CooldownSheet, MoodSheet, TimeSheet, WishSheet } from './LifeSheets';
import type { SheetKey } from '../lib/sheetBus';

/**
 * v1.0.28 · 就地弹层宿主：任意页面（加号菜单 / 报表页 chips）直接弹出对应
 * 记录弹层，不再跨路由跳转——「在哪个页面添加，就停留在哪个页面」。
 *
 * 六类弹层全部自带 createPortal 挂 body + useBackGuard 返回键关闭，
 * 数据读写走全局 store，因此与宿主页面无关，可安全就地渲染。
 * `key` 保证切换类型时完全重建（不残留上一弹层的状态）。
 */
export default function QuickSheetHost({
  sheetKey,
  onClose,
}: {
  sheetKey: SheetKey;
  onClose: () => void;
}): React.ReactNode {
  switch (sheetKey) {
    case 'goods':
      return <GoodsFormSheet key={sheetKey} onClose={onClose} />;
    case 'sub':
      return <SubAddSheet key={sheetKey} onClose={onClose} />;
    case 'wish':
      return <WishSheet key={sheetKey} onClose={onClose} />;
    case 'cooldown':
      return <CooldownSheet key={sheetKey} onClose={onClose} />;
    case 'mood':
      return <MoodSheet key={sheetKey} onClose={onClose} />;
    case 'time':
      return <TimeSheet key={sheetKey} onClose={onClose} />;
    default:
      return null;
  }
}
