import { createWorker, type Worker } from 'tesseract.js';

/**
 * 本地 OCR（v1.0.11）：未配置 AI 时的识图回退——Tesseract.js 纯本地算力。
 *
 * - 资源全部打包进 App（public/tess + public/tessdata），离线可用：
 *   · /tess/worker.min.js + tesseract-core(-simd)-lstm.wasm(.js)（默认 OEM=LSTM 只需这两个 core）
 *   · /tessdata/chi_sim.traineddata（tessdata_fast 中文简体，~2.4MB）
 * - 识别出的**文本**交回 parseLocalOnly 本地规则解析（金额/分类/归需否），
 *   OCR 不做结构化——那是规则解析器的职责。
 * - worker 全局单例：首次调用懒加载（wasm + 语言包初始化 ~1-2s），之后秒级。
 */

let workerPromise: Promise<Worker> | null = null;

function assetBase(): string {
  // 浏览器 = 当前站点 origin；App（Capacitor https://localhost）= 同源
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const base = assetBase();
    workerPromise = createWorker('chi_sim', 1, {
      workerPath: `${base}/tess/worker.min.js`,
      corePath: `${base}/tess/`,
      langPath: `${base}/tessdata`,
      gzip: false,
      // 静默：进度由 UI 的 busy 态表达，不打日志
      logger: () => {
        /* noop */
      },
      errorHandler: () => {
        /* 交给调用方兜底 */
      },
    });
  }
  return workerPromise;
}

/** 识别图片中的中文/数字文本（失败返回空串，不抛错——调用方走提示兜底）。 */
export async function ocrText(dataUrl: string): Promise<string> {
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(dataUrl);
    return (data?.text ?? '').replace(/\s+/g, ' ').trim();
  } catch (e) {
    // wasm/语言包加载失败等：静默降级为「识别不出」
    console.warn('[localOcr] failed', e);
    return '';
  }
}

/** 预热（可选）：进 AI 页时提前初始化 worker，用户点识图时省 1-2s。 */
export function warmUpOcr(): void {
  void getWorker().catch(() => {
    /* 预热失败静默，首次使用时再试 */
  });
}
