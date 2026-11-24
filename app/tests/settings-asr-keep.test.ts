// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../src/store';
import { createDefaultSettings } from '../src/storage/seed';
import { setDriver } from '../src/storage/kv';
import { asrResidentStatus, releaseAsrModel } from '../src/lib/offlineAsr';

/**
 * ★v1.6.1 「语音模型常驻内存」开关：
 * - 默认必须关闭（省内存是默认行为）；
 * - 开关可持久化，冷启动读回；
 * - 常驻状态与释放接口可安全调用（未加载时释放是 no-op）。
 */

beforeEach(() => {
  const map = new Map<string, string>();
  setDriver({
    name: 'memory',
    async get(k) {
      return map.has(k) ? (map.get(k) as string) : null;
    },
    async set(k, v) {
      map.set(k, v);
    },
    async remove(k) {
      map.delete(k);
    },
  });
});

describe('语音模型常驻开关', () => {
  it('默认关闭（不额外占内存）', () => {
    expect(createDefaultSettings().asrKeepModel).toBe(false);
  });

  it('可以开启并持久化，load 后仍是开启', async () => {
    useSettingsStore.setState({ settings: createDefaultSettings(), loaded: true });
    await useSettingsStore.getState().update({ asrKeepModel: true });
    expect(useSettingsStore.getState().settings.asrKeepModel).toBe(true);

    // 模拟冷启动：重置内存态后重新 load
    useSettingsStore.setState({ settings: createDefaultSettings(), loaded: false });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings.asrKeepModel).toBe(true);
  });

  it('旧备份/旧设置里没有该字段时，回落为关闭', async () => {
    const legacy = { ...createDefaultSettings() } as Record<string, unknown>;
    delete legacy.asrKeepModel;
    useSettingsStore.setState({ settings: legacy as never, loaded: true });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings.asrKeepModel).toBe(false);
  });
});

describe('常驻状态接口', () => {
  it('未加载模型时状态为 false，释放是安全的空操作', () => {
    expect(asrResidentStatus()).toBe(false);
    expect(() => releaseAsrModel()).not.toThrow();
    expect(asrResidentStatus()).toBe(false);
  });
});
