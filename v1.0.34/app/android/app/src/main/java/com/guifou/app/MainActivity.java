package com.guifou.app;

import android.view.View;
import android.view.ViewGroup;
import com.getcapacitor.BridgeActivity;

/**
 * ★v1.0.35：修复「键盘页退出 → 后台切回 → 底部大留白」。
 *
 * 根因：@capacitor/keyboard 开启 resizeOnFullScreen 后，Keyboard.java 里
 * AndroidBug5497Workaround 会把 WebView（content 的子 View）高度写成
 * 键盘弹出时的可用像素值；在后台/前台切换过程中 insets 状态变化可能把
 * 高度写死成收窄值，而回前台后不再有 insets 动画回调，高度永远不会恢复
 * ——表现为页面内容只占上半屏、底部导航悬空、下面一整块空白。
 *
 * 修复：每次回到前台时，若发现该子 View 高度是具体像素（>0），
 * 强制恢复 MATCH_PARENT 并触发布局。JS 侧 useKeyboardResumeFix 兜底，
 * 双保险。
 */
public class MainActivity extends BridgeActivity {
  @Override
  public void onResume() {
    super.onResume();
    ViewGroup content = (ViewGroup) findViewById(android.R.id.content);
    if (content != null && content.getChildCount() > 0) {
      View child = content.getChildAt(0);
      ViewGroup.LayoutParams lp = child.getLayoutParams();
      if (lp != null && lp.height > 0) {
        lp.height = ViewGroup.LayoutParams.MATCH_PARENT;
        child.requestLayout();
      }
    }
  }
}
