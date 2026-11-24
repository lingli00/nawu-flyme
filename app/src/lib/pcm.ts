/**
 * ★v1.6.0 PCM 重采样（纯函数，独立可测）。
 *
 * 为什么必须有它：vosk-browser 的 `acceptWaveform(AudioBuffer)` 内部只是
 * `acceptWaveformFloat(buffer.getChannelData(0), buffer.sampleRate)`，
 * **整个库里没有任何重采样代码**（实测 `resample` 关键字出现 0 次）。
 * 而中文小模型的采样率固定 16000 —— 直接把 48kHz 的麦克风数据喂进去，
 * 声学特征全部错位，识别结果恒为空，表现就是「录了 7~8 秒，最后说没听清」。
 *
 * 结论：必须在采集侧自己降到 16kHz，再以 16000 调 acceptWaveformFloat。
 */

/** 模型要求的采样率。 */
export const ASR_SAMPLE_RATE = 16000;

/**
 * 线性插值降采样到目标采样率（只做降采样；升采样走最近邻，够用且便宜）。
 *
 * @param input 原始 PCM，取值范围 [-1, 1]
 * @param fromRate 原始采样率（如 44100 / 48000）
 * @param toRate 目标采样率（默认 16000）
 */
export function resamplePcm(
  input: Float32Array,
  fromRate: number,
  toRate: number = ASR_SAMPLE_RATE,
): Float32Array {
  if (!input || input.length === 0) return new Float32Array(0);
  if (!Number.isFinite(fromRate) || fromRate <= 0) return new Float32Array(0);
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);

  if (ratio > 1) {
    // 降采样：线性插值
    for (let i = 0; i < outLen; i += 1) {
      const src = i * ratio;
      const lo = Math.floor(src);
      const hi = Math.min(input.length - 1, lo + 1);
      const t = src - lo;
      out[i] = input[lo]! * (1 - t) + input[hi]! * t;
    }
    return out;
  }

  // 升采样：最近邻（避免插值引入额外延迟；16k→48k 场景极少见）
  for (let i = 0; i < outLen; i += 1) {
    out[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))]!;
  }
  return out;
}

/** 计算一段 PCM 的 RMS 音量（0~1），用于「有没有真的收到声音」的判定。 */
export function rms(pcm: Float32Array): number {
  if (!pcm || pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) sum += pcm[i]! * pcm[i]!;
  return Math.sqrt(sum / pcm.length);
}
