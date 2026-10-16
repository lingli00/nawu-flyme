import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PageShell from '../components/layout/PageShell';
import PageField from '../components/ui/PageField';
import { Toggle } from '../components/ui/Toggle';
import { Segmented } from '../components/ui/Segmented';
import { useAppStore, useSettingsStore, useUiStore, currentServer, toastSuccess, toastError } from '../store';
import { CURRENCIES } from '../lib/money';
import { fmtTimestamp } from '../lib/date';
import { APP_VERSION, compareVersions } from '../lib/appVersion';
import { checkAppVersion, openAppDownload } from '../api/app';
import { isNative } from '../net/env';
import { haptic } from '../lib/haptics';
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

  const saveAi = async () => {
    await update({
      aiEndpoint: aiEndpoint.trim().replace(/\/+$/, ''),
      aiKey: aiKey.trim(),
      aiModel: aiModel.trim(),
    });
    toastSuccess('AI 配置已保存');
  };

  const [checking, setChecking] = useState(false);

  /** 检查更新：请求服务端 version → 无更新 toast；有更新 confirm 后打开下载。 */
  const checkUpdate = async () => {
    if (checking) return;
    const server = currentServer();
    if (!server) {
      toastError('请先在「服务器管理」中配置服务器');
      return;
    }
    setChecking(true);
    try {
      const info = await checkAppVersion(server);
      const remote = (info.version ?? '').trim();
      if (!remote || compareVersions(remote, APP_VERSION) <= 0) {
        toastSuccess(`已是最新版本 v${APP_VERSION}`);
      } else {
        const confirmed = await useUiStore.getState().confirm({
          title: `发现新版本 v${remote}`,
          message: info.notes ? info.notes : `将跳转浏览器下载安装包（当前 v${APP_VERSION}），下载完成后点击通知安装。`,
        });
        if (confirmed) await openAppDownload(server.url);
      }
    } catch (e) {
      toastError(e instanceof Error && e.message ? e.message : '检查更新失败，请确认服务器可访问');
    }
    setChecking(false);
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
        <p className="mt-1 text-[11px] text-ink-3">
          填 OpenAI 兼容接口直连第三方；留空则只使用本地识别规则。Key 只保存在本机。
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
          <button onClick={() => void saveAi()} className="h-11 w-full rounded-btn bg-accent text-sm font-semibold text-white">
            保存 AI 配置
          </button>
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
          <h2 className="text-sm font-semibold">应用更新</h2>
          <p className="mt-1 text-[11px] text-ink-3">
            当前版本 v{APP_VERSION}。安装包由你的服务器提供，更新前请确保可以访问服务器。
          </p>
          <button
            onClick={() => void checkUpdate()}
            disabled={checking}
            className="mt-3 h-10 w-full rounded-btn bg-accent-soft text-sm font-medium text-accent disabled:opacity-40"
          >
            {checking ? '正在检查…' : '检查更新'}
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
