import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock } from 'lucide-react';
import PageShell from '../components/layout/PageShell';
import PageField from '../components/ui/PageField';
import { useAuthStore, useDataStore, useUiStore, currentServer, toastSuccess, toastError } from '../store';
import { getRules, saveRules } from '../api/user';
import { loadLearnedRules, loadLearnSamples, removeLearnedRule } from '../api/learnedRules';
import { KIND_LABEL, displayCoWords, type LearnSample, type LearnedRule } from '../ai/ruleBank';
import { toJudgement } from '../lib/emoji';
import type { Category, Judgement } from '../types/entities';

/**
 * P25 识别规则编辑：教 AI 识记账——命中关键词的记录自动归类。
 *
 * ★规则结构结论（本页采用 `{ keyword, category, judgement }` 数组的依据）：
 * - 后端 Api.php：`/api/user/rules` 的 rules 只校验「非 null 时必须是数组、JSON ≤200KB」，
 *   形状本身后端不约束（payload 原样 JSON 存取，GET 返回 {rules, updated_at}）；
 * - App 本地解析：`src/ai/localParser.ts` 目前**不消费** rules（`K_PARSE_RULES` 键已定义但无读取方）；
 * - 因此本页按页面 UI 语义（关键词 → 分类 · 归/需/否）取最小互通结构，
 *   与网页版互通靠云端的同一 payload；App 本地解析后续消费时可直接对号入座。
 *   页内已注明「保存后云同步生效」。
 */

/** 单条识别规则（与网页版 `flyme.parse.rules` 云端镜像互通）。 */
export interface ParseRule {
  /** 命中关键词（包含匹配即生效）。 */
  keyword: string;
  /** 归入的生活流分类名（如「餐饮」）。 */
  category: string;
  /** 归 / 需 / 否。 */
  judgement: Judgement;
}

const JUDGEMENT_OPTIONS: Array<[Judgement, string]> = [
  ['gui', '归'],
  ['xu', '需'],
  ['fou', '否'],
];

const JUDGEMENT_LABEL: Record<Judgement, string> = { gui: '归', xu: '需', fou: '否' };

/** 防御式归一：后端只保证是数组（或 null），逐条挑字段并给默认值。 */
function normalizeRules(raw: unknown): ParseRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((it): it is Record<string, unknown> => Boolean(it) && typeof it === 'object')
    .map((it) => ({
      keyword: typeof it.keyword === 'string' ? it.keyword.trim() : '',
      category: typeof it.category === 'string' ? it.category.trim() : '',
      judgement: toJudgement(it.judgement, 'xu'),
    }))
    .filter((r) => r.keyword && r.category);
}

