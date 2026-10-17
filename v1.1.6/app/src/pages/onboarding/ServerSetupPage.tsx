import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore, useServerStore } from '../../store';
import { probeHealth } from '../../api/server';
import { normalizeServerUrl } from '../../lib/url';
import { isLanScanRecommended, scanLanServers, type LanScanHit } from '../../net/lanScan';
import type { ProbeState } from '../../types/entities';

/**
 * P01 服务器配置引导（首次启动，未配置任何服务器时进入）。
 * 品牌『纳物』为客户端常量（R9：不请求 /api/settings）。
 */

/** 局域网扫描状态机。 */
type ScanState =
  | { phase: 'idle' }
  | { phase: 'scanning'; done: number; total: number }
  | { phase: 'done'; hits: LanScanHit[] };

export default function ServerSetupPage() {
  const nav = useNavigate();
  const add = useServerStore((s) => s.add);
  const [raw, setRaw] = useState('');
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<ScanState>({ phase: 'idle' });

  /** 扫描取消标记：点「停止」或组件卸载时置位，池子里未发出的探测不再发出。 */
  const scanCancelRef = useRef(false);

  // 组件卸载时停止扫描
  useEffect(() => {
    return () => {
      scanCancelRef.current = true;
    };
  }, []);

  const norm = raw.trim() ? normalizeServerUrl(raw) : null;

  /** 探活指定地址（不落库，测通才保存）。 */
  const testUrl = async (url: string) => {
    const n = normalizeServerUrl(url);
    if (!n.ok) return;
    setBusy(true);
    setProbe({ kind: 'probing' });
    try {
      const state = await probeHealth({
        id: 'tmp',
        alias: '',
        url: n.url,
        createdAt: '',
      });
      setProbe(state);
    } catch {
      setProbe({ kind: 'error', error: undefined as never });
    }
    setBusy(false);
  };

  /** 测试连接：先本地校验地址，再探活。 */
  const test = async () => {
    if (!norm?.ok) return;
    await testUrl(norm.url);
  };

  /** 开始扫描局域网。 */
  const startScan = () => {
    if (scan.phase === 'scanning') return;
    scanCancelRef.current = false;
    setScan({ phase: 'scanning', done: 0, total: 0 });
    const savedUrls = useServerStore.getState().servers.map((s) => s.url);
    void scanLanServers({
      savedUrls,
      isCancelled: () => scanCancelRef.current,
      onProgress: (done, total) =>
        setScan((prev) => (prev.phase === 'scanning' ? { ...prev, done, total } : prev)),
    }).then((hits) => {
      if (scanCancelRef.current) {
        // 已取消（或已卸载）：回到初始态，不展示半截结果
        setScan({ phase: 'idle' });
        return;
      }
      setScan({ phase: 'done', hits });
    });
  };

  /** 点扫描结果行：填入输入框并自动触发原有验证流程。 */
  const useHit = (hit: LanScanHit) => {
    setRaw(hit.url);
    setProbe({ kind: 'idle' });
    setScan({ phase: 'idle' });
    void testUrl(hit.url);
  };

  /**
   * 先离线用：★必须先把 offlineMode 标志落盘，否则路由守卫会立刻把用户
   * 弹回引导页（表现为「闪一下又回来，进不去」）。
   */
  const goOffline = async () => {
    await useAppStore.getState().setOfflineMode(true);
    nav('/home', { replace: true });
  };
  const save = async () => {
    if (!norm?.ok) return;
    const saved = await add({ alias: '我的服务器', url: norm.url });
    useServerStore.setState({ currentId: saved.id });
    nav('/login');
  };

  const ok = probe.kind === 'online';
  const scanning = scan.phase === 'scanning';

  return (
    <div className="flex min-h-full flex-col bg-surface-2 text-ink">
      <div
        className="flex flex-col items-center px-6 pb-6 pt-14"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 3rem)' }}
      >
        <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-accent text-3xl font-bold text-white shadow-lg shadow-accent/25">
          纳
        </div>
        <h1 className="mt-4 text-xl font-bold">纳物</h1>
        <p className="mt-1 text-sm text-ink-3">物品与消费复盘</p>
      </div>

      <div className="mx-auto w-full max-w-md flex-1 px-6">
        <div className="rounded-card border border-line bg-surface p-4">
          <label className="text-sm font-medium">服务器地址</label>
          <p className="mt-0.5 text-xs text-ink-3">例如 http://192.168.1.10:3030</p>
          <input
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setProbe({ kind: 'idle' });
            }}
            placeholder="http://"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            className="mt-2 h-11 w-full nw-input"
          />
          {raw.trim() && norm && !norm.ok ? (
            <p className="mt-1.5 text-xs" style={{ color: 'var(--fou)' }}>
              {norm.reason}
            </p>
          ) : null}

          <button
            onClick={test}
            disabled={!norm?.ok || busy}
            className="mt-3 h-10 w-full rounded-btn bg-accent-soft text-sm font-medium text-accent disabled:opacity-40"
          >
            {busy ? '正在连接…' : '测试连接'}
          </button>

          {/* 局域网扫描 */}
          <button
            onClick={startScan}
            disabled={scanning || busy}
            className="mt-2 h-10 w-full rounded-btn border border-line text-sm text-ink-2 disabled:opacity-40"
          >
            {scanning ? `正在扫描…已探测 ${scan.done} / ${scan.total}` : '扫描局域网'}
          </button>
          {scanning ? (
            <button
              onClick={() => {
                scanCancelRef.current = true;
              }}
              className="mt-2 h-9 w-full text-sm text-ink-3"
            >
              停止
            </button>
          ) : null}
          {scan.phase === 'done' ? (
            scan.hits.length === 0 ? (
              <p className="mt-2 text-xs text-ink-3">未发现服务端，请检查网络或手动输入</p>
            ) : (
              <div className="mt-2">
                <p className="text-xs font-medium">发现 {scan.hits.length} 台服务端，点击使用：</p>
                <ul className="mt-1.5 space-y-1.5">
                  {scan.hits.map((hit) => (
                    <li key={hit.url}>
                      <button
                        onClick={() => useHit(hit)}
                        className="w-full rounded-btn border border-line bg-surface-2 px-3 py-2 text-left active:opacity-80"
                      >
                        <span className="block truncate text-xs font-medium" style={{ color: 'var(--gui)' }}>
                          {hit.url}
                        </span>
                        {hit.name ? <span className="block truncate text-[11px] text-ink-3">{hit.name}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : null}
          {scan.phase !== 'idle' && !isLanScanRecommended() ? (
            <p className="mt-2 text-[11px] text-ink-3">
              网页环境受浏览器跨域限制，可能扫不到服务端；请使用 App 内的扫描功能。
            </p>
          ) : null}

          {probe.kind === 'online' ? (
            <p className="mt-2 text-xs" style={{ color: 'var(--gui)' }}>
              ✓ 连接成功{probe.dbOk ? '' : '（但服务端数据库异常）'}
            </p>
          ) : null}
          {probe.kind === 'error' ? (
            <p className="mt-2 text-xs" style={{ color: 'var(--fou)' }}>
              ✗ {probe.error.message}
            </p>
          ) : null}
        </div>

        <button
          onClick={save}
          disabled={!ok}
          className="mt-4 h-12 w-full rounded-btn bg-accent text-base font-semibold text-white active:opacity-90 disabled:opacity-40"
        >
          连接并继续
        </button>

        <button
          onClick={() => void goOffline()}
          className="mt-3 h-10 w-full text-sm text-ink-3"
        >
          先离线用，稍后再配置 →
        </button>

        <p className="mt-6 text-center text-xs leading-5 text-ink-3">
          数据保存在本机，服务器仅用于云备份。
          <br />
          未登录也可以使用全部记账功能。
        </p>
      </div>
    </div>
  );
}
