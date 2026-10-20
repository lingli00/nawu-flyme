import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wifi } from 'lucide-react';
import PageShell from '../components/layout/PageShell';
import { useServerStore, useUiStore, toastSuccess, toastInfo } from '../store';
import { readServerSessions } from '../store/useAuthStore';
import { MAX_SERVERS } from '../store/useServerStore';
import { displayUrl, normalizeServerUrl } from '../lib/url';
import { haptic } from '../lib/haptics';
import { isLanScanRecommended, scanLanServers, type LanScanHit } from '../net/lanScan';

/**
 * P05 服务器管理：多服务器列表，点选切换当前服务器。
 *
 * ★v1.3.3 多服务器独立登录态：每台服务器各自记住自己的账号，
 * 列表里直接标出「已登录 xxx」；切过去直接是那个账号，不用重输密码。
 * 上限 3 台（再多容易记混，也超出产品承诺的 2~3 台）。
 */

/** 局域网扫描状态机。 */
type ScanState =
  | { phase: 'idle' }
  | { phase: 'scanning'; done: number; total: number }
  | { phase: 'done'; hits: LanScanHit[] };

/** 扫描结果里被选中、待确认保存的服务器。 */
interface PendingServer {
  url: string;
  name?: string;
}

export default function ServerManagePage() {
  const nav = useNavigate();
  const { servers, currentId, setCurrent, remove, add } = useServerStore();
  const [scan, setScan] = useState<ScanState>({ phase: 'idle' });
  const [pending, setPending] = useState<PendingServer | null>(null);
  const [saving, setSaving] = useState(false);
  /** 各服务器已保存的登录账号（serverId → 邮箱）。 */
  const [sessions, setSessions] = useState<Record<string, { email: string }>>({});

  const refreshSessions = (): void => {
    void readServerSessions().then(setSessions);
  };
  useEffect(refreshSessions, [currentId, servers.length]);

  /** 扫描取消标记：点「停止」或组件卸载时置位。 */
  const scanCancelRef = useRef(false);

  // 组件卸载时停止扫描
  useEffect(() => {
    return () => {
      scanCancelRef.current = true;
    };
  }, []);

  const pick = async (id: string) => {
    if (id === currentId) return;
    const has = Boolean(sessions[id]);
    await setCurrent(id);
    toastSuccess(has ? `已切到「${servers.find((x) => x.id === id)?.alias ?? '服务器'}」，账号已恢复` : '已切换服务器');
  };

  const del = async (id: string) => {
    const confirmed = await useUiStore
      .getState()
      .confirm({ title: '删除这个服务器？', message: '只删除连接配置，不影响服务器上的数据。' });
    if (!confirmed) return;
    await remove(id);
    toastSuccess('已删除');
  };

  /** 开始扫描局域网。 */
  const startScan = () => {
    if (scan.phase === 'scanning') return;
    scanCancelRef.current = false;
    setPending(null);
    setScan({ phase: 'scanning', done: 0, total: 0 });
    const savedUrls = servers.map((s) => s.url);
    void scanLanServers({
      savedUrls,
      isCancelled: () => scanCancelRef.current,
      onProgress: (done, total) =>
        setScan((prev) => (prev.phase === 'scanning' ? { ...prev, done, total } : prev)),
    }).then((hits) => {
      if (scanCancelRef.current) {
        setScan({ phase: 'idle' });
        return;
      }
      setScan({ phase: 'done', hits });
    });
  };

  /** 点扫描结果行 → 预填为待保存的新服务器（确认后落库）。 */
  const chooseHit = (hit: LanScanHit) => {
    setPending({ url: hit.url, name: hit.name });
    setScan({ phase: 'idle' });
  };

  /** 保存预填的服务器（重复地址直接提示，不重复添加）。 */
  const savePending = async () => {
    if (!pending || saving) return;
    const norm = normalizeServerUrl(pending.url);
    if (!norm.ok) {
      toastInfo('地址格式不正确，请手动输入');
      return;
    }
    const dup = servers.some((s) => s.url === norm.url);
    if (dup) {
      toastInfo('已存在相同地址的服务器，无需重复添加');
      setPending(null);
      return;
    }
    setSaving(true);
    try {
      const saved = await add({ alias: pending.name || '扫描到的服务器', url: norm.url });
      await setCurrent(saved.id);
      void haptic('medium');
      toastSuccess('已添加并切换到新服务器');
      setPending(null);
    } catch {
      toastInfo('添加失败，请重试或手动输入');
    }
    setSaving(false);
  };

  const scanning = scan.phase === 'scanning';

  return (
    <PageShell
      title="服务器管理"
      right={
        <button
          onClick={() => nav('/servers/new')}
          disabled={servers.length >= MAX_SERVERS}
          className="h-9 rounded-btn bg-accent px-3 text-sm font-medium text-white disabled:opacity-40"
        >
          新增
        </button>
      }
    >
      <p className="mb-3 px-1 text-[11px] leading-5 text-ink-3">
        最多可配置 {MAX_SERVERS} 台服务器；每台的登录状态各自保存——切换服务器会直接恢复该服务器的账号，不用重新登录。
      </p>

      {/* 局域网扫描 */}
      <button
        onClick={startScan}
        disabled={scanning}
        className="mb-3 h-10 w-full rounded-btn border border-line bg-surface text-sm text-ink-2 disabled:opacity-40"
      >
        {scanning ? (
          `正在扫描…已探测 ${scan.done} / ${scan.total}`
        ) : (
          <span className="flex items-center justify-center gap-1.5">
            <Wifi size={16} strokeWidth={1.8} aria-hidden />
            扫描局域网
          </span>
        )}
      </button>
      {scanning ? (
        <button
          onClick={() => {
            scanCancelRef.current = true;
          }}
          className="mb-3 h-8 w-full text-sm text-ink-3"
        >
          停止
        </button>
      ) : null}
      {scan.phase === 'done' ? (
        scan.hits.length === 0 ? (
          <p className="mb-3 text-center text-xs text-ink-3">未发现服务端，请检查网络或手动输入</p>
        ) : (
          <ul className="mb-3 space-y-1.5">
            {scan.hits.map((hit) => (
              <li key={hit.url}>
                <button
                  onClick={() => chooseHit(hit)}
                  className="w-full rounded-btn border border-line bg-surface px-3 py-2 text-left active:opacity-80"
                >
                  <span className="block truncate text-xs font-medium" style={{ color: 'var(--gui)' }}>
                    {hit.url}
                  </span>
                  {hit.name ? <span className="block truncate text-[11px] text-ink-3">{hit.name}</span> : null}
                  <span className="block text-[11px] text-ink-3">点击保存为新服务器</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {scan.phase !== 'idle' && !isLanScanRecommended() ? (
        <p className="mb-3 text-[11px] text-ink-3">
          网页环境受浏览器跨域限制，可能扫不到服务端；请使用 App 内的扫描功能。
        </p>
      ) : null}

      {/* 扫描结果预填：确认后保存 */}
      {pending ? (
        <div className="mb-3 rounded-card border border-accent bg-surface p-4">
          <p className="text-sm font-medium">将添加服务器</p>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--gui)' }}>
            {pending.url}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => void savePending()}
              disabled={saving}
              className="h-10 flex-1 rounded-btn bg-accent text-sm font-semibold text-white disabled:opacity-40"
            >
              {saving ? '正在保存…' : '保存'}
            </button>
            <button
              onClick={() => setPending(null)}
              className="h-10 flex-1 rounded-btn border border-line text-sm text-ink-2"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {servers.length === 0 ? (
        <div className="rounded-card border border-dashed border-line bg-surface p-8 text-center text-sm text-ink-3">
          还没有配置服务器。
          <br />
          不配置也可以离线记账。
        </div>
      ) : (
        <ul className="space-y-2">
          {servers.map((s) => (
            <li key={s.id}>
              <div
                className={`flex items-center gap-3 rounded-card border bg-surface p-3.5 ${
                  s.id === currentId ? 'border-accent' : 'border-line'
                }`}
              >
                <button onClick={() => pick(s.id)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{s.alias || '未命名服务器'}</span>
                    {s.id === currentId ? (
                      <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                        当前
                      </span>
                    ) : null}
                    {s.lastOk === false ? (
                      <span className="text-xs" style={{ color: 'var(--fou)' }}>
                        离线
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-3">{displayUrl(s.url)}</p>
                  {sessions[s.id] ? (
                    <p className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--gui)' }}>
                      已登录 {sessions[s.id]?.email || '账号'}
                    </p>
                  ) : (
                    <p className="mt-0.5 truncate text-[11px] text-ink-3">未登录（切换后可直接登录）</p>
                  )}
                </button>
                <button
                  onClick={() => nav(`/servers/${s.id}`)}
                  className="h-8 rounded-btn border border-line px-2.5 text-xs text-ink-2"
                >
                  编辑
                </button>
                <button
                  onClick={() => del(s.id)}
                  className="h-8 rounded-btn border border-line px-2.5 text-xs"
                  style={{ color: 'var(--fou)' }}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
