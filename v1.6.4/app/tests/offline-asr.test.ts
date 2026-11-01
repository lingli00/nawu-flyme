// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASR_ENGINE_PATH,
  ASR_MODEL_MB,
  ASR_MODEL_URL,
  asrModelBytes,
  asrModelReady,
  micAvailable,
} from '../src/lib/offlineAsr';

/**
 * ★v1.4.0 端侧离线语音：只对「不依赖 IndexedDB / 音频」的判断做单测
 * （真实识别链路必须在真机/浏览器实测，见部署记录里的验收清单）。
 */

beforeEach(() => {
  localStorage.clear();
});

describe('模型与引擎配置', () => {
  it('模型托管在自有服务器（v1.6.4 起：自己正在运行的服务端站点根），且是单一接口（带 CORS）', () => {
    // 旧公共主机 106.53.204.29 已下线，模型下载随之失效 —— 改指站点根
    expect(ASR_MODEL_URL).toBe('https://your.domain.com/asr-model.php');
    expect(ASR_MODEL_URL).not.toContain('cdn');
    expect(ASR_MODEL_URL).not.toContain('106.53.204.29');
    // 必须走 https：站点 80 端口对全部请求 301
    expect(ASR_MODEL_URL.startsWith('https://')).toBe(true);
  });

  it('引擎随包分发（不依赖外网 CDN）', () => {
    expect(ASR_ENGINE_PATH).toBe('/vosk/vosk.js');
  });

  it('模型体积提示不超过 50MB 约束', () => {
    expect(ASR_MODEL_MB).toBeLessThanOrEqual(45);
  });
});

describe('模型状态', () => {
  it('没下过模型 → 未就绪（不会误判为可用）', async () => {
    await expect(asrModelReady()).resolves.toBe(false);
  });

  it('只有标记没有数据 → 仍然未就绪', async () => {
    localStorage.setItem('nawu-asr-model-v1', 'ok');
    await expect(asrModelReady()).resolves.toBe(false);
  });

  it('模型大小未知时返回 0', () => {
    expect(asrModelBytes()).toBe(0);
  });
});

describe('麦克风能力探测', () => {
  it('jsdom 下没有 getUserMedia → 认为不可用（走兜底提示）', () => {
    expect(micAvailable()).toBe(false);
  });
});
