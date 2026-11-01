import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, ImagePlus, Keyboard, Mic, Pencil, Send, X } from 'lucide-react';
import { useBackGuard } from '../../lib/backGuard';
import { copyText } from '../../lib/clipboard';
import { today as todayStr } from '../../lib/date';
import { emojiForName } from '../../lib/emoji';
import { aiConfigOf, isAiConfigured, parse, parseImage, parseLocalOnly } from '../../ai/parseService';
import { detectTrade, feeAmountOf, tradeFees, tradeNetProfit } from '../../ai/trade';
import { matchGoods } from '../../lib/itemMatch';
import { matchCategoryId } from '../../ai/localParser';
import { answerQuery, type QueryData } from '../../ai/queryLocal';
import { splitTasks } from '../../ai/splitTasks';
import { switchableKindOf } from '../../ai/convert';
import {
  KIND_LABEL,
  classificationChanged,
  matchLearnedRule,
  type LearnedRule,
} from '../../ai/ruleBank';
import { bumpRuleHits, loadLearnedRules, recordCorrection } from '../../api/learnedRules';
import { pushLearnedRulesToCloud } from '../../api/ruleSync';
import { onOpenSmartRecord } from '../../lib/smartRecordBus';
import { isNativeApp, speechErrorText, startSpeech, type SpeechSession } from '../../lib/speechLocal';
import {
  ASR_MODEL_MB,
  type AsrPhase,
  asrModelReady,
  downloadAsrModel,
  releaseAsrModel,
  micAvailable,
  startOfflineAsr,
  type OfflineAsrSession,
} from '../../lib/offlineAsr';
import { round } from '../../lib/money';
/**
 * ★v1.6.4 光标保护（勿删）：
 * 输入框自适应高度必须走 `autoGrowTextarea`，它在改高度前后会保存/恢复光标。
 * 直接写 `el.style.height = ...` 会让 Android WebView 在光标位于文本中间时
 * 把 selection 重排到末尾（用户反馈的「改一个字光标就飞走」）。
 * 详见 lib/caretGuard.ts 文件头。
 */
import { autoGrowTextarea } from '../../lib/caretGuard';
import SmartRecordCard, { type RecordCardState } from './SmartRecordCard';
import TradeRecordCard, { type TradeCardState } from './TradeRecordCard';
import RetireSellCard, { type RetireCardState } from './RetireSellCard';
import { toastError, toastSuccess, useDataStore, useSettingsStore } from '../../store';
import type { AiResultItem, RetireDraft, TradeDraft } from '../../types/ai';
import type { Category, Goods } from '../../types/entities';

/**
 * ★v1.2.0 对话式智能记录入口（PRD：对话式智能记录入口改造 V1.0）。
 *
 * ★v1.3.2 两处调整：
 * - 移除右下角的常驻对话气泡（用户反馈：界面上浮钮太多）。面板改由
 *   加号菜单「对话记一笔」/ 生活流空态 CTA 唤起，不再有常驻按钮；
 * - 面板标题/无障碍名统一为「对话记一笔」——入口按钮写的是「对话记一笔」，
 *   打开后却叫「智能记录」，用户会以为跳错了页面（文字与跳转目标必须一致）。
 *
 * - 面板形态：移动端底部抽屉 / 桌面端右侧面板。
 * - 顶部「对话记一笔」标题 + 会话区 + 底部微信式输入区
 *   （语音/文字切换 · 按住说话 · 识图 · 发送）。
 * - 发送一句话 →
 *   ① 查询意图（「昨天买了什么 / 心情怎么样」）→ 基于本地数据回答，不弹卡；
 *   ② 否则解析（本地规则优先，配了 AI 才回落 AI）→ **逐条弹确认卡片**兜底；
 *      用户只改金额/名称/时间 → 正常保存；**改了大类或小类 → 自动学习**。
 * - 连发多条：每条都会依次识别出卡；发新消息时上一条未确认的卡片按放弃处理
 *   （不保存、不学习），不需要用户先点取消。
 */

/** 面板统一名称（标题、无障碍名、测试选择器都读这一处）。 */
const SMART_RECORD_TITLE = '对话记一笔';

/* ---------------- 工具 ---------------- */

/** 会话消息。 */
interface ChatMsg {
  id: number;
  role: 'sys' | 'user';
  text: string;
}

/** 待确认项：记录卡（三大类）/ 心情卡 / 其它（时间、退役转卖，只确认不学习）。seq 由 applyPending 填充。 */
/**
 * ★v1.3.3：`done` 非空即「已完成态」——卡片不消失、字段只读、顶部亮出【已完成】。
 * 用户反馈原来保存后卡片立刻被下一条顶掉，只靠一闪而过的 toast，总以为没存上。
 */
type Pending = (
  | { mode: 'record'; text: string; item: AiResultItem; init: RecordCardState; seq?: number }
  | { mode: 'mood'; text: string; item: AiResultItem; seq?: number }
  | { mode: 'plain'; text: string; item: AiResultItem; seq?: number }
  /** ★v1.3.6 二手买卖一体（买入入库 + 卖出退役）：一张卡跑完整笔交易。 */
  | { mode: 'trade'; text: string; trade: TradeDraft; seq?: number }
) & { done?: string };

/** 生活流 note 可能带「早饭·」前缀，卡片名称里去掉。 */
function nameOfLedger(note: string): string {
  return (note ?? '').replace(/^[早午晚宵夜下上]{1,2}[饭餐茶]·/, '').trim();
}

