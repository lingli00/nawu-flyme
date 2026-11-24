#!/usr/bin/env node
/**
 * 构建环境自检（docs/BUILD.md 第一步）。
 *
 * 检查项：Node >= 20 / JDK 21 / ANDROID_HOME / SDK Platform 35 / Build-Tools 35.0.0。
 * 任何一项缺失：打印可复制的下载指引，并以 exit code 1 结束（阻断后续构建）。
 *
 * 用法：node scripts/check-env.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

const C = {
  reset: '\u001b[0m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  gray: '\u001b[90m',
  bold: '\u001b[1m',
};

/** 打印一行带状态前缀的信息。 */
function line(ok, text) {
  const tag = ok === true ? `${C.green}[OK]${C.reset}` : ok === false ? `${C.red}[缺失]${C.reset}` : `${C.yellow}[提示]${C.reset}`;
  console.log(`${tag} ${text}`);
}

/** 运行命令并返回 stdout+stderr（超时 15s，失败返回空串）。 */
function run(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.error) return '';
    return `${r.stdout || ''}${r.stderr || ''}`.trim();
  } catch {
    return '';
  }
}

const problems = [];

// ---------------------------------------------------------------- 1. Node.js
console.log(`\n${C.bold}1) Node.js${C.reset}`);
const nodeVersion = process.versions.node;
const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] ?? '0', 10);
if (nodeMajor >= 20) {
  line(true, `Node.js ${nodeVersion}（要求 >= 20）`);
} else {
  line(false, `Node.js ${nodeVersion} 过低，要求 >= 20`);
  problems.push('Node.js 版本过低：请到 https://nodejs.org/zh-cn/download 安装 LTS（>= 20）');
}

// ------------------------------------------------------------------- 2. JDK
console.log(`\n${C.bold}2) JDK（Capacitor 7 实际要求 21）${C.reset}`);
const javaHome = process.env.JAVA_HOME || '';
const javaBin = javaHome ? join(javaHome, 'bin', platform() === 'win32' ? 'java.exe' : 'java') : 'java';
const javaOut = run(existsSync(javaBin) ? javaBin : 'java', ['-version']);
const versionMatch = /version\s+"?(\d+)/.exec(javaOut);
const javaMajor = versionMatch ? Number.parseInt(versionMatch[1] ?? '0', 10) : 0;

if (javaMajor === 0) {
  line(false, '未检测到 java，或 `java -version` 无法执行');
  problems.push(
    'JDK 21 未安装：请到 https://adoptium.net/temurin/releases/?version=21 下载 JDK 21（Temurin），' +
      '安装后设置环境变量 JAVA_HOME 指向 JDK 目录，并把 %JAVA_HOME%\\bin 加入 PATH',
  );
} else if (javaMajor === 21) {
  line(true, `JDK ${javaMajor}（JAVA_HOME=${javaHome || '未设置，使用 PATH 中的 java'}）`);
} else if (javaMajor === 17) {
  line(false, `检测到 JDK ${javaMajor}：Capacitor 7 的 capacitor-android 按 Java 21 编译（无效的源发行版：21），请升级 JDK 21`);
  problems.push(
    `当前 JDK ${javaMajor}：请安装 JDK 21（https://adoptium.net/temurin/releases/?version=21）` +
      '并把 JAVA_HOME 指向它；多 JDK 共存时 Gradle 只会用 JAVA_HOME 指向的那个',
  );
} else {
  line(false, `JDK ${javaMajor} 不受支持（要求 21）`);
  problems.push(
    `当前 JDK ${javaMajor}：请安装 JDK 21（https://adoptium.net/temurin/releases/?version=21）` +
      '并把 JAVA_HOME 指向它；多 JDK 共存时 Gradle 只会用 JAVA_HOME 指向的那个',
  );
}

// ------------------------------------------------------- 3. Android SDK 路径
console.log(`\n${C.bold}3) Android SDK${C.reset}`);
const candidates = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  join(homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
  join(homedir(), 'Android', 'Sdk'),
  join(homedir(), 'Library', 'Android', 'sdk'),
].filter(Boolean);

const sdkRoot = candidates.find((p) => p && existsSync(p));
if (!sdkRoot) {
  line(false, '未找到 Android SDK（ANDROID_HOME / ANDROID_SDK_ROOT 均未指向有效目录）');
  problems.push(
    'Android SDK 未安装：请先装 Android Studio（https://developer.android.com/studio），' +
      '在 SDK Manager 里安装 "Android SDK Platform 35" 与 "Android SDK Build-Tools 35.0.0"，' +
      '然后设置环境变量 ANDROID_HOME=%LOCALAPPDATA%\\Android\\Sdk',
  );
} else {
  line(true, `Android SDK：${sdkRoot}${process.env.ANDROID_HOME ? '' : '（由默认路径推断，建议显式设置 ANDROID_HOME）'}`);

  // SDK Platform 35
  const platformsDir = join(sdkRoot, 'platforms');
  const platformDirs = existsSync(platformsDir) ? readdirSync(platformsDir) : [];
  if (platformDirs.includes('android-35')) {
    line(true, 'SDK Platform android-35 已安装');
  } else {
    line(false, `SDK Platform android-35 未安装（当前：${platformDirs.join(', ') || '无'}）`);
    problems.push(
      '缺少 SDK Platform 35：Android Studio → Settings → Android SDK → 勾选 "Android 15 (API 35)" 后 Apply；' +
        `或命令行：${join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat')} "platforms;android-35"`,
    );
  }

  // Build-Tools 35.0.0
  const btDir = join(sdkRoot, 'build-tools');
  const btVersions = existsSync(btDir) ? readdirSync(btDir) : [];
  if (btVersions.includes('35.0.0')) {
    line(true, 'Build-Tools 35.0.0 已安装');
  } else {
    line(false, `Build-Tools 35.0.0 未安装（当前：${btVersions.join(', ') || '无'}）`);
    problems.push(
      '缺少 Build-Tools 35.0.0：Android Studio → SDK Manager → SDK Tools → 勾选 "Android SDK Build-Tools 35"；' +
        `或命令行：${join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat')} "build-tools;35.0.0"`,
    );
  }
}

// ------------------------------------------------------------------- 4. 汇总
console.log('');
if (problems.length > 0) {
  console.log(`${C.red}${C.bold}环境自检未通过，共 ${problems.length} 项需要处理：${C.reset}`);
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log(`\n${C.gray}完整说明见 docs/BUILD.md${C.reset}\n`);
  process.exit(1);
}

console.log(`${C.green}${C.bold}环境自检通过，可以执行 scripts\\build-android.bat${C.reset}\n`);
process.exit(0);

// 保持模块可导入（避免某些 Node 版本对未使用 import 的告警）
export const __checkEnvPaths = { sdkRoot: sdkRoot ? resolve(sdkRoot) : null };
