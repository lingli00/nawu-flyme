import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import PageShell from '../components/layout/PageShell';
import PageField from '../components/ui/PageField';
import { useServerStore, toastSuccess, toastError } from '../store';
import { probeHealth } from '../api/server';
import { displayUrl, normalizeServerUrl } from '../lib/url';
import { haptic } from '../lib/haptics';
import type { ProbeState } from '../types/entities';

/** P06 新增 / 编辑服务器（路由 /servers/new 与 /servers/:id 复用）。 */
export default function ServerEditPage() {
  const nav = useNavigate();
  const { id } = useParams();
  const editing = useServerStore((s) => s.servers.find((x) => x.id === id));
  const { add, update, setCurrent } = useServerStore.getState();

  const [alias, setAlias] = useState(editing?.alias ?? '');
  const [raw, setRaw] = useState(editing?.url ?? '');
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  const norm = raw.trim() ? normalizeServerUrl(raw) : null;

  const test = async () => {
    if (!norm?.ok) return;
    setBusy(true);
    setProbe({ kind: 'probing' });
    try {
      setProbe(await probeHealth({ id: 'tmp', alias: '', url: norm.url, createdAt: '' }));
    } catch (e) {
      setProbe({ kind: 'error', error: e as never });
    }
    setBusy(false);
  };

  const save = async () => {
    if (!norm?.ok) {
      toastError(norm?.reason ?? '请填写服务器地址');
      return;
    }
    try {
      if (editing) {
        await update(editing.id, { alias: alias.trim() || '我的服务器', url: norm.url });
        void haptic('medium');
        toastSuccess('已保存');
      } else {
        const saved = await add({ alias: alias.trim() || '我的服务器', url: norm.url });
        await setCurrent(saved.id);
        void haptic('medium');
        toastSuccess('已添加并设为当前服务器');
      }
      nav('/servers', { replace: true });
    } catch (e) {
      toastError((e as Error).message);
    }
  };

  return (
    <PageShell title={editing ? '编辑服务器' : '新增服务器'}>
      <div className="space-y-3 rounded-card border border-line bg-surface p-4">
        <PageField label="备注名" hint="随便起，方便区分多台服务器">
          <input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="例如：家里的小主机"
            className="h-11 w-full nw-input"
          />
        </PageField>

        <PageField label="服务器地址" hint={norm?.ok ? displayUrl(norm.url) : '例如 http://192.168.1.10:3030'}>
          <input
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setProbe({ kind: 'idle' });
            }}
            inputMode="url"
            autoCapitalize="off"
            placeholder="http://"
            className="h-11 w-full nw-input"
          />
        </PageField>

        {raw.trim() && norm && !norm.ok ? (
          <p className="text-xs" style={{ color: 'var(--fou)' }}>
            {norm.reason}
          </p>
        ) : null}

        <button
          onClick={test}
          disabled={!norm?.ok || busy}
          className="h-10 w-full rounded-btn bg-accent-soft text-sm font-medium text-accent disabled:opacity-40"
        >
          {busy ? '正在连接…' : '测试连接'}
        </button>

        {probe.kind === 'online' ? (
          <p className="text-xs" style={{ color: 'var(--gui)' }}>
            ✓ 连接成功{probe.dbOk ? '' : '（但服务端数据库异常）'}
          </p>
        ) : null}
        {probe.kind === 'error' ? (
          <p className="text-xs" style={{ color: 'var(--fou)' }}>
            ✗ {probe.error.message}
          </p>
        ) : null}

        <button
          onClick={save}
          disabled={!norm?.ok}
          className="h-12 w-full rounded-btn bg-accent text-base font-semibold text-white active:opacity-90 disabled:opacity-40"
        >
          保存
        </button>
      </div>
    </PageShell>
  );
}
