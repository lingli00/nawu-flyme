import { GoodsFormSheet } from '../pages/HomePage';
import { SubAddSheet } from '../pages/SubListPage';
import { CooldownSheet, MoodSheet, TimeSheet, WishSheet } from './LifeSheets';
import { Sheet } from './ui/Sheet';
import ManualRecordSheet from '../pages/ManualRecordSheet';
import type { SheetKey } from '../lib/sheetBus';

/**
 * v1.0.28 · 就地弹层宿主：任意页面（加号菜单 / 报表页 chips）直接弹出对应
 * 记录弹层，不再跨路由跳转——「在哪个页面添加，就停留在哪个页面」。
 *
 * ★ v1.1.7：加号菜单的三个记录卡（价值记账 / 手动录入 / 新增订阅）
 * 全部收敛为同一种形态 —— 移动端底部抽屉、桌面右抽屉，
 * 以 embedded 模式嵌进 Sheet，路由页 /record 仍保留，供深链与
 * 页面内其它入口使用。
 *
 * ★ v1.3.1：原「AI 记一笔」弹层整体移除——对话式记录改走全局
 * SmartRecordDock 面板（加号右滑 / 菜单「对话记一笔」卡唤起），
 * 不再有独立 AiPage。
 *
 * 各弹层自带 createPortal 挂 body + useBackGuard 返回键关闭，
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
    /* 价值记账（记一笔） */
    case 'record':
      return (
        <Sheet key={sheetKey} side="bottom" title="记一笔" onClose={onClose} drawerWidth="32rem">
          <ManualRecordSheet embedded onDone={onClose} />
        </Sheet>
      );
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
