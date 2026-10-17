import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * v1.1.2 回归：ApkUpdatePlugin 必须在 MainActivity 里手动注册。
 *
 * 背景：ApkUpdatePlugin 是 app 本地类（android/.../ApkUpdatePlugin.java），
 * capacitor.plugins.json 只自动加载 node_modules 包插件，本地类必须手动
 * registerPlugin。v1.0.36~v1.1.1 三个版本都漏了注册，且从未在真机上跑通过
 * 应用内更新（官方频道 URL bug 掩盖了它）——用户点「立即更新」直接报
 * 「当前环境不支持应用内更新」，补丁/全量/安装器整条链全断。
 *
 * 注册还有时序要求：registerPlugin 必须在 super.onCreate() 之前
 * （Bridge 在 BridgeActivity.onCreate→load() 里创建，晚了会被丢弃）。
 */

const mainActivityPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'guifou',
  'app',
  'MainActivity.java',
);

const mainActivity = readFileSync(mainActivityPath, 'utf8');

/** 去掉 Java 块注释/行注释，避免注释里提到的 API 名干扰代码顺序断言。 */
function stripJavaComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const mainActivityCode = stripJavaComments(mainActivity);

describe('ApkUpdatePlugin 注册（v1.1.2 回归）', () => {
  it('MainActivity 必须 registerPlugin(ApkUpdatePlugin.class)', () => {
    expect(mainActivityCode).toContain('registerPlugin(ApkUpdatePlugin.class)');
  });

  it('注册必须发生在 super.onCreate() 之前（晚了会被 Bridge 丢弃）', () => {
    const regIdx = mainActivityCode.indexOf('registerPlugin(ApkUpdatePlugin.class)');
    const superIdx = mainActivityCode.indexOf('super.onCreate(');
    expect(regIdx).toBeGreaterThan(-1);
    expect(superIdx).toBeGreaterThan(-1);
    expect(regIdx).toBeLessThan(superIdx);
  });

  it('onCreate 重写存在且带上 Bundle 参数', () => {
    expect(mainActivityCode).toMatch(/public\s+void\s+onCreate\s*\(\s*Bundle\s+\w+\s*\)/);
  });
});
