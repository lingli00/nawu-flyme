import { useRef, useState, useEffect } from 'react';
import { Camera } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PageShell from '../components/layout/PageShell';
import PageField from '../components/ui/PageField';
import { useDataStore, useSettingsStore, toastSuccess, toastError } from '../store';
import { parse, parseImage } from '../ai/parseService';
import { convertItem, switchableKindOf, SWITCH_KINDS } from '../ai/convert';
import { warmUpOcr } from '../lib/localOcr';
import { today } from '../lib/date';
import type { AiResultItem } from '../types/ai';
import type { Category, Goods, Settings, Subscription } from '../types/entities';

/**
 * P10 + P11 AI 助手：一句话记账 → 解析结果逐条确认 → 落库。
 * 未配置 AI 时自动用本地规则解析（parse 内部已兜底）。
 *
 * ★修复 v1.0.0（输入框中间插字被顶到末尾）：本页输入框原为受控 `value/onChange`，
 * 在 Android WebView 的中文输入法（IME 组合输入）下 React state 与 DOM 值不同步，
 * 每次按键 React 把 value 写回 → 光标被顶到末尾，导致只能整段删掉重输。
 * 现改为**非受控**（DOM 自持值，提交时用 ref 读真值），
 * 与登录页同一套方案（见 LoginPage 顶部注释）；光标位置由浏览器自己维护，不再被劫持。
 */