/** 按住说话的计时显示：0:03 / 1:05。 */
function fmtRecSecs(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * ★v1.3.6 语音能力与报错文案统一收口到 lib/speechLocal
 * （`isNativeApp` / `speechErrorText`），这里不再自己探测 Capacitor：
 * 同一份判断在两个文件里各写一遍，正是「APP 内提示去浏览器地址栏授权」这类
 * 串味文案的来源。
 */

let msgSeq = 0;

/* ---------------- 悬浮入口 + 面板 ---------------- */

export default function SmartRecordDock({ mode }: { mode: 'desktop' | 'mobile' }) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<LearnedRule[]>([]);

  // ★v1.3.1：全局打开通道（加号右滑 / 加号菜单「对话记一笔」/ 生活流空态 CTA）
  useEffect(() => onOpenSmartRecord(() => setOpen(true)), []);

  // 打开面板时读一次本地规则库（关闭后再打开会拿到最新学到的规则）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void loadLearnedRules().then((r) => {
      if (alive) setRules(r);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  const reloadRules = (): void => {
    void loadLearnedRules().then(setRules);
  };

  return (
    <>
      {open ? (
        <SmartRecordPanel
          mode={mode}
          rules={rules}
          onRulesChange={reloadRules}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/* ---------------- 对话面板 ---------------- */

function SmartRecordPanel({
  mode,
  rules,
  onRulesChange,
  onClose,
}: {
  /** ★v1.3.1：移动端底部抽屉 / 桌面端右侧面板两种形态。 */
  mode: 'desktop' | 'mobile';
  rules: LearnedRule[];
  onRulesChange: () => void;
  onClose: () => void;
}) {
  const categories = useDataStore((s) => s.categories);
  const goods = useDataStore((s) => s.goods);
  const settings = useSettingsStore((s) => s.settings);
  const addLedger = useDataStore((s) => s.addLedger);
  const addGoods = useDataStore((s) => s.addGoods);
  const addSubscription = useDataStore((s) => s.addSubscription);
  const addMood = useDataStore((s) => s.addMood);
  const addTime = useDataStore((s) => s.addTime);
  const updateGoods = useDataStore((s) => s.updateGoods);
  const syncSaleIncome = useDataStore((s) => s.syncSaleIncome);

  const [msgs, setMsgs] = useState<ChatMsg[]>([
    { id: (msgSeq += 1), role: 'sys', text: '直接一句话描述你的消费/心情，我帮你自动归类' },
  ]);
  const [items, setItems] = useState<AiResultItem[]>([]);
  const [busy, setBusy] = useState(false);
  /** 底部输入形态：微信式——文字输入 / 按住说话，左侧按钮互切。 */
  const [voiceMode, setVoiceMode] = useState(false);
  /** 按住说话中：实时提示（松开发送 / 抬起取消 / 实时转写）。 */
  const [recording, setRecording] = useState(false);
  const [recHint, setRecHint] = useState('');

  /**
   * ★v1.3.6 已提交条目的就地编辑态。
   * 用户反馈：已经发出去的那句话错一个字/一个数字，只能整段重打，极其低效。
   * 现在点气泡下方的「编辑」即可原地改，改完点「重新识别」走同一条发送链路。
   */
  const [editingId, setEditingId] = useState<number | null>(null);
  /** 编辑框非受控（IME 铁律），提交时读 DOM 真值。 */
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  /** 非受控输入框（IME 铁律）：DOM 自持值，发送时读真值。 */
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 最近一次输入的原文（学习样本 / 多句场景兜底用）。 */
  const lastTextRef = useRef<string>('');
  /**
   * 当前待确认卡片。state + ref 双写：ref 供「发新消息顶掉旧卡」同步判断，
   * 避免读到渲染周期里的旧 state。
   */
  const [pending, setPendingState] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  /** 每条 pending 的序号：卡片按 seq 重挂载，避免复用上一条的编辑状态。 */
  const pendingSeqRef = useRef(0);
  const applyPending = (p: Pending | null): void => {
    if (p) {
      pendingSeqRef.current += 1;
      p = { ...p, seq: pendingSeqRef.current } as Pending;
    }
    pendingRef.current = p;
    setPendingState(p);
  };
  /** 保存成功 → 原地切到完成态（不换 seq，卡片不重挂载、不清空用户刚改的内容）。 */
  const markDone = (label: string): void => {
    const cur = pendingRef.current;
    if (!cur) return;
    const next = { ...cur, done: label } as Pending;
    pendingRef.current = next;
    setPendingState(next);
  };
  /** 发送串行链：连发消息依次处理，绝不被 busy 吞掉、也不会乱序。 */
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  /** 防双击/双触发：400ms 内同一文本只入队一次（正常手动重发不受影响）。 */
  const lastSentRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  /** 按住说话：识别会话 / 最终转写 / 取消标志 / 按下时的 Y 坐标。 */
  const recRef = useRef<SpeechSession | OfflineAsrSession | null>(null);
  const recFinalRef = useRef('');
  const recCancelRef = useRef(false);
  /** 会话还没就绪就松手了：就绪后立即补一次 stop（快速点按场景）。 */
  const recPendingStopRef = useRef(false);
  const recStartYRef = useRef(0);
  /**
   * ★v1.3.1 识别是否在跑的真实来源。
   * 旧实现 pointerup 读 `recording` state：pointerdown 里的 setRecording(true)
   * 还没渲染完就松手（快速点按），闭包里还是 false → 漏掉 stop()，
   * 识别挂着不收尾——用户感知就是「长按语音没反应」。
   */
  const recActiveRef = useRef(false);
  /** 按住说话计时：开始时间戳 / 已录秒数（进度条与 0:03 显示的来源）。 */
  const recStartAtRef = useRef(0);
  const recTimerRef = useRef<number | null>(null);
  const [recSecs, setRecSecs] = useState(0);
  /** 录音计时上限（秒）：与进度条满格对应，到点自动停止并发送。 */
  const REC_MAX_SECS = 60;

  /** 面板卸载（关闭）时中止识别，避免 onend 回调打到已卸载组件。 */
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
      recActiveRef.current = false;
      if (recTimerRef.current) window.clearInterval(recTimerRef.current);
      recTimerRef.current = null;
      recRef.current?.cancel();
    },
    [],
  );

  useBackGuard(true, onClose);

  const pushMsg = (role: ChatMsg['role'], text: string): void => {
    setMsgs((prev) => [...prev, { id: (msgSeq += 1), role, text }]);
  };

  // 新消息 / 卡片出现时滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, pending]);

  /** 查询用的数据快照（发送时现取，保证最新）。 */
  const querySnapshot = (): QueryData => {
    const s = useDataStore.getState();
    return {
      categories: s.categories,
      goods: s.goods,
      valueRecords: s.valueRecords,
      subscriptions: s.subscriptions,
      moods: s.moods,
      times: s.times,
      archivedSubIds: useSettingsStore.getState().settings.archivedSubIds,
    };
  };

  /**
   * 按名称/备注定位物品（退役转卖用）。
   *
   * ★v1.3.7：改成关键词覆盖率匹配（lib/itemMatch）。旧版是严格子串
   * `g.name.includes(key) || key.includes(g.name)`——语序一变（「粉色的N95笔记本」
   * vs 库里的「N95笔记本准系统 粉色」）就匹配不到，而且完全不看备注。
   */
  const findGoods = (match: string): Goods | undefined => {
    return matchGoods(goods, match)?.item;
  };

  /** 把一条解析结果转成待确认卡片；不支持的动作返回 null。 */
  const buildPending = (item: AiResultItem, text: string): Pending | null => {
    const kind = switchableKindOf(item);
    if (kind === 'ledger' && item.ledgerDraft) {
      const d = item.ledgerDraft;
      return {
        mode: 'record',
        text,
        item,
        init: {
          kind: 'ledger',
          categoryId: d.categoryId,
          // ★v1.2.1：口头语/识图提取的干净名称优先（「在斤大米」→「大米」）
          name: d.name?.trim() || nameOfLedger(d.note) || '消费',
          amount: d.amount,
          date: d.date,
          note: d.note,
        },
      };
    }
    if (kind === 'goods' && item.goodsDraft) {
      const d = item.goodsDraft;
      return {
        mode: 'record',
        text,
        item,
        init: {
          kind: 'goods',
          categoryId: d.categoryId,
          name: d.name,
          amount: d.price,
          date: d.buyDate,
          // PRD 3.3：备注自动填充原文（物品/订阅解析器不带 note，用原始输入兜底）
          note: d.note?.trim() ? d.note : text,
        },
      };
    }
    if (kind === 'sub' && item.subDraft) {
      const d = item.subDraft;
      return {
        mode: 'record',
        text,
        item,
        init: {
          kind: 'sub',
          categoryId: d.categoryId,
          name: d.name,
          amount: d.amount,
          date: todayStr(),
          note: text,
        },
      };
    }
    if (item.action === 'create_mood' && item.moodDraft) return { mode: 'mood', text, item };
    if (item.action === 'create_time' && item.timeDraft) return { mode: 'plain', text, item };
    if (item.action === 'retire_sell' && item.retireDraft) return { mode: 'plain', text, item };
    return null;
  };

  /** 展示下一条待确认项（队列为空则收起卡片）。 */
  const showNext = (list: AiResultItem[]): void => {
    applyPending(null);
    if (list.length === 0) {
      setItems([]);
      return;
    }
    const [head, ...rest] = list;
    const p = buildPending(head, head.rawText ?? lastTextRef.current);
    setItems(rest);
    if (!p) {
      pushMsg('sys', '这条内容暂不支持直接保存，换个说法再试（例如：买了个键盘 花了 399）');
      return;
    }
    applyPending(p);
  };

  /** 发送一句话（入链串行执行）：查询 → 本地解析 → AI 兜底 → 逐条弹卡。 */
  const enqueueSend = (raw: string): void => {
    const text = (raw ?? '').trim();
    if (!text) return;
    // 双击/双触发防重（400ms 内同一文本只发一次；正常手动重发不受影响）
    const now = Date.now();
    if (lastSentRef.current.text === text && now - lastSentRef.current.at < 400) return;
    lastSentRef.current = { text, at: now };
    chainRef.current = chainRef.current
      .then(() => doSend(text))
      .catch(() => {
        /* 单条异常不拖垮后续发送 */
      });
  };

  const doSend = async (text: string): Promise<void> => {
    lastTextRef.current = text;
    pushMsg('user', text);
    if (inputRef.current) {
      inputRef.current.value = '';
      // 清空后把高度收回一行，否则发完还留着一个大框
      inputRef.current.style.height = 'auto';
    }

    /**
     * ★v1.3.6 二手买卖一体（需求 1）：**必须在分句之前拦截**。
     * 「买入N95笔记本360元，卖出560元，手续费费率千分之6、快递费20、额外费用10」
     * 一旦被逗号切开，就变成「入库卡 + 卖出卡」两张互不相认的卡：
     * 物品还没落库，卖出卡找不到目标，用户看到的是「没找到匹配的物品，请先入库」。
     */
    const tradeHit = detectTrade(text, {
      today: todayStr(),
      currency: settings.currency,
    });
    if (tradeHit) {
      if (pendingRef.current) pushMsg('sys', '已放弃上一条未保存的识别，重新识别本条');
      // ★v1.3.8「预填 + 核对」：说话人没提的费用，用物品上已存的费率/快递费/杂费补齐，
      // 卡片弹出时账已经算好，用户核对无误直接提交即可。
      const hitGoods = findGoods(tradeHit.name);
      const pre = goodsFeePreset(hitGoods);
      applyPending({
        mode: 'trade',
        text,
        trade: {
          ...tradeHit,
          feeRatePermille:
            tradeHit.feeRatePermille || (tradeHit.feeAmount > 0 ? 0 : pre.feeRatePermille),
          shippingFee: tradeHit.shippingFee || pre.shippingFee,
          extraFee: tradeHit.extraFee || pre.extraFee,
          categoryId: matchCategoryId(text, categories, 'goods', rules),
        },
      });
      return;
    }

    // ★v1.2.2 多任务一起（用户反馈 4）：一条消息里多个问题逐个回答，
    // 记录段合并后走既有「本地解析 → AI 兜底 → 逐条弹卡」链路。
    const tasks = splitTasks(text);
    const queries = tasks.filter((t) => t.kind === 'query');
    const records = tasks.filter((t) => t.kind === 'record');
    if (queries.length > 0) {
      for (const q of queries) {
        pushMsg('sys', answerQuery(q.text, querySnapshot(), todayStr()));
      }
      if (records.length === 0) return;
      text = records.map((r) => r.text).join('，');
    }

    // 2) 本地规则优先（含已学规则，即时出卡）
    let out = parseLocalOnly(text, { categories, settings, today: todayStr(), learned: rules });
    // 3) 本地没识别出且配了 AI → AI 兜底（保持「识别中」反馈）
    if (out.items.length === 0 && isAiConfigured(aiConfigOf(settings))) {
      setBusy(true);
      try {
        out = await parse(text, { categories, settings, today: todayStr(), learned: rules });
      } catch {
        /* 保留本地空结果，走下方提示 */
      } finally {
        setBusy(false);
      }
    }
    // 学习规则真的被用上了 → 命中计数（规则管理页可见）
    const hit = matchLearnedRule(text, rules);
    if (hit) void bumpRuleHits(hit.id);
    if (out.items.length === 0) {
      pushMsg('sys', '没识别出可以记录的内容，换个说法试试（例如：刚买了N95笔记本准系统 花了899）');
      return;
    }
    // 4) 逐条弹卡；若上一条卡片还没确认，按放弃处理（不保存、不学习）
    if (pendingRef.current) pushMsg('sys', '已放弃上一条未保存的识别，重新识别本条');
    showNext(out.items);
  };

  const sendFromInput = (): void => {
    enqueueSend(inputRef.current?.value ?? '');
  };

  /* ---------------- ★v1.3.6 已提交条目：一键复制 / 就地编辑重发 ---------------- */

  /** 复制原文到剪贴板。 */
  const copyMsg = async (text: string): Promise<void> => {
    const ok = await copyText(text);
    if (ok) pushMsg('sys', '已复制原文，可直接粘贴修改');
    else toastError('复制失败，请长按气泡手动选择文字');
  };

  /** 进入就地编辑（同一时间只编辑一条）。
   *
   * ★v1.3.8：编辑期间自动收起下方确认卡片（见卡片区渲染），
   * 把屏幕空间完全让给输入法与编辑框——卡片悬浮在输入法上方、
   * 盖住正在编辑的内容，是用户反馈最痛的编辑体验问题。
   */
  const startEdit = (m: ChatMsg): void => {
    setEditingId(m.id);
    // 下一帧聚焦并定位到末尾：用户要改的往往就是句尾的金额
    window.setTimeout(() => {
      const el = editRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      // 键盘弹出时固定高度抽屉不会自动滚动，主动把编辑框滚进可视区
      // （jsdom 无此 API，老 WebView 兜底跳过）
      el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }, 0);
  };

  /**
   * 提交编辑：读 DOM 真值重新走「识别 → 弹卡」链路。
   * 历史气泡保持原样（不就地改写），这样「改前 / 改后」都在会话里留痕，
   * 复核时能看出自己把哪个数字改对了。
   */
  const submitEdit = (): void => {
    const text = (editRef.current?.value ?? '').trim();
    setEditingId(null);
    if (!text) {
      toastError('内容为空，已取消重新识别');
      return;
    }
    enqueueSend(text);
  };

  /** 确认保存（记录卡）：改没改分类决定是否触发学习（PRD 3.2 / 3.3）。 */
  const confirmRecord = async (state: RecordCardState): Promise<void> => {
    if (!pendingRef.current || pendingRef.current.mode !== 'record') return;
    const { item, text, init } = pendingRef.current;
    const changed = classificationChanged(
      { kind: init.kind, categoryId: init.categoryId },
      { kind: state.kind, categoryId: state.categoryId },
    );
    const cat: Category | undefined = categories.find((c) => c.id === state.categoryId);
    try {
      // 以卡片最终状态为准落库（用户可能把大类切成了与原识别结果不同的类型，
      // 此时 item 里并没有目标类型的草稿，aux 字段全部走兜底）
      if (state.kind === 'ledger') {
        await addLedger({
          type: item.ledgerDraft?.type ?? 'expense',
          amount: state.amount,
          categoryId: state.categoryId,
          judgement: item.ledgerDraft?.judgement ?? 'xu',
          date: state.date || todayStr(),
          note: state.note,
        });
      } else if (state.kind === 'goods') {
        await addGoods({
          name: state.name || '物品',
          price: state.amount,
          currency: item.goodsDraft?.currency ?? item.subDraft?.currency ?? 'CNY',
          buyDate: state.date || todayStr(),
          categoryId: state.categoryId,
          tags: [],
          note: state.note,
        });
      } else {
        await addSubscription({
          name: state.name || '订阅',
          amount: state.amount,
          currency: item.subDraft?.currency ?? item.goodsDraft?.currency ?? 'CNY',
          period: item.subDraft?.period ?? 'month',
          every: item.subDraft?.every ?? 1,
          categoryId: state.categoryId,
          icon: emojiForName(state.name),
        });
      }
      // 模式B：改了分类 → 沉淀学习样本 + 生成规则并入本地规则库
      if (changed && cat) {
        const learned = await recordCorrection({
          text,
          name: state.name,
          kind: state.kind,
          categoryName: cat.name,
        });
        onRulesChange();
        // ★v1.3.3：学到的规则自动同步到云端账号（未登录/离线时静默跳过）
        void pushLearnedRulesToCloud();
        pushMsg(
          'sys',
          learned
            ? `已学会：「${learned.rule.keyword}」这类说法归到 ${KIND_LABEL[state.kind]} · ${cat.name}，下次直接归对`
            : `已按 ${KIND_LABEL[state.kind]} · ${cat.name} 保存`,
        );
      }
      // ★v1.3.3：卡片留在原地显示【已完成】，不再 toast 一闪就消失
      markDone(`已记入${KIND_LABEL[state.kind]} · ${cat?.name ?? '未分类'}${state.amount ? ` · ¥${state.amount}` : ''}`);
    } catch (e) {
      toastError((e as Error).message || '保存失败');
    }
  };

  /** 确认保存（二手买卖一体）：先入库 → 再标记退役（已售出）→ 同步生活流。 */
  const confirmTrade = async (state: TradeCardState): Promise<void> => {
    const cur = pendingRef.current;
    if (!cur || cur.mode !== 'trade') return;
    if (state.buyPrice <= 0 || state.sellPrice <= 0) {
      toastError('买入价和售价都要大于 0');
      return;
    }
    const fees = tradeFees({
      sellPrice: state.sellPrice,
      feeRatePermille: state.feeRatePermille,
      feeAmount: feeAmountOf(state.sellPrice, state.feeRatePermille),
      shippingFee: state.shippingFee,
      extraFee: state.extraFee,
    });
    try {
      // ① 入库（买入金额 + 卖出侧附加费用一次写全，少一次落盘）
      const row = await addGoods({
        name: state.name || '物品',
        price: state.buyPrice,
        currency: cur.trade.currency,
        buyDate: state.buyDate || todayStr(),
        categoryId: state.categoryId,
        tags: [],
        note: state.note || undefined,
        extraFees: fees,
      });
      // ② 标记退役（已售出）
      await updateGoods(row.id, { status: 'retired', sellPrice: state.sellPrice });
      // ③ 净赚同步生活流（口径：售价 − 买入 − 所有附加费用）
      const res = await syncSaleIncome(row.id);
      const profit = tradeNetProfit({
        buyPrice: state.buyPrice,
        sellPrice: state.sellPrice,
        feeRatePermille: state.feeRatePermille,
        feeAmount: feeAmountOf(state.sellPrice, state.feeRatePermille),
        shippingFee: state.shippingFee,
        extraFee: state.extraFee,
      });
      const feeText = fees.map((f) => `${f.name} ${f.amount.toFixed(2)}`).join(' + ');
      const head = `已入库并标记「已售出」${profit > 0 ? `，净赚 ¥${profit.toFixed(2)}` : '（无净赚）'}`;
      const tail =
        res.action === 'created' || res.action === 'updated'
          ? ' 已记入生活流收入'
          : profit > 0
            ? '（净赚未入账，请检查出售价）'
            : '';
      markDone(feeText ? `${head}${tail}｜扣 ${feeText}` : `${head}${tail}`);
    } catch (e) {
      toastError((e as Error).message || '保存失败');
    }
  };

  /** 确认保存（心情 / 时间：只保存，不学习）。退役转卖走 confirmRetire。 */
  const confirmPlain = async (): Promise<void> => {
    const cur = pendingRef.current;
    if (!cur || cur.mode === 'record' || cur.mode === 'trade') return;
    const { item } = cur;
    try {
      if (cur.mode === 'mood' && item.moodDraft) {
        await addMood({ feeling: item.moodDraft.feeling, text: item.moodDraft.text });
      } else if (item.action === 'create_time' && item.timeDraft) {
        await addTime({
          durationMin: item.timeDraft.durationMin,
          tags: item.timeDraft.tags ?? [],
          meaning: item.timeDraft.meaning,
          note: item.timeDraft.note,
        });
      }
      markDone(
        cur.mode === 'mood' ? '已记入情绪' : item.action === 'create_time' ? '已记入时间' : '已保存',
      );
    } catch (e) {
      toastError((e as Error).message || '保存失败');
    }
  };

  /**
   * ★v1.3.7 退役转卖（带卖出费用）。
   *
   * 手续费按**费率**折算成金额后写进 `extraFees`，与「二手买卖一体」同一口径：
   * 净赚 = 售价 − 买入 − 手续费 − 运费 − 杂费，由 `syncSaleIncome` 统一入生活流。
   */
  const confirmRetire = async (state: RetireCardState): Promise<void> => {
    const cur = pendingRef.current;
    if (!cur || cur.mode !== 'plain' || !cur.item.retireDraft) return;
    const draft = cur.item.retireDraft;
    const target = findGoods(draft.match);
    if (!target) {
      toastError(`没找到与「${draft.match}」匹配的物品，请先入库`);
      return;
    }
    if (state.sellPrice <= 0) {
      toastError('转卖价要大于 0');
      return;
    }
    const fees = tradeFees({
      sellPrice: state.sellPrice,
      feeRatePermille: state.feeRatePermille,
      shippingFee: state.shippingFee,
      extraFee: state.extraFee,
    });
    try {
      await updateGoods(target.id, {
        status: 'retired',
        sellPrice: state.sellPrice,
        extraFees: fees,
      });
      const res = await syncSaleIncome(target.id);
      const profit = tradeNetProfit({
        buyPrice: target.price,
        sellPrice: state.sellPrice,
        feeRatePermille: state.feeRatePermille,
        shippingFee: state.shippingFee,
        extraFee: state.extraFee,
      });
      const feeText = fees.map((f) => `${f.name} ${f.amount.toFixed(2)}`).join(' + ');
      const head = `已退役${profit > 0 ? `，净赚 ¥${profit.toFixed(2)}` : '（无净赚）'}`;
      const tail =
        res.action === 'created' || res.action === 'updated' ? ' 已记入生活流收入' : '';
      markDone(feeText ? `${head}${tail}｜扣 ${feeText}` : `${head}${tail}`);
    } catch (e) {
      toastError((e as Error).message || '保存失败');
    }
  };

  /* ---------------- ★v1.4.0 离线语音模型（首次使用引导下载） ---------------- */

  /** 本地离线模型是否就绪（就绪则所有识别都在本机跑，不依赖任何云端）。 */
  const [asrLocalReady, setAsrLocalReady] = useState(false);
  /** 首次使用：弹「下载离线模型」引导。 */
  const [asrAsk, setAsrAsk] = useState(false);
  /** 下载进度（null = 未在下载）。 */
  const [asrDl, setAsrDl] = useState<{ pct: number; received: number; total: number } | null>(null);
  /** 用户主动选「先用系统语音」：本次会话不再提示下载。 */
  const preferSystemRef = useRef(false);
  /** ★v1.6.1 模型常驻开关（设置页可改，默认关：省内存）。 */
  const keepAsrModel = useSettingsStore((st) => st.settings.asrKeepModel === true);

  useEffect(() => {
    let alive = true;
    void asrModelReady().then((ok) => {
      if (alive) setAsrLocalReady(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 下载离线模型（约 40MB，一次性，存本机后永久离线可用）。 */
  const downloadAsr = async (): Promise<void> => {
    if (asrDl) return;
    setAsrDl({ pct: 0, received: 0, total: 0 });
    try {
      await downloadAsrModel((pct, received, total) => setAsrDl({ pct, received, total }));
      setAsrLocalReady(true);
      setAsrDl(null);
      setAsrAsk(false);
      toastSuccess('离线语音模型已就绪，之后断网也能用');
    } catch (e) {
      setAsrDl(null);
      toastError((e as Error).message || '模型下载失败，请检查网络后重试');
    }
  };

  /* ---------------- 语音：微信式「按住 说话」（★v1.3.6 端侧识别） ---------------- */

  /**
   * 按下「按住 说话」：启动**本机**语音识别（原生离线引擎优先）。
   *
   * ★v1.3.6：整条链路换成 lib/speechLocal —— 不再直接用 Web Speech。
   * 旧实现里 Web Speech 在 Android 上会把音频送去云端识别服务，
   * 服务端/外网一抖就报「网络错误」，语音输入直接不可用；
   * 现在走系统离线识别器，服务端停机也照常录音转字。
   */
  /**
   * ★v1.6.0 语音交互状态机（全链路重写）。
   *
   * 旧实现的问题（用户反馈逐条对应）：
   * - 单次点按就进入"永不停止"的录音：pointerup 依赖 state/re-render，会话未就绪时丢事件；
   * - 录音中再点没反应：beginRecognition 开头 `if (recActiveRef.current) return`，
   *   而 recActiveRef 只在结束回调里才复位；
   * - 7~8 秒后说"没听清"：麦克风其实没开（AudioContext suspended / 采样率没降）
   *   或模型会话挂死；且没有超时，界面卡在录音态。
   *
   * 新规则（可预期、全程可停）：
   * - 按下即开始（准备中显示阶段），**再按一下立即停止**；长按则松手结束；
   * - 准备阶段也有看门狗：模型 20s / 麦克风 8s / 首帧 5s，任一超时立刻报错复位；
   * - 结束拿到文字 → 自动填输入框并发送；拿不到文字 → 明确区分"没开麦"和"没听清"。
   */
  const [recStage, setRecStage] = useState<'preparing' | 'listening' | 'stopping'>('preparing');
  const [recLevel, setRecLevel] = useState(0);
  const downAtRef = useRef(0);
  /** 刚停止的时间戳：防止 pointerup→click 的合成事件把录音又拉起来。 */
  const lastStopAtRef = useRef(0);

  /** 错误码 → 可执行的用户提示（区分「麦克风没开」和「没听清」）。 */
  const voiceErrorText = (code: string): string => {
    switch (code) {
      case 'mic-denied':
        return '麦克风权限被拒绝：请在系统设置里允许纳物使用麦克风，或改用键盘输入';
      case 'mic-no-device':
      case 'mic-unavailable':
        return '没有可用的麦克风，请改用键盘输入';
      case 'mic-busy':
        return '麦克风被其他应用占用，关掉通话/录音类应用后重试，或改用键盘输入';
      case 'mic-silent':
        return '没有收到麦克风声音：请检查是否被占用/静音，或改用键盘输入';
      case 'audio-suspended':
        return '音频引擎未启动，请重启 App 后再试，或改用键盘输入';
      case 'engine-timeout':
      case 'engine-failed':
        return '离线语音引擎启动失败（可重试），或改用键盘输入';
      case 'no-match':
        return '没听清，请靠近麦克风再说一次，或改用键盘输入';
      default:
        return speechErrorText(code === 'start-failed' ? 'unavailable' : code, isNativeApp());
    }
  };

  /** 真正开始：本地引擎优先，失败/无麦克风时回落系统语音。 */
  const startRecognitionNow = (): void => {
    if (recActiveRef.current) return;
    recActiveRef.current = true;
    recCancelRef.current = false;
    recPendingStopRef.current = false;
    recFinalRef.current = '';
    setRecording(true);
    setRecStage('preparing');
    setRecSecs(0);
    setRecLevel(0);
    setRecHint(asrLocalReady && !preferSystemRef.current ? '正在启动语音…' : '正在启动系统语音…');
    recStartAtRef.current = Date.now();
    if (recTimerRef.current) window.clearInterval(recTimerRef.current);
    recTimerRef.current = window.setInterval(() => {
      const sec = Math.floor((Date.now() - recStartAtRef.current) / 1000);
      setRecSecs(sec);
      if (sec >= REC_MAX_SECS) {
        setRecHint(`已达 ${REC_MAX_SECS} 秒上限，自动发送`);
        recRef.current?.stop();
      }
    }, 250);

    const useLocal = asrLocalReady && !preferSystemRef.current && micAvailable();
    const starter = useLocal
      ? (cb: Parameters<typeof startOfflineAsr>[0]) =>
          startOfflineAsr(cb, { keepModel: keepAsrModel }) as Promise<SpeechSession | OfflineAsrSession>
      : (cb: Parameters<typeof startSpeech>[0]) => startSpeech(cb) as Promise<SpeechSession | OfflineAsrSession>;

    void starter({
      lang: 'zh-CN',
      onPhase: (phase: AsrPhase) => {
        if (!recActiveRef.current) return;
        setRecStage(phase === 'listening' ? 'listening' : 'preparing');
        if (phase === 'loading-model') setRecHint('正在加载离线模型…');
        if (phase === 'opening-mic') setRecHint('正在打开麦克风…');
        if (phase === 'listening') setRecHint('正在聆听… 点击结束');
      },
      onLevel: (lv: number) => setRecLevel(lv),
      onPartial: (t) => {
        recFinalRef.current = t;
        setRecHint(t || '正在聆听… 点击结束');
      },
      onResult: (t) => {
        recFinalRef.current = t;
      },
      onError: (code: string) => {
        if (code === 'model-missing') {
          setAsrLocalReady(false);
          setAsrAsk(true);
          return;
        }
        toastError(voiceErrorText(code));
      },
      onEnd: (reason) => {
        const cancelled = reason === 'cancelled' || recCancelRef.current;
        const text = recFinalRef.current.trim();
        finishRecognition();
        if (cancelled || !text || !aliveRef.current) return;
        enqueueSend(text);
      },
    } as Parameters<typeof startSpeech>[0])
      .then((session) => {
        recRef.current = session;
        if (!recActiveRef.current) return;
        setRecStage('listening');
        setRecHint('正在聆听… 点击结束');
        // 准备阶段用户已经松手/再按：会话就绪后立刻收尾
        if (recPendingStopRef.current) recRef.current?.stop();
      })
      .catch((e: unknown) => {
        finishRecognition();
        const msg = (e as Error)?.message ?? '';
        if (msg === 'model-missing') {
          setAsrLocalReady(false);
          setAsrAsk(true);
          return;
        }
        toastError(voiceErrorText(msg));
      });
  };

  /** 首次使用 / 模型缺失时先引导下载；否则直接开始。 */
  const beginRecognition = (): void => {
    if (recActiveRef.current) return;
    if (!asrLocalReady && !preferSystemRef.current && micAvailable()) {
      setAsrAsk(true);
      return;
    }
    startRecognitionNow();
  };

  /** 停止：会话未就绪则打标记，就绪后立刻停（保证"按了就有反应"）。 */
  const stopVoice = (): void => {
    lastStopAtRef.current = Date.now();
    const session = recRef.current;
    if (!session) {
      recPendingStopRef.current = true;
      setRecHint('正在结束…');
      return;
    }
    setRecStage('stopping');
    setRecHint('正在整理文字…');
    session.stop();
  };

  /** 语音键按下：空闲 → 开始；录音中 → 立即停止（两条路径都必响应）。 */
  const onVoiceDown = (): void => {
    downAtRef.current = Date.now();
    if (recActiveRef.current) {
      if (recStage === 'listening') stopVoice();
      else recPendingStopRef.current = true;
      return;
    }
    beginRecognition();
  };

  /** 松手：长按（≥500ms）→ 结束并出结果；点按 → 保持聆听，等下次点按结束。 */
  const onVoiceUp = (): void => {
    if (!recActiveRef.current) return;
    if (Date.now() - lastStopAtRef.current < 400) return;
    if (Date.now() - downAtRef.current >= 500) stopVoice();
  };

  /** 开关被关掉 → 立刻释放常驻模型（用户预期：关掉就省内存）。 */
  useEffect(() => {
    if (!keepAsrModel) releaseAsrModel();
  }, [keepAsrModel]);

  /** 切到后台/锁屏时自动结束录音并出结果（避免"看不见的录音"一直占着麦克风）。 */
  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState === 'hidden' && recActiveRef.current) stopVoice();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 收尾：复位计时/状态（不负责发消息，发消息在 onEnd 里）。 */
  const finishRecognition = (): void => {
    recActiveRef.current = false;
    recPendingStopRef.current = false;
    if (recTimerRef.current) window.clearInterval(recTimerRef.current);
    recTimerRef.current = null;
    recRef.current = null;
    setRecSecs(0);
    setRecording(false);
    setRecStage('preparing');
    setRecLevel(0);
    setRecHint('');
  };

  /* ---------------- 识图：订单/小票截图 → OCR → 逐条弹卡 ---------------- */

  /**
   * v1.2.2 压缩策略按解析链路分流：
   * - 配了 AI（vision 上传）：长边 1024 JPEG 0.85，控体积；
   * - 本地 OCR（Tesseract）：**几乎不压**——订单截图的小字号金额/商品名
   *   压到 1024 后 OCR 错误率飙升，仅长边 >2200 时缩放，质量 0.92 保真。
   */
  const compressForOcr = async (file: File, forAi: boolean): Promise<string> => {
    const raw = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onerror = () => reject(new Error('图片解码失败'));
      im.onload = () => resolve(im);
      im.src = raw;
    });
    const max = forAi ? 1024 : 2200;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * scale);
    cv.height = Math.round(img.height * scale);
    const ctx2d = cv.getContext('2d');
    if (!ctx2d) throw new Error('画布不可用');
    ctx2d.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', forAi ? 0.85 : 0.92);
  };

  const onPickImage = async (file: File | undefined): Promise<void> => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const dataUrl = await compressForOcr(file, isAiConfigured(aiConfigOf(settings)));
      pushMsg('user', `（识图）${file.name || '图片'}`);
      const out = await parseImage(dataUrl, {
        categories,
        settings,
        today: todayStr(),
        learned: rules,
      });
      if (out.items.length === 0) {
        pushMsg('sys', out.reason ?? '图中没有识别出可记账的内容，换张更清晰的试试');
        return;
      }
      if (pendingRef.current) pushMsg('sys', '已放弃上一条未保存的识别，重新识别本条');
      showNext(out.items);
    } catch (e) {
      toastError((e as Error).message || '识图失败，请再试');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <>
      {/* 遮罩：点空白区域关闭面板 */}
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside
        /* ★v1.3.5：桌面端抽屉补左圆角（1.5rem，与 Sheet.tsx 右侧抽屉、全站 R 角一致）。
           旧版 `inset-y-0 right-0` 没有圆角，网页端面板左侧是一条直角边，
           和「记一笔」等其它弹层并排看像两种设计语言。
           overflow-hidden 保证面板内的标题栏/输入区不会盖住圆角。 */
        className={`nw-smart-enter nw-smart-panel fixed z-50 flex flex-col overflow-hidden bg-surface shadow-2xl ${
          mode === 'mobile'
            ? 'nw-smart-sheet inset-x-0 bottom-0 max-h-[86vh] rounded-t-3xl'
            : 'inset-y-0 right-0 w-full max-w-md rounded-l-3xl'
        }`}
        style={
          mode === 'mobile'
            ? { paddingBottom: 'env(safe-area-inset-bottom)' }
            : { top: 0, bottom: 0, right: 0, left: 'auto', paddingTop: 'env(safe-area-inset-top)' }
        }
        aria-label={SMART_RECORD_TITLE}
      >
        {/* ★v1.3.1 移动端抽屉把手（视觉提示：可下滑关闭的底部抽屉） */}
        {mode === 'mobile' ? (
          <div className="flex shrink-0 justify-center pt-2">
            <span className="h-1 w-9 rounded-full bg-line-2" aria-hidden />
          </div>
        ) : null}

        {/* 顶部标题栏 */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <span className="text-sm font-semibold">{SMART_RECORD_TITLE}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-full text-ink-3 active:bg-surface-2"
          >
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
        </header>

        {/* 会话区 */}
        <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto p-4">
          {msgs.map((m) => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`flex max-w-[85%] flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                {editingId === m.id ? (
                  /* ★v1.3.6 就地编辑：不换页面、不弹新层，改完直接重新识别 */
                  <div className="w-full min-w-[15rem] rounded-2xl border border-accent bg-surface p-2">
                    <textarea
                      ref={editRef}
                      defaultValue={m.text}
                      rows={3}
                      aria-label="编辑这条内容"
                      className="w-full resize-none rounded-xl bg-surface-2 px-2.5 py-2 text-sm leading-5 text-ink outline-none"
                    />
                    <div className="mt-1.5 flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="h-8 rounded-full border border-line px-3 text-xs text-ink-2 active:bg-surface-2"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={submitEdit}
                        className="h-8 rounded-full bg-accent px-3 text-xs font-semibold text-white active:opacity-90"
                      >
                        重新识别
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p
                      className={`whitespace-pre-line rounded-2xl px-3 py-2 text-sm leading-5 ${
                        m.role === 'user' ? 'bg-accent text-white' : 'bg-surface-2 text-ink-2'
                      }`}
                    >
                      {m.text}
                    </p>
                    {m.role === 'user' ? (
                      <div className="mt-1 flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void copyMsg(m.text)}
                          aria-label="复制原文"
                          title="复制原文"
                          className="flex h-7 items-center gap-1 rounded-full px-2 text-[11px] text-ink-3 active:bg-surface-2"
                        >
                          <Copy size={12} strokeWidth={1.8} aria-hidden />
                          复制
                        </button>
                        <button
                          type="button"
                          onClick={() => startEdit(m)}
                          aria-label="编辑这条"
                          title="编辑后重新识别"
                          className="flex h-7 items-center gap-1 rounded-full px-2 text-[11px] text-ink-3 active:bg-surface-2"
                        >
                          <Pencil size={12} strokeWidth={1.8} aria-hidden />
                          编辑
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 确认卡片区（浮在会话内容下方、输入框上方）。
            ★v1.3.8：就地编辑期间自动收起——卡片悬浮在输入法上方会盖住
            正在编辑的内容；提交/取消编辑后自动恢复。 */}
        {editingId !== null ? (
          <div className="flex shrink-0 items-center justify-between border-t border-line bg-surface-2/60 px-3 py-2">
            <span className="text-[11px] text-ink-2">卡片已暂时收起，编辑完成后自动恢复</span>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              className="rounded-full border border-line px-2.5 py-1 text-[11px] text-ink-2 active:bg-surface"
            >
              完成编辑
            </button>
          </div>
        ) : pending ? (
          <div className="max-h-[62%] shrink-0 overflow-y-auto border-t border-line bg-surface-2/60 p-3">
            {pending.mode === 'record' ? (
              <SmartRecordCard
                key={pending.seq ?? 0}
                initial={pending.init}
                categories={categories}
                onConfirm={(s) => void confirmRecord(s)}
                onCancel={() => showNext(items)}
                done={pending.done}
                remaining={items.length}
                onNext={() => showNext(items)}
              />
            ) : pending.mode === 'trade' ? (
              <TradeRecordCard
                key={pending.seq ?? 0}
                initial={pending.trade}
                categories={categories}
                onConfirm={(s) => void confirmTrade(s)}
                onCancel={() => showNext(items)}
                done={pending.done}
                remaining={items.length}
                onNext={() => showNext(items)}
              />
            ) : pending.mode === 'mood' ? (
              <SimpleCard
                title="记录心情"
                lines={[`${pending.item.moodDraft?.feeling ?? '🙂'} ${pending.item.moodDraft?.text ?? ''}`]}
                onConfirm={() => void confirmPlain()}
                onCancel={() => showNext(items)}
                done={pending.done}
                remaining={items.length}
                onNext={() => showNext(items)}
              />
            ) : pending.item.action === 'retire_sell' && pending.item.retireDraft ? (
              <RetireSellCard
                matchName={pending.item.retireDraft.match}
                targetName={findGoods(pending.item.retireDraft.match)?.name}
                buyPrice={findGoods(pending.item.retireDraft.match)?.price ?? 0}
                sellPrice={pending.item.retireDraft.sellPrice}
                initial={retireInitialOf(pending.item.retireDraft, findGoods(pending.item.retireDraft.match))}
                onConfirm={(s) => void confirmRetire(s)}
                onCancel={() => showNext(items)}
                done={pending.done}
                remaining={items.length}
                onNext={() => showNext(items)}
              />
            ) : (
              <SimpleCard
                title={pending.item.action === 'retire_sell' ? '退役转卖确认' : '时间记录确认'}
                lines={[plainSummary(pending.item)]}
                onConfirm={() => void confirmPlain()}
                onCancel={() => showNext(items)}
                done={pending.done}
                remaining={items.length}
                onNext={() => showNext(items)}
              />
            )}
          </div>
        ) : null}

        {/* ★v1.4.0 首次使用语音：下载离线识别模型（本机运算，不经过任何云端） */}
        {asrAsk || asrDl ? (
          <div className="shrink-0 border-t border-line bg-surface-2/60 p-3.5">
            <p className="text-sm font-semibold">首次使用语音：下载离线识别模型</p>
            <p className="mt-1 text-[11px] leading-5 text-ink-3">
              纳物的语音转文字在本机完成，不依赖云端、服务端停机也能用。
              需一次性下载中文模型（约 {ASR_MODEL_MB}MB），下载后永久离线可用。
            </p>
            {asrDl ? (
              <>
                <div className="mt-2.5 h-[6px] w-full overflow-hidden rounded-full bg-surface">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-150"
                    style={{ width: `${Math.max(2, asrDl.pct)}%` }}
                  />
                </div>
                <p className="mt-1 text-[11px] tabular-nums text-ink-3">
                  {asrDl.pct >= 0
                    ? `下载中 ${asrDl.pct}% · ${(asrDl.received / 1048576).toFixed(1)}${
                        asrDl.total > 0 ? ` / ${(asrDl.total / 1048576).toFixed(1)}` : ''
                      } MB`
                    : `已下载 ${(asrDl.received / 1048576).toFixed(1)} MB`}
                </p>
                <p className="mt-1 text-[11px] leading-4 text-ink-3">下载期间请保持网络连接，可继续用键盘记账</p>
              </>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {asrDl ? null : (
                <>
                  <button
                    type="button"
                    onClick={() => void downloadAsr()}
                    className="h-9 flex-1 rounded-btn bg-accent px-3 text-[12px] font-semibold text-white active:opacity-90"
                  >
                    下载并启用离线语音
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAsrAsk(false);
                      preferSystemRef.current = true;
                      startRecognitionNow();
                    }}
                    className="h-9 rounded-btn border border-line bg-surface px-3 text-[12px] text-ink-2 active:bg-surface-2"
                  >
                    先用系统语音
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAsrAsk(false);
                      setVoiceMode(false);
                    }}
                    className="h-9 rounded-btn border border-line bg-surface px-3 text-[12px] text-ink-2 active:bg-surface-2"
                  >
                    键盘输入
                  </button>
                </>
              )}
            </div>
          </div>
        ) : null}

        {/* 底部输入区（微信式：语音/文字切换 · 输入/按住说话 · 识图 · 发送） */}
        <div
          className="shrink-0 border-t border-line p-3"
          style={{
            // 桌面右侧面板自带顶部安全区；移动抽屉的安全区已在 aside 上留过，这里不重复
            paddingBottom: mode === 'mobile' ? '0.75rem' : 'calc(env(safe-area-inset-bottom) + 0.75rem)',
          }}
        >
          <div className="flex items-center gap-2">
            {/* 左侧：语音 / 文字 形态切换 */}
            <button
              type="button"
              onClick={() => {
                // ★v1.3.7：切到语音前先收键盘。网页端「点语音却跳出输入法语音」
                // 就是输入框还攥着焦点导致的；这里主动失焦 + 关闭软键盘。
                if (!voiceMode) {
                  inputRef.current?.blur();
                  const active = document.activeElement as HTMLElement | null;
                  if (active && active !== document.body) active.blur();
                  (navigator as unknown as { virtualKeyboard?: { hide?: () => void } }).virtualKeyboard?.hide?.();
                }
                setVoiceMode((v) => !v);
              }}
              aria-label={voiceMode ? '切换到文字输入' : '切换到语音输入'}
              title={voiceMode ? '切换到文字输入' : '切换到语音输入'}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-btn border border-line bg-surface-2 text-ink-2 active:bg-surface"
            >
              {voiceMode ? (
                <Keyboard size={18} strokeWidth={1.8} aria-hidden />
              ) : (
                <Mic size={18} strokeWidth={1.8} aria-hidden />
              )}
            </button>

            {/* 中间：文字输入框 / 按住说话 */}
            {voiceMode ? (
              <button
                type="button"
                aria-label="按住说话"
                className={`h-10 min-w-0 flex-1 select-none rounded-btn border text-sm font-medium ${
                  recording ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface-2 text-ink-2'
                }`}
                style={{ touchAction: 'none' }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  recStartYRef.current = e.clientY;
                  recCancelRef.current = false;
                  onVoiceDown();
                }}
                onPointerMove={(e) => {
                  if (!recActiveRef.current) return;
                  if (recStartYRef.current - e.clientY > 60) {
                    setRecHint('抬起手指 取消');
                  } else if (recStage === 'listening') {
                    setRecHint(recHint && recHint.startsWith('正在聆听') ? '正在聆听… 点击结束' : recHint);
                  }
                }}
                onPointerUp={(e) => {
                  // ★v1.6.0：长按松手 → 结束出结果；点按 → 保持聆听（下次点按结束）
                  if (!recActiveRef.current) return;
                  if (recStartYRef.current - e.clientY > 60) {
                    recCancelRef.current = true;
                    recPendingStopRef.current = false;
                    recRef.current?.cancel();
                    finishRecognition();
                    return;
                  }
                  onVoiceUp();
                }}
                onPointerCancel={() => {
                  if (!recActiveRef.current) return;
                  recCancelRef.current = true;
                  recPendingStopRef.current = false;
                  recRef.current?.cancel();
                  finishRecognition();
                }}
              >
                {recording ? (
                  <span className="flex w-full items-center justify-center gap-2 px-2">
                    {/* 音量点：随真实音量变亮变大 —— 一眼看出麦克风在不在收声 */}
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-accent transition-transform"
                      style={{
                        opacity: recStage === 'listening' ? 0.45 + Math.min(1, recLevel * 20) * 0.55 : 0.35,
                        transform: `scale(${(1 + Math.min(1, recLevel * 20) * 0.6).toFixed(2)})`,
                      }}
                      aria-hidden
                    />
                    <span className="shrink-0 font-semibold tabular-nums">{fmtRecSecs(recSecs)}</span>
                    <span className="truncate">
                      {recStage === 'preparing'
                        ? recHint || '正在启动…'
                        : recStage === 'stopping'
                          ? '正在整理文字…'
                          : recHint || '正在聆听… 点击结束'}
                    </span>
                  </span>
                ) : (
                  '点击说话'
                )}
              </button>
            ) : (
              /*
               * ★v1.6.4 光标铁律（改这里之前先读 lib/caretGuard.ts 文件头）：
               * · 非受控（defaultValue），值只由 DOM 自己持有；
               * · **禁止**给这个 textarea 加 key、禁止用条件渲染/三元把它换掉、
               *   禁止把它包进会重挂载的子树 —— 一旦 DOM 被销毁重建，光标必丢；
               * · 任何「改高度 / 改 value / 格式化」都必须经 autoGrowTextarea（含光标恢复）。
               */
              <textarea
                ref={inputRef}
                rows={1}
                defaultValue=""
                placeholder="一句话描述消费/心情…"
                enterKeyHint="send"
                /* ★v1.3.7：高度随内容自适应（旧版是固定高 input，长文本只能左右拖着看） */
                onInput={(e) => {
                  // ★v1.3.8：中文输入法组合期不改高度——高度抖动会让部分
                  // WebView 重启组词、光标表现异常；compositionend 再补一次撑高
                  if (!(e.nativeEvent as InputEvent).isComposing) growInput(e.currentTarget);
                }}
                onCompositionEnd={(e) => growInput(e.currentTarget)}
                onKeyDown={(e) => {
                  // 回车发送；Shift+回车换行；中文输入法组合中的回车不算（否则选词就发出去了）
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    sendFromInput();
                  }
                }}
                className="max-h-40 min-h-10 min-w-0 flex-1 resize-none overflow-y-auto rounded-btn border border-line bg-surface-2 px-3 py-2 text-sm leading-6 outline-none focus:border-accent"
              />
            )}

            {/* 右侧：识图（订单/小票截图 OCR 入库） */}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              aria-label="识图记账"
              title="识图记账（订单/小票截图）"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-btn border border-line bg-surface-2 text-ink-2 active:bg-surface disabled:opacity-40"
            >
              <ImagePlus size={18} strokeWidth={1.8} aria-hidden />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void onPickImage(e.target.files?.[0]);
                e.target.value = '';
              }}
            />

            {/* 发送（仅文字形态显示） */}
            {!voiceMode ? (
              <button
                type="button"
                onClick={sendFromInput}
                aria-label="发送"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-btn bg-accent text-white active:opacity-90"
              >
                <Send size={16} strokeWidth={1.8} aria-hidden />
              </button>
            ) : null}
          </div>
          {/* ★v1.3.1 按住说话进度条：录音时长的视觉反馈（用户反馈「长按语音进度条无响应」） */}
          {recording ? (
            <div
              className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-label="录音时长"
              aria-valuemin={0}
              aria-valuemax={REC_MAX_SECS}
              aria-valuenow={Math.min(recSecs, REC_MAX_SECS)}
            >
              <div
                className="h-full rounded-full bg-accent transition-all duration-200"
                style={{ width: `${(Math.min(recSecs, REC_MAX_SECS) / REC_MAX_SECS) * 100}%` }}
              />
            </div>
          ) : null}
          {busy ? <p className="mt-1.5 text-center text-[11px] text-ink-3">识别中…</p> : null}
        </div>
      </aside>
    </>,
    document.body,
  );
}

/** 最简确认卡（心情 / 时间 / 退役转卖：只确认，无分类字段，不触发学习）。 */
function SimpleCard({
  title,
  lines,
  onConfirm,
  onCancel,
  done,
  remaining = 0,
  onNext,
}: {
  title: string;
  lines: string[];
  onConfirm: () => void;
  onCancel: () => void;
  /** ★v1.3.3：非空即完成态（卡片不消失，亮出【已完成】）。 */
  done?: string;
  remaining?: number;
  onNext?: () => void;
}) {
  const locked = Boolean(done);
  return (
    <section
      className={`rounded-card border p-3.5 ${
        locked ? 'border-[color-mix(in_srgb,var(--gui)_45%,transparent)] bg-[color-mix(in_srgb,var(--gui)_6%,var(--surface))]' : 'border-line bg-surface'
      }`}
      aria-label={title}
      data-done={locked ? '1' : '0'}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {locked ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white"
            style={{ background: 'var(--gui)' }}
            role="status"
          >
            <Check size={12} strokeWidth={3} aria-hidden />
            已完成
          </span>
        ) : null}
      </div>
      {lines.map((l, i) => (
        <p key={i} className="text-sm leading-5 text-ink-2">
          {l}
        </p>
      ))}
      {locked && done ? (
        <p className="mt-2 rounded-btn bg-surface px-2.5 py-1.5 text-[11px] leading-4 text-ink-2">{done}</p>
      ) : null}
      <div className="mt-3 flex gap-2">
        {locked ? (
          <button
            type="button"
            onClick={onNext ?? onCancel}
            className="h-10 flex-1 rounded-btn border border-line bg-surface-2 text-sm font-medium text-ink-2 active:scale-[0.99]"
          >
            {remaining > 0 ? `下一条（剩 ${remaining} 条）` : '完成'}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onCancel}
              className="h-10 flex-1 rounded-btn border border-line bg-surface-2 text-sm font-medium text-ink-2 active:scale-[0.99]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="h-10 flex-[2] rounded-btn bg-accent text-sm font-semibold text-white active:opacity-90"
            >
              确认保存
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** 时间 / 退役转卖的一行摘要。 */
function plainSummary(item: AiResultItem): string {
  if (item.action === 'create_time' && item.timeDraft) {
    const min = item.timeDraft.durationMin;
    return `记录 ${min >= 60 ? `${(min / 60).toFixed(1)} 小时` : `${min} 分钟`}${item.timeDraft.note ? ` · ${item.timeDraft.note}` : ''}`;
  }
  if (item.action === 'retire_sell' && item.retireDraft) {
    return `「${item.retireDraft.match}」标记退役，转卖价 ¥${item.retireDraft.sellPrice}`;
  }
  return item.explanation ?? '确认保存这条记录';
}

/** 退役草稿 → 卡片初值。
 *
 * ★v1.3.8「预填 + 核对」模式：说话人没提到的费用，用物品上**已经存过的**
 * 手续费费率 / 快递费 / 杂费自动补齐——用户只需核对金额，不用重填一遍。
 * 识别结果里明确说了的费用永远优先（用户这次说的和上次不一样很正常）。
 */
function goodsFeePreset(g?: Goods): { feeRatePermille: number; shippingFee: number; extraFee: number } {
  const fees = g?.extraFees ?? [];
  const ship = fees.find((f) => /快递|运费|邮费|物流/.test(f.name))?.amount ?? 0;
  const extra = fees
    .filter((f) => f.name !== '手续费' && !/快递|运费|邮费|物流/.test(f.name))
    .reduce((a, f) => a + f.amount, 0);
  return { feeRatePermille: g?.feeRatePermille ?? 0, shippingFee: ship, extraFee: round(extra, 2) };
}

function retireInitialOf(d: RetireDraft, g?: Goods): RetireCardState {
  const pre = goodsFeePreset(g);
  // 老数据只存过手续费金额、没有费率：按当时的售价反推费率，统一成「费率」口径
  let rate = d.feeRatePermille || pre.feeRatePermille;
  if (!rate) {
    const manual = (g?.extraFees ?? []).find((f) => f.name === '手续费')?.amount ?? 0;
    const sp = d.sellPrice || g?.sellPrice || 0;
    if (manual > 0 && sp > 0) rate = round((manual / sp) * 1000, 4);
  }
  return {
    sellPrice: d.sellPrice || g?.sellPrice || 0,
    feeRatePermille: rate,
    shippingFee: d.shippingFee || pre.shippingFee,
    extraFee: d.extraFee || pre.extraFee,
  };
}

/**
 * 旧的 `autoGrowTextarea` 曾定义在这里（直接改 style.height，不保存光标）。
 * ★v1.6.4 已整体上移到 lib/caretGuard.ts —— 那里先记光标、改完立刻恢复、
 * 并在 requestAnimationFrame 里再确认一次。**禁止在本文件重新写一份裸的
 * 高度自适应**，否则「光标跳末尾」会立刻复发。
 */

/**
 * 输入框自动撑高（★光标安全 · v1.6.4）。
 *
 * 为什么不能直接用 scrollHeight 赋值：见 lib/caretGuard.ts 文件头（含原生层成因）。
 * 这里保留一层具名封装，是为了让后续维护者一眼看到「这里做的是光标安全的自适应」。
 */
function growInput(el: HTMLTextAreaElement): void {
  autoGrowTextarea(el);
}
