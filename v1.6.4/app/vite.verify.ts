import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 验证用开发服务器配置（不进生产、不参与构建）：
 * - 缓存目录单独一套，避开 `node_modules/.vite` 里已被占用/受保护的旧产物；
 * - 端口 5178，代理指向线上 2233（要真实数据才能看出天气/滑页的真实表现）。
 */
export default defineConfig(() => ({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:2233',
        changeOrigin: true,
        secure: false,
        ws: false,
      },
    },
  },
  cacheDir: 'node_modules/.vite-verify',
}));