export default function AiPage() {
  const nav = useNavigate();
  const categories = useDataStore((s) => s.categories);
  const goods = useDataStore((s) => s.goods);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const addLedger = useDataStore((s) => s.addLedger);
  const addLedgerMany = useDataStore((s) => s.addLedgerMany);
  const addGoods = useDataStore((s) => s.addGoods);
  const updateGoods = useDataStore((s) => s.updateGoods);
  const syncSaleIncome = useDataStore((s) => s.syncSaleIncome);
  const addSubscription = useDataStore((s) => s.addSubscription);
  const addMood = useDataStore((s) => s.addMood);
  const addTime = useDataStore((s) => s.addTime);

  /** 非受控输入框：DOM 自持值，解析时读真值（Android WebView 下唯一可靠来源）。 */
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  /** 仅用于「开始解析」按钮的禁用态（不回写 value，绝不碰受控同步链路）。 */
  const [hasText, setHasText] = useState(false);
  const [busy, setBusy] = useState(false);

  /** ★v1.1.3 AI 未配置时的内嵌设置卡：就地配好即刻生效，不用跑去设置页再回来。
   *  需求原点：「我设置好 API，它到时候不能一下子使用就很麻烦」。 */
  const aiReady = Boolean(settings.aiEndpoint?.trim() && settings.aiKey?.trim());
  const [aiDraft, setAiDraft] = useState({
    endpoint: settings.aiEndpoint ?? '',
    key: settings.aiKey ?? '',
    model: settings.aiModel ?? '',
  });
  const saveAiInline = async (): Promise<void> => {
    const endpoint = aiDraft.endpoint.trim().replace(/\/+$/, '');
    const key = aiDraft.key.trim();
    if (!endpoint || !key) {
      toastError('接口地址和 API Key 都要填');
      return;
    }
    await updateSettings({ aiEndpoint: endpoint, aiKey: key, aiModel: aiDraft.model.trim() });
    toastSuccess('AI 配置已保存，即刻生效');
  };

  // 本地 OCR 预热：进页即后台初始化 wasm + 中文语言包，点识图时省 1-2s（失败静默）
  useEffect(() => {
    warmUpOcr();
  }, []);
  const [items, setItems] = useState<AiResultItem[] | null>(null);
  const [source, setSource] = useState<'ai' | 'local'>('local');
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState<boolean[]>([]);
  /* —— 识图添加（v1.0.10）：拍照/相册 → vision 解析 → 复用下方确认落库流程 —— */
  const ocrInputRef = useRef<HTMLInputElement | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);

  /** 压到长边 1024 的 JPEG dataURL（vision 上传体积可控）。 */
  const compressForOcr = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片解码失败'));
        img.onload = () => {
          const max = 1024;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const cv = document.createElement('canvas');
          cv.width = Math.round(img.width * scale);
          cv.height = Math.round(img.height * scale);
          const ctx2d = cv.getContext('2d');
          if (!ctx2d) return reject(new Error('画布不可用'));
          ctx2d.drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/jpeg', 0.85));
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });

  const runOcr = async (file: File | undefined): Promise<void> => {
    if (!file || ocrBusy || busy) return;
    setOcrBusy(true);
    try {
      const dataUrl = await compressForOcr(file);
      const out = await parseImage(dataUrl, {
        categories,
        settings: settings as Settings,
        today: today(),
      });
      if (out.items.length === 0) {
        toastError(out.reason ?? '图中没有识别出可记账的内容');
        return;
      }
      setItems(out.items);
      setSource(out.source);
      setReason(out.reason ?? '由照片识别');
      setChecked(out.items.map(() => true));
      toastSuccess(`从图片识别出 ${out.items.length} 条，请确认`);
    } catch (e) {
      toastError((e as Error).message || '识图失败，请稍后再试');
    } finally {
      setOcrBusy(false);
      if (ocrInputRef.current) ocrInputRef.current.value = '';
    }
  };

  /** 读取输入框当前 DOM 真值。 */
  const readText = (): string => textRef.current?.value ?? '';

  const run = async () => {
    const text = readText();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const out = await parse(text, {
        categories,
        settings: settings as Settings,
        today: today(),
      });
      if (out.items.length === 0) {
        toastError('没有识别出可以记录的内容，试着说「花了多少钱」');
        setBusy(false);
        return;
      }
      setItems(out.items);
      setSource(out.source);
      setReason(out.reason ?? '');
      setChecked(out.items.map(() => true));
    } catch (e) {
      toastError((e as Error).message);
    }
    setBusy(false);
  };

  /** ★v1.0.27 切换某条结果的类型（生活/物品/订阅），转换只搬运可复用信息。 */
  const switchKind = (i: number, target: ReturnType<typeof switchableKindOf>) => {
    if (!items || !target) return;
    setItems(items.map((it, j) => (j === i ? convertItem(it, target, categories, today()) : it)));
  };

  const catOf = (id: string): Category | undefined => categories.find((c) => c.id === id);

  /** ★v1.1.3 按名称模糊定位物品（双向包含；优先在役、名称更具体者）。 */
  const findGoods = (match: string): Goods | undefined => {
    const key = match.trim();
    if (!key) return undefined;
    const hit = goods.filter((g) => g.name.includes(key) || key.includes(g.name));
    if (hit.length === 0) return undefined;
    return hit.sort((a, b) => {
      if ((a.status === 'retired') !== (b.status === 'retired')) return a.status === 'retired' ? 1 : -1;
      return b.name.length - a.name.length;
    })[0];
  };

  /** 把勾选的结果落库。 */
  const commit = async () => {
    if (!items) return;
    const chosen = items.filter((_, i) => checked[i]);
    if (chosen.length === 0) return;

    // 先收集 ledger 草稿，能合并的用 addLedgerMany 一次写入
    const ledgerDrafts = chosen
      .filter((it) => it.action === 'create_ledger' && it.ledgerDraft)
      .map((it) => it.ledgerDraft!);
    // 记下第一条新建的物品/订阅（落库返回带 id），跳过去让用户立即编辑
    let createdGoods: Goods | null = null;
    let createdSub: Subscription | null = null;
    let retiredSale = 0;
    for (const it of chosen) {
      if (it.action === 'create_goods' && it.goodsDraft) {
        const g = await addGoods(it.goodsDraft);
        createdGoods = createdGoods ?? g;
      }
      if (it.action === 'create_subscription' && it.subDraft) {
        const s = await addSubscription(it.subDraft);
        createdSub = createdSub ?? s;
      }
      if (it.action === 'create_mood' && it.moodDraft) await addMood({ ...it.moodDraft });
      if (it.action === 'create_time' && it.timeDraft) await addTime({ ...it.timeDraft });
      // ★v1.1.3 退役转卖真正落库：定位物品 → 退役 + 出售价 → 净赚同步生活流收入
      if (it.action === 'retire_sell' && it.retireDraft) {
        const target = findGoods(it.retireDraft.match);
        if (!target) {
          toastError(`没找到与「${it.retireDraft.match}」匹配的物品，请先入库或去首页手动标记`);
          continue;
        }
        await updateGoods(target.id, { status: 'retired', sellPrice: it.retireDraft.sellPrice });
        const res = await syncSaleIncome(target.id);
        if (res.action === 'created' || res.action === 'updated') retiredSale += res.amount ?? 0;
      }
    }
    if (ledgerDrafts.length === 1) await addLedger(ledgerDrafts[0]);
    else if (ledgerDrafts.length > 1) await addLedgerMany(ledgerDrafts);

    toastSuccess(
      retiredSale > 0
        ? `已记录 ${chosen.length} 条，转卖净赚 ¥${retiredSale.toFixed(2)} 已记入生活流`
        : `已记录 ${chosen.length} 条`,
    );
    // 物品 → 首页物品 tab 并自动弹编辑面板；订阅 → 首页订阅 tab 并自动弹编辑；
    // 其余（纯生活流/情绪/时间）保持原跳生活流。
    if (createdGoods) {
      nav('/home', { replace: true, state: { editGoodsId: createdGoods.id } });
      return;
    }
    if (createdSub) {
      nav('/home', { replace: true, state: { editSubId: createdSub.id } });
      return;
    }
    nav('/ledger', { replace: true });
  };

  /** 单条结果的摘要文案。 */
  const summaryOf = (it: AiResultItem): string => {
    switch (it.action) {
      case 'create_ledger': {
        const d = it.ledgerDraft!;
        const cat = catOf(d.categoryId);
        return `${d.type === 'income' ? '收入' : '支出'} ¥${d.amount} · ${cat ? cat.name : d.categoryId} · ${d.judgement === 'gui' ? '归' : d.judgement === 'xu' ? '需' : '否'} · ${d.date}`;
      }
      case 'create_goods':
        return `新增物品 ${it.goodsDraft!.name} ¥${it.goodsDraft!.price}`;
      case 'create_subscription':
        return `新增订阅 ${it.subDraft!.name} ¥${it.subDraft!.amount}/${it.subDraft!.period === 'month' ? '月' : it.subDraft!.period === 'year' ? '年' : '周'}`;
      case 'create_mood':
        return `情绪 ${it.moodDraft!.feeling} ${it.moodDraft!.text}`;
      case 'create_time':
        return `时间 ${it.timeDraft!.durationMin} 分钟`;
      case 'retire_sell':
        return `退役转卖 ${it.retireDraft!.match} ¥${it.retireDraft!.sellPrice}`;
      default:
        return it.explanation ?? '未知内容';
    }
  };

  return (
    <PageShell title="AI 记一笔" onBack={() => nav(-1)}>
      {/* PC 桌面：内容居中收窄，避免整页拉伸 */}
      <div className="mx-auto w-full max-w-2xl">
      <div className="rounded-card border border-line bg-surface p-4">
        <textarea
          ref={textRef}
          defaultValue=""
          onInput={(e) => setHasText(e.currentTarget.value.trim().length > 0)}
          rows={4}
          placeholder={'像说话一样描述就行，例如：\n今天早上吃了油条包子花了30，然后坐火车花了60去桐柏'}
          className="w-full resize-none rounded-btn border border-line bg-surface-2 p-3 text-sm leading-6 outline-none focus:border-accent"
        />
        <div className="mt-2 flex gap-2">

          <button

            type="button"

            onClick={() => ocrInputRef.current?.click()}

            disabled={ocrBusy || busy}

            className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-btn border border-line bg-surface-2 text-xs text-ink-2 active:bg-surface disabled:opacity-50"

          >

            <Camera size={14} strokeWidth={1.8} aria-hidden />

            {ocrBusy ? '识别中…' : '拍照 / 相册识图添加'}

          </button>

          <input

            ref={ocrInputRef}

            type="file"

            accept="image/*"

            className="hidden"

            onChange={(e) => void runOcr(e.target.files?.[0])}

          />

        </div>

        <div className="mt-2 flex items-center justify-between">
          <p className="text-[11px] text-ink-3">
            {aiReady ? 'AI 模式' : '本地规则模式（下方可配 AI）'}
          </p>
          <button
            onClick={run}
            disabled={!hasText || busy}
            className="h-10 rounded-full bg-accent px-6 text-sm font-semibold text-white active:opacity-90 disabled:opacity-40"
          >
            {busy ? '解析中…' : '开始解析'}
          </button>
        </div>
      </div>

      {/* ★v1.1.3 未配置 AI → 内嵌设置卡：就地填、保存即生效，不用跳设置页再回来 */}
      {aiReady ? null : (
        <div className="mt-3 rounded-card border border-line bg-surface p-4">
          <p className="text-sm font-semibold">配置 AI，识别更准</p>
          <p className="mt-1 text-[11px] leading-5 text-ink-3">
            当前是本地规则模式：离线可用，但分句和金额靠关键词猜。填入 OpenAI
            兼容接口后，「AI 记一笔」与报表页「AI 分析」都会走 AI。Key 只保存在本机，直连第三方、不经服务器。
          </p>
          <div className="mt-3 space-y-2.5">
            <PageField label="接口地址 Endpoint">
              <input
                value={aiDraft.endpoint}
                onChange={(e) => setAiDraft((d) => ({ ...d, endpoint: e.target.value }))}
                placeholder="https://api.example.com/v1"
                autoCapitalize="off"
                className="h-10 w-full nw-input"
              />
            </PageField>
            <PageField label="API Key">
              <input
                value={aiDraft.key}
                onChange={(e) => setAiDraft((d) => ({ ...d, key: e.target.value }))}
                type="password"
                placeholder="sk-…"
                autoCapitalize="off"
                className="h-10 w-full nw-input"
              />
            </PageField>
            <PageField label="模型">
              <input
                value={aiDraft.model}
                onChange={(e) => setAiDraft((d) => ({ ...d, model: e.target.value }))}
                placeholder="例如 gpt-4o-mini"
                autoCapitalize="off"
                className="h-10 w-full nw-input"
              />
            </PageField>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void saveAiInline()}
              className="h-10 flex-1 rounded-btn bg-accent text-sm font-semibold text-white active:opacity-90"
            >
              保存并启用
            </button>
            <button
              onClick={() => nav('/settings')}
              className="h-10 rounded-btn border border-line px-4 text-sm text-ink-2 active:bg-surface-2"
            >
              去设置页
            </button>
          </div>
        </div>
      )}

      {items ? (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold">
              识别出 {items.length} 条
              <span className="ml-1.5 text-[11px] font-normal text-ink-3">
                （{source === 'ai' ? 'AI 解析' : '本地规则'}
                {reason ? ` · ${reason}` : ''}）
              </span>
            </h2>
            <button
              onClick={() => setChecked(checked.every(Boolean) ? checked.map(() => false) : checked.map(() => true))}
              className="text-xs text-accent"
            >
              {checked.every(Boolean) ? '全不选' : '全选'}
            </button>
          </div>

          <ul className="space-y-2">
            {items.map((it, i) => (
              <li
                key={i}
                className={`flex items-start gap-3 rounded-card border p-3.5 ${
                  checked[i] ? 'border-accent bg-surface' : 'border-line bg-surface opacity-50'
                }`}
                onClick={() => setChecked(checked.map((c, j) => (j === i ? !c : c)))}
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                    checked[i] ? 'border-accent bg-accent text-white' : 'border-line-2'
                  }`}
                >
                  ✓
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{summaryOf(it)}</p>
                  {it.explanation ? (
                    <p className="mt-0.5 text-xs leading-5 text-ink-3">{it.explanation}</p>
                  ) : null}
                  {(() => {
                    // ★v1.0.27 生活/物品/订阅 三类切换：识别错了当场改，不用去对应页面手工调
                    const kind = switchableKindOf(it);
                    if (!kind) return null;
                    return (
                      <div className="mt-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <span className="text-[11px] text-ink-3">记为</span>
                        {SWITCH_KINDS.map(({ kind: k, label }) => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => switchKind(i, k)}
                            className={`rounded-full border px-2.5 py-0.5 text-[11px] leading-5 ${
                              kind === k
                                ? 'border-accent bg-accent text-white'
                                : 'border-line-2 text-ink-2 active:bg-surface-2'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </li>
            ))}
          </ul>

          <button
            onClick={commit}
            disabled={!checked.some(Boolean)}
            className="mt-4 mb-2 h-12 w-full rounded-btn bg-accent text-base font-semibold text-white active:opacity-90 disabled:opacity-40"
          >
            记下选中的 {checked.filter(Boolean).length} 条
          </button>
        </div>
      ) : (
        <div className="mt-4 rounded-card border border-dashed border-line bg-surface p-4">
          <p className="text-xs font-medium text-ink-2">可以这样说</p>
          <ul className="mt-2 space-y-1.5">
            {[
              '今天早上吃了油条包子花了30',
              '然后坐火车花了60去桐柏',
              '在闲鱼买了魅族20花了两千',
              '开了个B站会员25',
              '把魅族20卖了1400',
            ].map((s) => (
              <li key={s}>
                <button
                  onClick={() => {
                    const el = textRef.current;
                    if (!el) return;
                    // 非受控：直接写 DOM 追加示例句，光标位置由浏览器保持
                    el.value = el.value ? `${el.value}${s}` : s;
                    setHasText(true);
                    el.focus();
                  }}
                  className="text-xs text-accent"
                >
                  「{s}」
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      </div>
    </PageShell>
  );
}
