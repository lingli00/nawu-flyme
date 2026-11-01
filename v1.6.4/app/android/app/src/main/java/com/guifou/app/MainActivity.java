package com.guifou.app;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import com.getcapacitor.BridgeActivity;

/**
 * ★v1.1.2：注册 ApkUpdatePlugin（应用内更新插件）。
 *
 * 根因（v1.0.36~v1.1.1 通杀）：ApkUpdatePlugin 是 app 本地类，
 * capacitor.plugins.json 只自动加载 node_modules 里的包插件，本地类必须手动注册。
 * 漏注册时 JS 调 ApkUpdate.canInstall() 会被桥接层直接拒绝 → 前端 catch 后提示
 * 「当前环境不支持应用内更新」——即使用户装的是原生 App 也一样，补丁/全量/安装器
 * 整条链全断。表现为：设置页能看到新版本卡片，点「立即更新」就报错。
 *
 * 时序：registerPlugin 必须在 super.onCreate() 之前——Bridge 在
 * BridgeActivity.onCreate→load() 里创建，晚于它的注册会被丢弃。
 *
 * ★v1.0.35：onResume 里修复「键盘页退出 → 后台切回 → 底部大留白」。
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
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(ApkUpdatePlugin.class);
    // ★v1.3.6：端侧语音识别插件（NawuSpeech）。同样是 app 本地类，
    // 必须在 super.onCreate() 之前注册，否则 Bridge 建好后不会再收 ——
    // 前端会拿到「插件不存在」，语音输入直接不可用。
    registerPlugin(NawuSpeechPlugin.class);
    super.onCreate(savedInstanceState);
  }

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
