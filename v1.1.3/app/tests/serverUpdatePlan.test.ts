import { describe, expect, it } from 'vitest';
import { isBuildAsset, isProtectedPath, planDiff, safeRelPath, summarize } from '../src/lib/serverUpdatePlan';
import type { FileMap } from '../src/lib/serverUpdatePlan';

/** 64 位假 sha256（只用于规则测试，不追求真实哈希）。 */
const sha = (c: string): string => c.repeat(64);

describe('safeRelPath', () => {
  it('接受合法相对路径', () => {
    expect(safeRelPath('app/Api.php')).toBe(true);
    expect(safeRelPath('assets/index-abc123.js')).toBe(true);
    expect(safeRelPath('index.php')).toBe(true);
  });

  it('拒绝绝对路径 / .. / 双斜杠 / 非法字符', () => {
    expect(safeRelPath('/etc/passwd')).toBe(false);
    expect(safeRelPath('../x')).toBe(false);
    expect(safeRelPath('a//b')).toBe(false);
    expect(safeRelPath('a b.txt')).toBe(false);
    expect(safeRelPath('')).toBe(false);
  });
});

describe('isProtectedPath', () => {
  it('保护名单内的路径', () => {
    expect(isProtectedPath('storage/config.php')).toBe(true);
    expect(isProtectedPath('.user.ini')).toBe(true);
    expect(isProtectedPath('install.php')).toBe(true);
    expect(isProtectedPath('brand-icons/a.svg')).toBe(true);
    expect(isProtectedPath('tessdata/chi.traineddata')).toBe(true);
    expect(isProtectedPath('tess/README.md')).toBe(true);
  });

  it('保护名单外的路径', () => {
    expect(isProtectedPath('index.php')).toBe(false);
    expect(isProtectedPath('assets/index-x.js')).toBe(false);
    expect(isProtectedPath('app/Api.php')).toBe(false);
    expect(isProtectedPath('logo.svg')).toBe(false);
  });
});

describe('isBuildAsset', () => {
  it('assets 下的白名单扩展名', () => {
    expect(isBuildAsset('assets/index-AbC123.js')).toBe(true);
    expect(isBuildAsset('assets/style-x9f8.css')).toBe(true);
    expect(isBuildAsset('assets/font.woff2')).toBe(true);
  });

  it('assets 之外或非构建扩展名', () => {
    expect(isBuildAsset('app/Api.php')).toBe(false);
    expect(isBuildAsset('assets/sub/dir.js')).toBe(false); // assets 无子目录
    expect(isBuildAsset('brand-icons/x.js')).toBe(false);
  });
});

describe('planDiff', () => {
  const local: FileMap = {
    'index.php': { sha256: sha('a'), size: 1 },
    'assets/index-old.js': { sha256: sha('b'), size: 2 },
    'assets/index-new.js': { sha256: sha('c'), size: 3 },
    'app/Api.php': { sha256: sha('d'), size: 4 },
    'app/lib/Old.php': { sha256: sha('e'), size: 5 },
    'app/lib/New.php': { sha256: sha('f'), size: 6 },
    'app/lib/UserAdded.php': { sha256: sha('i'), size: 9 },
    '.user.ini': { sha256: sha('g'), size: 7 },
    'storage/config.php': { sha256: sha('h'), size: 8 },
  };
  const remote: FileMap = {
    'index.php': { sha256: sha('A'), size: 1 }, // 更新
    'assets/index-new.js': { sha256: sha('c'), size: 3 }, // 不变
    'assets/index-fresh.js': { sha256: sha('F'), size: 10 }, // 新增
    'app/Api.php': { sha256: sha('D'), size: 4 }, // 更新
    'app/lib/New.php': { sha256: sha('f'), size: 6 }, // 不变
  };
  const applied: FileMap = {
    'index.php': { sha256: sha('a'), size: 1 },
    'assets/index-old.js': { sha256: sha('b'), size: 2 },
    'app/lib/Old.php': { sha256: sha('e'), size: 5 },
  };

  it('正确分类新增 / 更新 / 删除 / 保留', () => {
    const d = planDiff(local, remote, applied);
    expect(d.added).toEqual(['assets/index-fresh.js']);
    expect(d.updated).toEqual(['app/Api.php', 'index.php']);
    expect(d.deleted).toEqual(['app/lib/Old.php', 'assets/index-old.js']);
    expect(d.kept).toEqual(['.user.ini', 'app/lib/UserAdded.php', 'storage/config.php']);
    expect(summarize(d)).toEqual({ added: 1, updated: 2, deleted: 2, kept: 3 });
  });

  it('首次更新（无 applied 记录）只删构建产物，其余一律保留', () => {
    const d = planDiff(local, remote, null);
    expect(d.deleted).toEqual(['assets/index-old.js']);
    expect(d.kept).toContain('app/lib/Old.php');
    expect(summarize(d)).toEqual({ added: 1, updated: 2, deleted: 1, kept: 4 });
  });

  it('根目录下的未托管文件永不删', () => {
    const d = planDiff({ 'random.txt': { sha256: sha('z'), size: 1 } }, remote, applied);
    expect(d.kept).toContain('random.txt');
    expect(d.deleted).not.toContain('random.txt');
  });

  it('保护目录里的文件即使不在新 manifest 也保留', () => {
    const d = planDiff(
      {
        'storage/config.php': { sha256: sha('h'), size: 8 },
        'brand-icons/old.svg': { sha256: sha('j'), size: 8 },
      },
      remote,
      applied,
    );
    expect(d.deleted).toEqual([]);
    expect(d.kept.length).toBe(2);
  });
});
