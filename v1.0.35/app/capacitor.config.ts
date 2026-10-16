import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置。
 *
 * ★R1 提醒：页面内所有业务请求走 `src/net/httpClient.ts` 的 CapacitorHttp（原生层），
 * 因此后端「零 CORS」不影响真机；但 `AndroidManifest.xml` 必须开明文 HTTP，
 * 否则内网 `http://192.168.1.100:3030` 一定连不上（见 `docs/BUILD.md`）。
 */
const config: CapacitorConfig = {
  appId: 'com.guifou.app',
  appName: '纳物',
  webDir: 'dist',
  android: {
    // Capacitor 7 默认 androidScheme 为 https，页面源是 https://localhost
    allowMixedContent: true,
    captureInput: true,
    webContentsDebuggingEnabled: false, // 发布版务必 false
    // ★v1.0.21：Android 15 强制 edge-to-edge（WebView 延伸到状态栏/手势条下），
    // 'auto' = 检测到强制 e2e 时给 WebView 加原生 margin 避开系统栏——
    // 修复「页面顶部超出到状态栏」；低版本不受影响（overlay:false 已占位）。
    adjustMarginsForEdgeToEdge: 'auto',
  },
  plugins: {
    Keyboard: {
      resizeOnFullScreen: true,
      resize: 'body',
    },
  },
};

export default config;
