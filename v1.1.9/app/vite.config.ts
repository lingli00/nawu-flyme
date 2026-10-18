import { mkdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * 把 Node 的临时目录指向项目内。
 * 部分受限环境（写系统 Temp 会 EPERM）会导致 vitest 随机丢失测试文件，
 * 这里统一改到 `node_modules/.tmp`，保证 `npm test` 稳定。
 */
const localTmp = fileURLToPath(new URL('./node_modules/.tmp', import.meta.url));
try {
  mkdirSync(localTmp, { recursive: true });
  process.env.TEMP = localTmp;
  process.env.TMP = localTmp;
  process.env.TMPDIR = localTmp;
} catch {
  // 改不了就用系统默认临时目录，不影响构建
}

/**
 * Vite 配置。
 *
 * 关键点：
 * 1. `base: './'` —— Capacitor 以 `https://localhost`（或 file）加载静态资源，必须相对路径。
 * 2. `server.proxy['/api']` —— 浏览器 dev 环境唯一的跨域解法（后端零 CORS，见架构 §6.1）。
 *    浏览器侧请求的是 `http://localhost:5173/api/...`（同源），由 Vite 转发到 PHP，
 *    因此**不会触发预检**，天然绕开后端 `OPTIONS → 404` 的问题。
 *    代理目标由 `.env.local` 的 `VITE_DEV_PROXY_TARGET` 指定，默认 `http://192.168.1.100:3030`。
 * 3. 真机（Capacitor）不需要代理：请求走原生 `CapacitorHttp`，不受同源策略限制。
 */
export default defineConfig(() => {
  const proxyTarget = process.env.VITE_DEV_PROXY_TARGET || 'http://192.168.1.100:3030';

  return {
    base: './',
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: true,
      port: 5173,
      strictPort: false,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
          ws: false,
        },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      target: 'es2020',
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
    },
    // 把构建/依赖缓存放在项目内，避免写系统临时目录（部分受限环境会 EPERM）
    cacheDir: 'node_modules/.vite',
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      globals: false,
      // 依赖预构建产物也放项目内（部分受限环境写系统临时目录会 EPERM）
      cacheDir: 'node_modules/.vitest',
      // 串行跑测试文件：Windows 上多 worker 并发写同一个缓存文件会 EPERM
      fileParallelism: false,
    },
  };
});
