import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PageShell from '../components/layout/PageShell';
import PageField from '../components/ui/PageField';
import { Toggle } from '../components/ui/Toggle';
import { Segmented } from '../components/ui/Segmented';
import { useAppStore, useSettingsStore, currentServer, toastSuccess, toastError } from '../store';
import { CURRENCIES } from '../lib/money';
import { fmtTimestamp } from '../lib/date';
import { APP_VERSION } from '../lib/appVersion';
import { isNative } from '../net/env';
import { haptic } from '../lib/haptics';
import { checkAppUpdate, type AppUpdateTarget } from '../api/appUpdate';
import { runAppUpdate, fmtSize, type UpdateProgress } from '../api/appUpdateFlow';
import { chatComplete } from '../net/aiClient';
import type { ThemeMode } from '../types/entities';

const THEMES: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

/** 小开关：v1.0.33 起改用 components/ui/Toggle（原文件内复制实现，两份已出现细节差异）。 */

/** P22 设置：外观 / AI 助手 / 同步 / 货币。 */
export default function SettingsPage() {
  const nav = useNavigate();
  const themeMode = useAppStore((s) => s.themeMode);
  const setThemeMode = useAppStore((s) => s.setThemeMode);
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);

  const [aiEndpoint, setAiEndpoint] = useState(settings.aiEndpoint ?? '');
  const [aiKey, setAiKey] = useState(settings.aiKey ?? '');
  const [aiModel, setAiModel] = useState(settings.aiModel ?? '');
  /** ★v1.1.3 测试连接中（发一句最小请求验证 endpoint/key/model 是否可用）。 */
  const [testing, setTesting] = useState(false);

  const saveAi = async () => {
    await update({
      aiEndpoint: aiEndpoint.trim().replace(/\/+$/, ''),
      aiKey: aiKey.trim(),
      aiModel: aiModel.trim(),
    });
    toastSuccess('AI 配置已保存');
  };

  /** 测试连接：拿输入框里的值（不强制先保存）发一句最小对话，验证三件套是否配对了。 */
  const testAi = async () => {
    const cfg = {
      endpoint: aiEndpoint.trim().replace(/\/+$/, ''),
      key: aiKey.trim(),
      model: aiModel.trim() || 'gpt-4o-mini',
    };
    if (!cfg.endpoint || !cfg.key) {
      toastError('请先填写接口地址和 API Key');
      return;
    }
    setTesting(true);
    try {
      const text = await chatComplete(cfg, [{ role: 'user', content: 'ping，请只回复一个字：好' }], 15000);
      toastSuccess(`连接成功，模型回复：${(text || '').slice(0, 20) || '（空）'}`);
    } catch (e) {
      toastError(`连接失败：${e instanceof Error && e.message ? e.message : '未知错误'}`);
    } finally {
      setTesting(false);
    }
  };

  const [checking, setChecking] = useState(false);
  const [updateTarget, setUpdateTarget] = useState<AppUpdateTarget | null>(null);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

  /** 自动检查节流键：24 小时内不重复打扰（成功/失败都记，避免离线用户每次进设置页都等一轮超时）。 */
  const AUTO_CHECK_KEY = 'nawu-app-update-last-check';
  const AUTO_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

  /**
   * 检查更新：官方频道优先（含增量补丁），取不到再回退用户自己的服务器。
   * auto=true 时是后台静默检查，不弹任何提示，只更新 updateTarget。
   */
  const checkUpdate = async (auto = false) => {
    if (checking || updating) return;
    const server = currentServer();
    setChecking(true);
    try {
      const target = await checkAppUpdate(server);
      setUpdateTarget(target);
      if (!target && !auto) {
        toastSuccess(`已是最新版本 v${APP_VERSION}`);
      }
    } catch (e) {
      if (!auto) {
        toastError(e instanceof Error && e.message ? e.message : '检查更新失败，请确认服务器可访问');
      }
    } finally {
      try {
        localStorage.setItem(AUTO_CHECK_KEY, String(Date.now()));
      } catch {
        // 隐私模式等场景写不进去，忽略
      }
      setChecking(false);
    }
  };

  /** 进入设置页时静默检查一次（24h 节流），有更新就直接展示更新面板。 */
  useEffect(() => {
    if (!isNative()) return;
    let last = 0;
    try {
      last = Number(localStorage.getItem(AUTO_CHECK_KEY) ?? '0') || 0;
    } catch {
      last = 0;
    }
    if (Date.now() - last < AUTO_CHECK_INTERVAL) return;
    void checkUpdate(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 执行应用内更新（下载 → 可选差分包合并 → 校验 → 调起安装器）。 */
  const runUpdate = async () => {
    const target = updateTarget;
    if (!target || updating) return;
    setUpdating(true);
    setProgress(null);
    try {
      const outcome = await runAppUpdate(target, setProgress);
      if (outcome.started) {
        toastSuccess(outcome.message);
        if (outcome.usedPatch) void haptic('success');
      } else {
        toastError(outcome.message);
      }
    } catch (e) {
      toastError(e instanceof Error && e.message ? e.message : '更新失败，请稍后重试');
    } finally {
      setUpdating(false);
      setProgress(null);
    }
  };

  const updatePct = (): number => {
    if (!progress || !progress.total || progress.total <= 0) return 0;
    return Math.min(100, Math.floor((progress.received / progress.total) * 100));
  };

  return (
    <PageShell title="设置">
      {/* 外观 */}
      <section className="rounded-card border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">外观</h2>
        {/* ★v1.0.33 P1-9：主题三选统一用 Segmented 组件（滑块指示 + 200ms 过渡） */}
        <Segmented
          block
          className="mt-3"
          value={themeMode}
          onChange={(v) => void setThemeMode(v)}
          options={THEMES.map((t) => ({ value: t.value, label: t.label }))}
        />
      </section>

      {/* AI 助手 */}
      <section className="mt-3 rounded-card border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">AI 助手（可选）</h2>
        <p className="mt-1 text-[11px] leading-5 text-ink-3">
          填 OpenAI 兼容接口直连第三方；留空则只使用本地识别规则。Key 只保存在本机。
          配置后用于两处：① AI 记一笔（一句话 / 识图记账解析）② 报表页「AI 分析」（按当前粒度生成消费洞察）。
        </p>
        <div className="mt-3 space-y-3">
          <PageField label="接口地址 Endpoint">
            <input
              value={aiEndpoint}
              onChange={(e) => setAiEndpoint(e.target.value)}
              placeholder="https://api.example.com/v1"
              autoCapitalize="off"
              className="h-11 w-full nw-input"
            />
          </PageField>
          <PageField label="API Key">
            <input
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              type="password"
              placeholder="sk-…"
              autoCapitalize="off"
              className="h-11 w-full nw-input"
            />
          </PageField>
          <PageField label="模型">
            <input
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              placeholder="例如 gpt-4o-mini"
              autoCapitalize="off"
              className="h-11 w-full nw-input"
            />
          </PageField>
          <div className="flex gap-2">
            <button onClick={() => void saveAi()} className="h-11 flex-1 rounded-btn bg-accent text-sm font-semibold text-white">
              保存 AI 配置
            </button>
            <button
              onClick={() => void testAi()}
              disabled={testing}
              className="h-11 rounded-btn border border-line px-4 text-sm text-ink-2 active:bg-surface-2 disabled:opacity-50"
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
          </div>
        </div>
      </section>

      {/* 同步 */}
      <section className="mt-3 rounded-card border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">同步</h2>
        <div className="mt-3 flex items-center justify-between">
          <div className="min-w-0 pr-3">
            <p className="text-sm">自动备份</p>
            <p className="text-[11px] text-ink-3">
              登录后满足条件（24 小时节流 + 变更达标）静默备份。服务器只保留最近 3 份。
            </p>
          </div>
          <Toggle on={settings.autoSync} label="自动备份" onClick={() => void update({ autoSync: !settings.autoSync })} />
        </div>
        <p className="mt-2 text-[11px] text-ink-3">
          上次备份：{settings.lastBackupAt ? fmtTimestamp(settings.lastBackupAt) : '从未'}
        </p>
        <button
          onClick={() => nav('/backup')}
          className="mt-3 h-10 w-full rounded-btn border border-line text-sm text-ink-2"
        >
          打开备份与恢复 ›
        </button>
      </section>

      {/* 显示偏好（v1.0.17，对标竞品「更多设置 → 显示偏好 → 震动 / 开屏」） */}
      <section className="mt-3 rounded-card border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">显示偏好</h2>
        <div className="mt-3 space-y-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0 pr-3">
              <p className="text-sm">震动反馈</p>
              <p className="text-[11px] text-ink-3">保存成功、切换 Tab、点选图标时轻微震动；失败时给出失败反馈。</p>
            </div>
            <Toggle
              on={settings.vibrate !== false}
              label="震动反馈"
              onClick={() => {
                const next = !(settings.vibrate !== false);
                void update({ vibrate: next });
                if (next) void haptic('select');
              }}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="min-w-0 pr-3">
              <p className="text-sm">开屏动画</p>
              <p className="text-[11px] text-ink-3">
                打开应用时播放品牌开屏页（网页端每次浏览会话只播一次）。
              </p>
            </div>
            <Toggle
              on={settings.splash !== false}
              label="开屏动画"
              onClick={() => void update({ splash: !(settings.splash !== false) })}
            />
          </div>
        </div>
      </section>

      {/* 货币 */}
      <section className="mt-3 rounded-card border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">货币</h2>        <select
          value={settings.currency}
          onChange={(e) => void update({ currency: e.target.value })}
          className="mt-3 h-11 w-full nw-input"
        >
          {CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.symbol} {c.name}（{c.code}）
            </option>
          ))}
        </select>
      </section>

      {/* 应用更新（仅 App 显示——网页端在浏览器里打开即是最新版，无"应用更新"可言） */}
      {isNative() ? (
        <section className="mt-3 rounded-card border border-line bg-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">应用更新</h2>
            {updateTarget && !updating ? (
              <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-medium text-danger">有新版本</span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] text-ink-3">
            当前版本 v{APP_VERSION}
            {updateTarget
              ? ` · 更新来源：${updateTarget.source === 'channel' ? '官方频道' : '你的服务器'}`
              : ' · 更新来源：官方频道（不可达时回退你的服务器）'}
          </p>

          {/* 发现新版本：版本信息 + 更新说明 + 立即更新 */}
          {updateTarget ? (
            <div className="mt-3 rounded-btn border border-line bg-surface-2 p-3">
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-semibold">v{APP_VERSION} → v{updateTarget.version}</p>
                <span className="text-[11px] text-ink-3">
                  {updateTarget.patch ? `增量 ${fmtSize(updateTarget.patch.size)}` : `完整包 ${fmtSize(updateTarget.apkSize)}`}
                </span>
              </div>
              {updateTarget.publishedAt ? (
                <p className="mt-0.5 text-[11px] text-ink-3">发布于 {fmtTimestamp(updateTarget.publishedAt)}</p>
              ) : null}
              {updateTarget.notes ? (
                <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">{updateTarget.notes}</p>
              ) : null}
              {updateTarget.patch ? (
                <p className="mt-1 text-[10px] text-ink-3">支持增量更新：只下载差异部分，合并后自动校验；失败会自动改用完整安装包。</p>
              ) : null}
              <button
                onClick={() => void runUpdate()}
                disabled={updating}
                className="mt-3 h-10 w-full rounded-btn bg-accent text-sm font-semibold text-white disabled:opacity-40"
              >
                {updating ? '更新中…' : '立即更新'}
              </button>
            </div>
          ) : null}

          {/* 更新进度 */}
          {updating && progress ? (
            <div className="mt-3">
              <div className="flex items-center justify-between text-[11px] text-ink-2">
                <span>{progress.text}</span>
                {progress.total > 0 ? <span>{updatePct()}%</span> : null}
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{ width: `${updatePct()}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] text-ink-3">更新过程请保持应用在前台，完成后按系统提示安装。</p>
            </div>
          ) : null}

          <button
            onClick={() => void checkUpdate()}
            disabled={checking || updating}
            className="mt-3 h-10 w-full rounded-btn bg-accent-soft text-sm font-medium text-accent disabled:opacity-40"
          >
            {checking ? '正在检查…' : updateTarget ? '重新检查' : '检查更新'}
          </button>
        </section>
      ) : null}

      {/* 服务器管理入口统一收敛在「我的」页（避免多路径重复），此处不再放置 */}

      <p className="mt-5 pb-2 text-center text-[11px] text-ink-3">
        纳物 · {isNative() ? 'App' : '网页版'} v{APP_VERSION}
      </p>
    </PageShell>
  );
}