/** 新增/编辑单条规则的小弹层（portal，与 CategoryPage 同模式）。 */
function RuleFormSheet({
  editing,
  ledgerCats,
  onClose,
  onSubmit,
}: {
  editing?: ParseRule;
  ledgerCats: Category[];
  onClose: () => void;
  onSubmit: (rule: ParseRule) => void;
}) {
  const isEdit = Boolean(editing);
  // ★关键词输入非受控（Android WebView IME 铁律）：defaultValue + ref 读 DOM 真值，
  // 受控 value/onChange 在 IME 组合输入下 state 与界面脱节（登录页恶性 bug 同源）。
  const keywordRef = useRef<HTMLInputElement | null>(null);
  // 分类是原生 <select>、judgement 是按钮组，均无 IME 参与，保持受控即可。
  const [category, setCategory] = useState(editing?.category ?? ledgerCats[0]?.name ?? '其他');
  const [judgement, setJudgement] = useState<Judgement>(editing?.judgement ?? 'xu');

  const submit = () => {
    const kw = (keywordRef.current?.value ?? '').trim();
    if (!kw) {
      toastError('请输入关键词');
      keywordRef.current?.focus();
      return;
    }
    if (!category) {
      toastError('请选择归类分类');
      return;
    }
    onSubmit({ keyword: kw, category, judgement });
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={onClose}>
      <div
        className="sheet-enter mx-auto max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}
      >
        <h2 className="mb-3 text-base font-semibold">{isEdit ? '编辑规则' : '新增规则'}</h2>
        <div className="space-y-3">
          <PageField label="关键词" hint="AI 记账文本包含该词时按下方规则归类">
            <input
              ref={keywordRef}
              defaultValue={editing?.keyword ?? ''}
              placeholder="例如 星巴克"
              enterKeyHint="done"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-11 w-full nw-input"
            />
          </PageField>

          <PageField label="归类为">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-11 w-full nw-input"
            >
              {ledgerCats.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.icon} {c.name}
                </option>
              ))}
            </select>
          </PageField>

          <PageField label="归 / 需 / 否">
            <div className="flex gap-1">
              {JUDGEMENT_OPTIONS.map(([j, label]) => (
                <button
                  key={j}
                  type="button"
                  onClick={() => setJudgement(j)}
                  className={`h-10 flex-1 rounded-btn border text-sm ${
                    judgement === j ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-ink-2'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </PageField>

          <button onClick={submit} className="h-11 w-full rounded-btn bg-accent text-sm font-semibold text-white">
            {isEdit ? '保存规则' : '添加规则'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * ★v1.2.0 本地自学习规则管理（PRD 六.3：学错了能回退）。
 *
 * 展示「智能记录 / AI 记一笔」里用户手动纠正分类后自动学到的规则，
 * 数据只存本机（`flyme.parse.learned`），不登录也能查看/删除。
 */
function LearnedRuleSection() {
  const [rules, setRules] = useState<LearnedRule[]>([]);
  const [samples, setSamples] = useState<LearnSample[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = (): void => {
    void Promise.all([loadLearnedRules(), loadLearnSamples()]).then(([r, s]) => {
      setRules(r);
      setSamples(s);
      setLoaded(true);
    });
  };

  useEffect(reload, []);

  const removeAt = async (rule: LearnedRule): Promise<void> => {
    const ok = await useUiStore.getState().confirm({
      title: '删除这条学会的规则？',
      message: `「${rule.keyword} → ${KIND_LABEL[rule.kind]} · ${rule.categoryName}」删除后，类似输入会回落到默认规则。`,
    });
    if (!ok) return;
    await removeLearnedRule(rule.id);
    toastSuccess('已删除该规则');
    reload();
  };

  return (
    <section className="mt-6">
      <h2 className="mb-1 px-1 text-sm font-semibold">本地自学习规则</h2>
      <p className="mb-3 px-1 text-xs leading-5 text-ink-3">
        你在确认卡片上改过的分类，会自动学成规则存在本机（不上云），以后相似说法直接按规则归类。学错了在这里删掉即可。
      </p>
      <ul className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface">
        {!loaded ? (
          <li className="px-3.5 py-8 text-center text-sm text-ink-3">正在加载…</li>
        ) : rules.length === 0 ? (
          <li className="px-3.5 py-8 text-center text-sm text-ink-3">
            还没有学到的规则。在「智能记录」里把分类改对一次，这里就会出现对应规则
          </li>
        ) : (
          rules.map((r) => {
            const coWords = displayCoWords(r.coWords);
            const sample = samples.find((s) => s.ruleId === r.id);
            return (
              <li key={r.id} className="flex items-start gap-3 px-3.5 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">
                    <span className="font-medium">「{r.keyword}」</span>
                    {coWords.length > 0 ? <span className="text-ink-3"> + {coWords.join('、')}</span> : null}
                    <span className="text-ink-3"> → </span>
                    <span className="font-medium">
                      {KIND_LABEL[r.kind]} · {r.categoryName}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-ink-3">
                    命中 {r.hits} 次{r.from ? ` · 来自「${r.from}」` : ''}
                    {sample ? ` · ${sample.createdAt.slice(0, 10)}` : ''}
                  </span>
                </span>
                <button
                  onClick={() => void removeAt(r)}
                  aria-label={`删除规则 ${r.keyword}`}
                  className="h-8 w-8 shrink-0 rounded-btn text-sm active:bg-surface-2"
                  style={{ color: 'var(--fou)' }}
                >
                  ✕
                </button>
              </li>
            );
          })
        )}
      </ul>
    </section>
  );
}

export default function RulePage() {
  const sessionState = useAuthStore((s) => s.sessionState);
  const session = useAuthStore((s) => s.session);
  const categories = useDataStore((s) => s.categories);

  const [rules, setRules] = useState<ParseRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [sheet, setSheet] = useState<{ editing?: ParseRule; index?: number } | null>(null);

  const loggedIn = sessionState === 'valid' && Boolean(session?.token);
  const server = currentServer();
  /** 未登录 / 离线 / 无服务器时禁用编辑（规则保存在服务器，跟随账号同步）。 */
  const editable = loggedIn && Boolean(server);

  /** 生活流分类（供归类下拉）。 */
  const ledgerCats = useMemo(
    () => categories.filter((c) => c.kind === 'ledger').sort((a, b) => a.order - b.order),
    [categories],
  );

  /** 进入页面拉取云端规则。 */
  useEffect(() => {
    if (!editable) return;
    let alive = true;
    setLoading(true);
    getRules(server)
      .then((raw) => {
        if (alive) setRules(normalizeRules(raw));
      })
      .catch((e) => {
        if (alive) toastError((e as Error).message || '规则获取失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, server?.id]);

  /** 新增 / 替换一条规则（本地暂存，点底部按钮整包 POST）。 */
  const upsert = (rule: ParseRule, index?: number) => {
    setRules((prev) => {
      if (typeof index === 'number') {
        const next = prev.slice();
        next[index] = rule;
        return next;
      }
      return [...prev, rule];
    });
    setDirty(true);
  };

  const removeAt = async (index: number, rule: ParseRule) => {
    const ok = await useUiStore.getState().confirm({
      title: '删除这条规则？',
      message: `「${rule.keyword} → ${rule.category} · ${JUDGEMENT_LABEL[rule.judgement]}」删除后需点「保存到服务器」才生效。`,
    });
    if (!ok) return;
    setRules((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  /** 整包保存到服务器（云端同步给网页版与后续的本地解析）。 */
  const persist = async () => {
    if (saving || !editable) return;
    setSaving(true);
    try {
      await saveRules(server, rules);
      toastSuccess('识别规则已保存，云同步生效');
      setDirty(false);
    } catch (e) {
      toastError((e as Error).message || '规则保存失败');
    }
    setSaving(false);
  };

  return (
    <PageShell
      title="识别规则"
      subtitle={editable ? '命中关键词的记录自动归类' : undefined}
      right={
        <button
          onClick={() => setSheet({})}
          disabled={!editable}
          className="mr-1 h-9 rounded-full bg-accent-soft px-3.5 text-xs font-medium text-accent disabled:opacity-40"
        >
          ＋ 新增
        </button>
      }
    >
      {/* 顶部说明 */}
      <p className="mb-3 px-1 text-xs leading-5 text-ink-3">
        教 AI 识记账：命中关键词的记录自动归类（如：星巴克 → 餐饮 · 需）。保存后云同步生效。
      </p>

      {/* 未登录 / 离线提示 */}
      {!editable ? (
        <div className="rounded-card border border-dashed border-line bg-surface p-6 text-center">
          <p className="text-accent">
            <Lock size={24} strokeWidth={1.8} aria-hidden />
          </p>
          <p className="mt-2 text-sm text-ink-2">识别规则保存在服务器，需登录后使用</p>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface">
            {loading ? (
              <li className="px-3.5 py-8 text-center text-sm text-ink-3">正在加载…</li>
            ) : rules.length === 0 ? (
              <li className="px-3.5 py-8 text-center text-sm text-ink-3">还没有规则，点右上角「＋ 新增」教 AI 一条</li>
            ) : (
              rules.map((r, i) => (
                <li key={`${r.keyword}-${i}`} className="flex items-center gap-3 px-3.5 py-3">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="font-medium">{r.keyword}</span>
                    <span className="text-ink-3"> → {r.category}</span>
                    <span className="ml-1.5 rounded-btn bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">
                      {JUDGEMENT_LABEL[r.judgement]}
                    </span>
                  </span>
                  <button
                    onClick={() => setSheet({ editing: r, index: i })}
                    className="h-8 shrink-0 rounded-btn bg-accent-soft px-2.5 text-xs font-medium text-accent"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => void removeAt(i, r)}
                    aria-label={`删除规则 ${r.keyword}`}
                    className="h-8 w-8 shrink-0 rounded-btn text-sm active:bg-surface-2"
                    style={{ color: 'var(--fou)' }}
                  >
                    ✕
                  </button>
                </li>
              ))
            )}
          </ul>

          <button
            onClick={() => void persist()}
            disabled={saving || loading}
            className="mt-4 h-12 w-full rounded-btn bg-accent text-base font-semibold text-white active:opacity-90 disabled:opacity-40"
          >
            {saving ? '保存中…' : dirty ? '保存到服务器 *' : '保存到服务器'}
          </button>
          {dirty ? <p className="mt-2 text-center text-[11px] text-ink-3">有未保存的修改（标 * 号）</p> : null}
        </>
      )}

      {/* 本地自学习规则（v1.2.0，本机存储，未登录也能管理） */}
      <LearnedRuleSection />

      {sheet ? (
        <RuleFormSheet
          editing={sheet.editing}
          ledgerCats={ledgerCats}
          onClose={() => setSheet(null)}
          onSubmit={(rule) => upsert(rule, sheet.index)}
        />
      ) : null}
    </PageShell>
  );
}
