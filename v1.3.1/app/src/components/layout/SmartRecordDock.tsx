import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, Keyboard, MessageCircle, Mic, Send, X } from 'lucide-react';
import { useBackGuard } from '../../lib/backGuard';
import { today as todayStr } from '../../lib/date';
import { emojiForName } from '../../lib/emoji';
import { aiConfigOf, isAiConfigured, parse, parseImage, parseLocalOnly } from '../../ai/parseService';
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
import { onOpenSmartRecord } from '../../lib/smartRecordBus';
import SmartRecordCard, { type RecordCardState } from './SmartRecordCard';
import { toastError, toastSuccess, useDataStore, useSettingsStore } from '../../store';
import type { AiResultItem } from '../../types/ai';
import type { Category, Goods } from '../../types/entities';

/**
 * ★v1.2.0 对话式智能记录入口（PRD：对话式智能记录入口改造 V1.0）。
 *
 * - 悬浮气泡按钮：桌面端固定在视窗右下角；移动端固定在底部导航上方一点（右侧）。
 * - 面板从右侧滑出：顶部「智能记录」标题 + 会话区 + 底部微信式输入区
 *   （语音/文字切换 · 按住说话 · 识图 · 发送）。
 * - 发送一句话 →
 *   ① 查询意图（「昨天买了什么 / 心情怎么样」）→ 基于本地数据回答，不弹卡；
 *   ② 否则解析（本地规则优先，配了 AI 才回落 AI）→ **逐条弹确认卡片**兜底；
 *      用户只改金额/名称/时间 → 正常保存；**改了大类或小类 → 自动学习**。
 * - 连发多条：每条都会依次识别出卡；发新消息时上一条未确认的卡片按放弃处理
 *   （不保存、不学习），不需要用户先点取消。
 */

/* ---------------- 工具 ---------------- */

/** 会话消息。 */
interface ChatMsg {
  id: number;
  role: 'sys' | 'user';
  text: string;
}

/** 待确认项：记录卡（三大类）/ 心情卡 / 其它（时间、退役转卖，只确认不学习）。seq 由 applyPending 填充。 */
type Pending =
  | { mode: 'record'; text: string; item: AiResultItem; init: RecordCardState; seq?: number }
  | { mode: 'mood'; text: string; item: AiResultItem; seq?: number }
  | { mode: 'plain'; text: string; item: AiResultItem; seq?: number };

/** 生活流 note 可能带「早饭·」前缀，卡片名称里去掉。 */
function nameOfLedger(note: string): string {
  return (note ?? '').replace(/^[早午晚宵夜下上]{1,2}[饭餐茶]·/, '').trim();
}

