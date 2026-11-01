/**
 * 分句。
 *
 * 一句话里常常包含多笔（「吃了油条花了30然后坐大巴花了60去桐柏」），
 * 分句质量直接决定解析条数，因此这里比 Web 版多切一类**顺接连词**。
 *
 * ★标点容错（真机语音输入场景）：
 * - 手机输入法/语音转写会在句尾自动加「。」、句中加「，」；
 * - 句末标点一律剥掉，绝不能让「花了30。」解析失败；
 * - 逗号**只在前后两段都自带金额线索时才拆**——「早饭12元，大巴30元」拆两笔，
 *   但「买了华为手机，花了3999」保持一句（拆开会让物品丢金额、金额丢名字）。
 */

/** 句末标点。 */
const SPLIT_PUNCT = /[。；;\n！!？?]+/;

/** 顺接连词（后面大概率跟着另一笔）：然后 / 接着 / 随后 / 之后 / 另外 / 还有 / 紧接着 / 接下来。 */
const SPLIT_CONJ = /(?:，|,)?\s*(?:然后|接着|随后|之后|另外|还有|紧接着|接下来|再|顺便)\s*/;

/** 中文逗号后紧跟新的时间词，视为新句。 */
const SPLIT_COMMA_TIME = /[，,]\s*(?=今天|昨天|前天|刚才|刚刚|早上|中午|晚上|下午)/;

/** 逗号拆分（普通逗号）。 */
const COMMA_RE = /[，,、]/;

/**
 * 金额线索：阿拉伯/全角数字、「元/块/¥」、花钱动词、中文数字+钱单位。
 * 用于判断一段话能否独立成「一笔账」。
 */
function hasAmountCue(s: string): boolean {
  if (/[\d０-９]/.test(s)) return true;
  if (/[元块￥¥]/.test(s)) return true;
  return /花了|花费|用了|一共|总共|付了|实付|付款|充值|卖了几|卖了/.test(s);
}

/** 去掉一段话首尾的标点与空白（含引号、破折号等）。 */
function stripEdgePunct(s: string): string {
  return s
    .replace(/^[，,、。．；;！!？? \t　「」『』""''\-—~～]+/, '')
    .replace(/[，,、。．；;！!？? \t　「」『』""''\-—~～]+$/, '')
    .trim();
}

/**
 * 把整段话切成若干分句（保持原顺序，去掉空句）。
 *
 * @example
 * splitSentences('今天早上吃了油条包子花了30然后坐大巴花了60去桐柏')
 * // → ['今天早上吃了油条包子花了30', '坐大巴花了60去桐柏']
 */
export function splitSentences(text: string): string[] {
  const raw = (text ?? '').trim();
  if (!raw) return [];

  // 1) 先按句末标点切（剥掉每段首尾残余标点）
  const byPunct = raw
    .split(SPLIT_PUNCT)
    .map(stripEdgePunct)
    .filter(Boolean);

  const out: string[] = [];
  for (const chunk of byPunct) {
    // 2) 再按「逗号 + 时间词」切
    const byTime = chunk.split(SPLIT_COMMA_TIME).map(stripEdgePunct).filter(Boolean);
    for (const piece of byTime) {
      // 3) 按顺接连词切
      const byConj = piece.split(SPLIT_CONJ).map(stripEdgePunct).filter(Boolean);
      // 4) 普通逗号：前后两段都有金额线索才拆（见文件头说明）
      for (const seg of byConj) {
        out.push(...splitCommaIfBothCost(seg));
      }
    }
  }

  return out.filter((s) => s.length > 0);
}

/** 逗号拆分：仅当「当前累计段」与「下一段」都有金额线索时在此断开。 */
function splitCommaIfBothCost(chunk: string): string[] {
  if (!COMMA_RE.test(chunk)) return chunk.trim() ? [chunk.trim()] : [];
  const segs = chunk.split(COMMA_RE).map(stripEdgePunct).filter(Boolean);
  if (segs.length < 2) return segs.length ? [segs[0] as string] : [];

  const out: string[] = [];
  let buf = segs[0] as string;
  for (let i = 1; i < segs.length; i += 1) {
    const next = segs[i] as string;
    if (hasAmountCue(buf) && hasAmountCue(next)) {
      out.push(buf);
      buf = next;
    } else {
      buf = `${buf}，${next}`;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** 给分句编号（AI 提示词用）：`1) xxx\n2) yyy`。 */
export function numberSentences(sentences: string[]): string {
  return sentences.map((s, i) => `${i + 1}) ${s}`).join('\n');
}
