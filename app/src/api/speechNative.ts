import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

/**
 * ★v1.3.6 端侧语音识别原生插件封装（android/.../NawuSpeechPlugin.java）。
 *
 * 与 ApkUpdate 同一套写法：网页端拿到的是会抛错的代理，调用方必须先用
 * `isNativeApp()` / `probeSpeech().mode === 'native'` 分流。
 */

export interface NawuSpeechAvailability {
  supported: boolean;
  /** 系统是否提供**纯离线**识别器（Android 12+ 的 on-device 引擎）。 */
  onDevice: boolean;
  engine: string;
  permission?: string;
}

export interface NawuSpeechApi {
  isAvailable(): Promise<NawuSpeechAvailability>;
  start(options: { lang?: string }): Promise<{ onDevice: boolean }>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  addListener(
    event: 'partial' | 'result' | 'error' | 'end',
    handler: (data: { text?: string; code?: string; message?: string; reason?: string; onDevice?: boolean }) => void,
  ): Promise<PluginListenerHandle>;
}

const NawuSpeech = registerPlugin<NawuSpeechApi>('NawuSpeech');

export default NawuSpeech;