/** 按住说话的计时显示：0:03 / 1:05。 */
function fmtRecSecs(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * ★v1.3.1 当前是否跑在 Capacitor 原生容器（APP）里。
 * 语音识别报错文案要分场景：APP 内引导系统设置，浏览器引导地址栏授权。
 * 用 window 探测而非 import，与 theme.ts 保持一致（jsdom 测试环境零依赖）。
 */
function inNativeApp(): boolean {
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
  return w.Capacitor?.isNativePlatform?.() === true;
}

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
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="智能记录"
        title="智能记录"
        className={`fixed z-30 flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface/85 text-accent shadow-lg backdrop-blur transition-transform active:scale-95 ${
          mode === 'desktop' ? 'bottom-6 right-6' : 'right-3'
        }`}
        style={mode === 'desktop' ? undefined : { bottom: 'calc(env(safe-area-inset-bottom) + 104px)' }}
      >
        <MessageCircle size={22} strokeWidth={1.8} aria-hidden />
      </button>
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

  /** 非受控输入框（IME 铁律）：DOM 自持值，发送时读真值。 */
  const inputRef = useRef<HTMLInputElement | null>(null);
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
  /** 发送串行链：连发消息依次处理，绝不被 busy 吞掉、也不会乱序。 */
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  /** 防双击/双触发：400ms 内同一文本只入队一次（正常手动重发不受影响）。 */
  const lastSentRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  /** 按住说话：识别实例 / 最终转写 / 取消标志 / 按下时的 Y 坐标。 */
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const recFinalRef = useRef('');
  const recCancelRef = useRef(false);
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
      recRef.current?.abort();
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

  /** 按名称模糊定位物品（退役转卖用）。 */
  const findGoods = (match: string): Goods | undefined => {
    const key = (match ?? '').trim();
    if (!key) return undefined;
    const hit = goods.filter((g) => g.name.includes(key) || key.includes(g.name));
    if (hit.length === 0) return undefined;
    return hit.sort((a, b) => {
      if ((a.status === 'retired') !== (b.status === 'retired')) return a.status === 'retired' ? 1 : -1;
      return b.name.length - a.name.length;
    })[0];
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
      pushMsg('sys', '这条内容暂不支持在智能记录里直接保存，请到「AI 记一笔」处理');
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
    if (inputRef.current) inputRef.current.value = '';

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
        pushMsg(
          'sys',
          learned
            ? `已学会：「${learned.rule.keyword}」这类说法归到 ${KIND_LABEL[state.kind]} · ${cat.name}，下次直接归对`
            : `已按 ${KIND_LABEL[state.kind]} · ${cat.name} 保存`,
        );
      }
      toastSuccess('已保存');
    } catch (e) {
      toastError((e as Error).message || '保存失败');
      return;
    }
    showNext(items);
  };

  /** 确认保存（心情 / 时间 / 退役转卖：只保存，不学习）。 */
  const confirmPlain = async (): Promise<void> => {
    if (!pendingRef.current || pendingRef.current.mode === 'record') return;
    const { item } = pendingRef.current;
    try {
      if (pendingRef.current.mode === 'mood' && item.moodDraft) {
        await addMood({ feeling: item.moodDraft.feeling, text: item.moodDraft.text });
      } else if (item.action === 'create_time' && item.timeDraft) {
        await addTime({
          durationMin: item.timeDraft.durationMin,
          tags: item.timeDraft.tags ?? [],
          meaning: item.timeDraft.meaning,
          note: item.timeDraft.note,
        });
      } else if (item.action === 'retire_sell' && item.retireDraft) {
        const target = findGoods(item.retireDraft.match);
        if (!target) {
          toastError(`没找到与「${item.retireDraft.match}」匹配的物品，请先入库`);
          return;
        }
        await updateGoods(target.id, { status: 'retired', sellPrice: item.retireDraft.sellPrice });
        const res = await syncSaleIncome(target.id);
        toastSuccess(
          res.action === 'created' || res.action === 'updated'
            ? `已退役，转卖净赚 ¥${(res.amount ?? 0).toFixed(2)} 已记入生活流`
            : '已标记退役',
        );
        showNext(items);
        return;
      }
      toastSuccess('已保存');
    } catch (e) {
      toastError((e as Error).message || '保存失败');
      return;
    }
    showNext(items);
  };

  /* ---------------- 语音：微信式「按住 说话」 ---------------- */

  /** 按下「按住 说话」：启动 Web Speech 识别，松手/出错自动收尾。 */
  const beginRecognition = (): void => {
    // 双击/双 pointerdown 防护：已在识别中就直接忽略
    if (recActiveRef.current) return;
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) {
      toastError('当前环境不支持语音识别，请打字或用识图');
      return;
    }
    let rec: SpeechRecognitionLike;
    try {
      rec = new SR();
    } catch {
      toastError('语音启动失败，请直接打字');
      return;
    }
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.maxResults = 1;
    rec.onresult = (e) => {
      // 只取最后一条结果（interim 会被 final 原地替换，拼接会重复）
      const last = e.results?.[e.results.length - 1];
      const t = (last?.[0]?.transcript ?? '').trim();
      recFinalRef.current = t;
      setRecHint(t || '正在聆听…');
    };
    rec.onerror = (ev) => {
      finishRecognition();
      if (recCancelRef.current) return;
      const code = (ev as { error?: string } | undefined)?.error ?? '';
      // ★v1.3.1 报错文案分场景：APP 内（Capacitor 原生）引导系统设置，
      // 浏览器引导地址栏授权；网络类错误说明 HTTPS 要求
      const native = inNativeApp();
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        toastError(
          native
            ? '麦克风权限被拒绝：请到系统设置 → 应用 → 纳物 → 权限 里允许「麦克风」'
            : '麦克风权限被拒绝，请在浏览器地址栏允许麦克风',
        );
      } else if (code === 'network' || code === 'audio-capture') {
        toastError(
          native
            ? '语音识别服务连接失败，请检查网络后重试（也可直接打字）'
            : '当前浏览器/网络不支持语音识别（Chrome 需 HTTPS 环境），可打字或识图',
        );
      } else {
        toastError('语音识别失败，请再试或直接打字');
      }
    };
    rec.onend = () => {
      const cancelled = recCancelRef.current;
      const text = recFinalRef.current;
      finishRecognition();
      if (cancelled || !text || !aliveRef.current) return;
      enqueueSend(text);
    };
    recRef.current = rec;
    recFinalRef.current = '';
    recCancelRef.current = false;
    // 注意：recStartYRef 由 pointerdown 写入（上滑取消的基准），这里不能清零
    recStartAtRef.current = 0;
    try {
      rec.start();
    } catch {
      finishRecognition();
      toastError('语音启动失败，请直接打字');
      return;
    }
    // 启动成功：置运行标志 + 起计时器（进度条/秒数视觉反馈，
    // 治「长按无响应」——按下瞬间就有 0:00 与脉冲点）
    recActiveRef.current = true;
    setRecording(true);
    recStartAtRef.current = Date.now();
    setRecSecs(0);
    setRecHint('松开手指 发送');
    recTimerRef.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - recStartAtRef.current) / 1000);
      setRecSecs(s);
      if (s >= REC_MAX_SECS) {
        setRecHint(`已达 ${REC_MAX_SECS} 秒上限，自动发送`);
        recRef.current?.stop();
      }
    }, 250);
  };

  /** 收尾（清高亮、计时与提示）。 */
  const finishRecognition = (): void => {
    recActiveRef.current = false;
    if (recTimerRef.current) window.clearInterval(recTimerRef.current);
    recTimerRef.current = null;
    setRecSecs(0);
    setRecording(false);
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
        className={`nw-smart-enter nw-smart-panel fixed z-50 flex flex-col bg-surface shadow-2xl ${
          mode === 'mobile'
            ? 'nw-smart-sheet inset-x-0 bottom-0 max-h-[86vh] rounded-t-3xl'
            : 'inset-y-0 right-0 w-full max-w-md'
        }`}
        style={
          mode === 'mobile'
            ? { paddingBottom: 'env(safe-area-inset-bottom)' }
            : { top: 0, bottom: 0, right: 0, left: 'auto', paddingTop: 'env(safe-area-inset-top)' }
        }
        aria-label="智能记录"
      >
        {/* ★v1.3.1 移动端抽屉把手（视觉提示：可下滑关闭的底部抽屉） */}
        {mode === 'mobile' ? (
          <div className="flex shrink-0 justify-center pt-2">
            <span className="h-1 w-9 rounded-full bg-line-2" aria-hidden />
          </div>
        ) : null}

        {/* 顶部标题栏 */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <span className="text-sm font-semibold">智能记录</span>
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
              <p
                className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-sm leading-5 ${
                  m.role === 'user' ? 'bg-accent text-white' : 'bg-surface-2 text-ink-2'
                }`}
              >
                {m.text}
              </p>
            </div>
          ))}
        </div>

        {/* 确认卡片区（浮在会话内容下方、输入框上方） */}
        {pending ? (
          <div className="max-h-[62%] shrink-0 overflow-y-auto border-t border-line bg-surface-2/60 p-3">
            {pending.mode === 'record' ? (
              <SmartRecordCard
                key={pending.seq ?? 0}
                initial={pending.init}
                categories={categories}
                onConfirm={(s) => void confirmRecord(s)}
                onCancel={() => showNext(items)}
              />
            ) : pending.mode === 'mood' ? (
              <SimpleCard
                title="记录心情"
                lines={[`${pending.item.moodDraft?.feeling ?? '🙂'} ${pending.item.moodDraft?.text ?? ''}`]}
                onConfirm={() => void confirmPlain()}
                onCancel={() => showNext(items)}
              />
            ) : (
              <SimpleCard
                title={pending.item.action === 'retire_sell' ? '退役转卖确认' : '时间记录确认'}
                lines={
                  pending.item.action === 'retire_sell'
                    ? [plainSummary(pending.item), '确认后自动扣减：摊销定格在退役日，转卖净赚记入生活流']
                    : [plainSummary(pending.item)]
                }
                onConfirm={() => void confirmPlain()}
                onCancel={() => showNext(items)}
              />
            )}
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
              onClick={() => setVoiceMode((v) => !v)}
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
                  beginRecognition();
                }}
                onPointerMove={(e) => {
                  if (!recActiveRef.current) return;
                  setRecHint(recStartYRef.current - e.clientY > 60 ? '抬起手指 取消' : '松开手指 发送');
                }}
                onPointerUp={(e) => {
                  // ★v1.3.1 读 ref 不读 state：快速点按时 setRecording 还没渲染完，
                  // 闭包里 recording 仍是 false 会漏收尾（识别挂着不发送）
                  if (!recActiveRef.current) return;
                  if (recStartYRef.current - e.clientY > 60) {
                    recCancelRef.current = true;
                    recRef.current?.abort();
                    finishRecognition();
                  } else {
                    recRef.current?.stop();
                  }
                }}
                onPointerCancel={() => {
                  recCancelRef.current = true;
                  recRef.current?.abort();
                  finishRecognition();
                }}
              >
                {recording ? (
                  <span className="flex w-full items-center justify-center gap-2 px-2">
                    {/* 脉冲点：麦克风已启动的即时视觉确认 */}
                    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
                    <span className="shrink-0 font-semibold tabular-nums">{fmtRecSecs(recSecs)}</span>
                    <span className="truncate">{recHint || '正在聆听…'}</span>
                  </span>
                ) : (
                  '按住 说话'
                )}
              </button>
            ) : (
              <input
                ref={inputRef}
                defaultValue=""
                placeholder="一句话描述消费/心情…"
                enterKeyHint="send"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    sendFromInput();
                  }
                }}
                className="h-10 min-w-0 flex-1 rounded-btn border border-line bg-surface-2 px-3 text-sm outline-none focus:border-accent"
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
}: {
  title: string;
  lines: string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="rounded-card border border-line bg-surface p-3.5" aria-label={title}>
      <h3 className="mb-1.5 text-sm font-semibold">{title}</h3>
      {lines.map((l, i) => (
        <p key={i} className="text-sm leading-5 text-ink-2">
          {l}
        </p>
      ))}
      <div className="mt-3 flex gap-2">
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

/** Web Speech API 最小结构（避免依赖具体 DOM lib 版本的类型名）。 */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxResults: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
