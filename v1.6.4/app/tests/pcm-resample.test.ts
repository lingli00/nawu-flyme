// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ASR_SAMPLE_RATE, resamplePcm, rms } from '../src/lib/pcm';

/**
 * ★v1.6.0 采样率修复的回归：
 * vosk-browser 内部**不重采样**（库内 resample 关键字出现 0 次），
 * 模型固定 16kHz —— 必须我们自己把 44.1k/48k 降到 16k，否则识别结果恒为空。
 */

describe('resamplePcm（降到 16k）', () => {
  it('48k → 16k：长度按 1/3 缩减', () => {
    const src = new Float32Array(4800);
    const out = resamplePcm(src, 48000, ASR_SAMPLE_RATE);
    expect(out.length).toBe(1600);
  });

  it('44.1k → 16k：长度按比例缩减（允许 1 个误差）', () => {
    const out = resamplePcm(new Float32Array(4410), 44100, ASR_SAMPLE_RATE);
    expect(Math.abs(out.length - 1600)).toBeLessThanOrEqual(1);
  });

  it('已是 16k → 原样返回（不复制、不改值）', () => {
    const src = new Float32Array([0.1, -0.2, 0.3]);
    expect(resamplePcm(src, 16000, ASR_SAMPLE_RATE)).toBe(src);
  });

  it('输入为空 / 非法采样率 → 空数组（不抛异常）', () => {
    expect(resamplePcm(new Float32Array(0), 48000).length).toBe(0);
    expect(resamplePcm(new Float32Array(10), 0).length).toBe(0);
    expect(resamplePcm(new Float32Array(10), NaN).length).toBe(0);
  });

  it('正弦波降采样后仍是正弦（峰值保持、不过零衰减）', () => {
    const n = 4800;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i += 1) src[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    const out = resamplePcm(src, 48000, 16000);
    let peak = 0;
    for (let i = 0; i < out.length; i += 1) peak = Math.max(peak, Math.abs(out[i]!));
    expect(peak).toBeGreaterThan(0.9);
    expect(rms(out)).toBeGreaterThan(0.5);
  });
});

describe('rms 音量', () => {
  it('静音为 0', () => {
    expect(rms(new Float32Array(100))).toBe(0);
  });

  it('有声音时大于 0', () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5]))).toBeCloseTo(0.5, 5);
  });
});
