import { splitSentences } from './split';
import { isQueryIntent } from './queryLocal';

/**
 * ★v1.2.2 多任务拆分（用户反馈 4：一条消息问 4 个问题只回 1 句）。
 *
 * 把一条消息拆成有序任务段：
 * - 查询段（昨天买了什么 / 这周最贵的是什么…）→ 逐个本地回答；
 * - 记录段（买了大米花了29…）→ 合并成一段交 parseLocalOnly 逐条弹卡；
 * - 省略追问（「最便宜的呢？」）→ 继承上一个查询段的时间词后独立回答。
 *
 * 纯函数、不碰数据，dock 的 doSend 按段类型分流执行。
 */

export type TaskSegment = { kind: 'query'; text: string } | { kind: 'record'; text: string };

/** 省略追问可继承的时间词（取第一个即可，范围由 queryLocal 解析）。 */
const DATE_WORDS_RE = /(今天|今日|昨天|昨日|前天|大前天|本周|这周|这个星期|上周|上星期|这个月|本月|这月|上月|上个月|最近|这些天|以来|全部|所有|今年|去年|全年)/;

/** 句内二级切分分隔符（逗号/顿号/分号）。 */
const PIECE_SEP = /[，,、；;]/;

/** 记录动词/金额线索：出现即认为不是省略追问。 */
const RECORD_CUE = /[\d０-９]|花了|花费|用了|买了|买|吃|喝|充|记|卖|付|元|块/;

/**
 * 句内二级切分：逗号后是明显追问（带疑问词）时拆成独立段。
 *
 * 「我今天买了大米，这周最贵的是什么」→ ['我今天买了大米', '这周最贵的是什么']
 * 「查一下昨天花了多少，这周呢」     → 保持一整段（后半无独立疑问词）
 */
function splitMixed(sent: string): string[] {
  if (!PIECE_SEP.test(sent)) return [sent];
  const parts = sent
    .split(PIECE_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return parts.length ? [parts[0] as string] : [];
  const out: string[] = [parts[0] as string];
  for (let i = 1; i < parts.length; i += 1) {
    const prev = out[out.length - 1] as string;
    const cur = parts[i] as string;
    if (isQueryIntent(cur) && !isQueryIntent(prev)) out.push(cur);
    else out[out.length - 1] = `${prev}，${cur}`;
  }
  return out;
}

/** 省略追问：短、无金额线索、无记录动词（「最便宜的呢」「心情呢」）。 */
function isElliptical(piece: string): boolean {
  if (piece.length > 12) return false;
  return !RECORD_CUE.test(piece);
}

/**
 * 把一条消息拆成有序任务段（保持原顺序，过滤空段）。
 *
 * @example
 * splitTasks('这周最贵的是什么？最便宜的呢？')
 * // → [{query '这周最贵的是什么'}, {query '这周最便宜的呢'}]
 * splitTasks('今天买了牛奶花了50。查下昨天心情')
 * // → [{record '今天买了牛奶花了50'}, {query '查下昨天心情'}]
 */
export function splitTasks(text: string): TaskSegment[] {
  const out: TaskSegment[] = [];
  for (const sent of splitSentences(text)) {
    for (const piece of splitMixed(sent)) {
      if (isQueryIntent(piece)) {
        out.push({ kind: 'query', text: piece });
      } else if (isElliptical(piece) && out.length > 0 && out[out.length - 1]?.kind === 'query') {
        // 省略追问：继承上一个查询的时间词（「这周…？最便宜的呢？」→「这周最便宜的呢」）
        const prev = out[out.length - 1] as { kind: 'query'; text: string };
        const date = prev.text.match(DATE_WORDS_RE);
        out.push({ kind: 'query', text: date ? `${date[0]}${piece}` : piece });
      } else {
        // 连续记录段合并（交给 parseLocalOnly 内部分句，不在这里猜边界）
        const last = out[out.length - 1];
        if (last && last.kind === 'record') last.text = `${last.text}，${piece}`;
        else out.push({ kind: 'record', text: piece });
      }
    }
  }
  return out;
}
