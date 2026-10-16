import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Download } from 'lucide-react';
import PageShell from '../components/layout/PageShell';
import PageField from '../components/ui/PageField';
import { useAuthStore, useServerStore, useSettingsStore, useUiStore, toastError, toastSuccess, fetchBackupList, restoreBackup, uploadBackup, deleteRemoteBackup, currentServer } from '../store';
import type { BackupRow } from '../types/api';
import { humanMessage } from '../lib/error';
import { fmtTimestamp } from '../lib/date';
import { exportCloudBackup, exportLocalBackup } from '../lib/backupExport';

/**
 * P21 备份与恢复（★服务端只保留最近 3 份）。
 *
 * v0.6.0 增强：本地数据与云端备份均可「导出 .flyme 文件」，
 * 可选密码加密（AES-256-GCM + PBKDF2，与网页版导出格式二进制互通，
 * 见 src/lib/flymeFile.ts 的格式逆向说明）。真机走 Filesystem 落盘
 * + Share 系统分享面板；浏览器 dev 直接触发下载。
 */

/** 导出目标：本地当前数据，或云端某一份备份。 */
type ExportTarget = { kind: 'local' } | { kind: 'cloud'; row: BackupRow };

export default function BackupPage() {
  const nav = useNavigate();
  const hasServer = useServerStore((s) => s.servers.length > 0);
  const sessionState = useAuthStore((s) => s.sessionState);
  const lastBackupAt = useSettingsStore((s) => s.settings.lastBackupAt);
  const autoSync = useSettingsStore((s) => s.settings.autoSync);

  const [rows, setRows] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  // 防重入：弹层确认按钮的 disabled 依赖 re-render，连点在同一个 tick 内挡不住，
  // 用 ref 立即互斥（分享面板并发 "Can't share while sharing is in progress" 的根源之一）
  const busyRef = useRef(false);
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);

  const ready = hasServer && sessionState === 'valid';

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setRows(await fetchBackupList());
    } catch (e) {
      setLoadError(humanMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready) void load();
    else setLoading(false);
  }, [ready, load]);

  const upload = async () => {
    setBusy(true);
    try {
      await uploadBackup('manual');
      toastSuccess('已备份到云端');
      await load();
    } catch (e) {
      toastError(humanMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (row: BackupRow) => {
    const ok = await useUiStore.getState().confirm({
      title: '恢复这份备份？',
      message: '恢复会用备份内容覆盖本机全部数据（12 个集合与设置），且无法撤销。',
      confirmText: '覆盖恢复',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await restoreBackup(row.id);
      const timeText = r.exportedAt ? fmtTimestamp(r.exportedAt) : '未知时间';
      let msg = `已恢复 ${r.total} 条记录（备份时间 ${timeText}）`;
      if (r.restoredIcons > 0) {
        msg += `，随备份恢复图标缓存 ${r.restoredIcons} 个（离线秒显）`;
      }
      if (r.subCount > 0) {
        msg += '。注：从网页版备份恢复时，订阅的「停用」状态不会随备份保存，如有需要请重新停用。';
      }
      useUiStore.getState().toast(msg, 'success', { durationMs: 6000 });
      await load();
    } catch (e) {
      toastError(humanMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async (row: BackupRow) => {
    const ok = await useUiStore
      .getState()
      .confirm({ title: '删除这份备份？', message: '云端删除后不可恢复。', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteRemoteBackup(row.id);
      toastSuccess('已删除');
      await load();
    } catch (e) {
      toastError(humanMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** 导出确认（弹层回调）：加解密与落盘统一走 lib/backupExport。 */
  const doExport = async (password: string) => {
    const target = exportTarget;
    if (!target || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    // ★时序：先关应用内密码弹层，给系统分享面板让路（backupExport 侧再等 SHARE_DEFER_MS）
    setExportTarget(null);
    try {
      const r =
        target.kind === 'local'
          ? await exportLocalBackup(password)
          : await exportCloudBackup(currentServer(), target.row.id, password);
      toastSuccess(r.encrypted ? '已导出加密备份文件' : '已导出备份文件（未加密）');
    } catch (e) {
      toastError(humanMessage(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <PageShell title="备份与恢复" subtitle={lastBackupAt ? `上次备份：${fmtTimestamp(lastBackupAt)}` : '从未备份'}>
      {/* 前置状态 */}
      {!hasServer ? (
        <div className="rounded-card border border-dashed border-line bg-surface p-6 text-center text-sm text-ink-3">
          先在「服务器管理」里添加并连接服务器，才能使用云备份。
          <button onClick={() => nav('/servers')} className="mt-3 block w-full rounded-btn bg-accent py-2.5 text-sm font-medium text-white">
            去配置服务器
          </button>
        </div>
      ) : sessionState !== 'valid' ? (
        <div className="rounded-card border border-dashed border-line bg-surface p-6 text-center text-sm text-ink-3">
          云备份需要先登录账号。
          <button onClick={() => nav('/login')} className="mt-3 block w-full rounded-btn bg-accent py-2.5 text-sm font-medium text-white">
            去登录
          </button>
        </div>
      ) : (
        <>
          <button
            onClick={() => void upload()}
            disabled={busy}
            className="h-12 w-full rounded-btn bg-accent text-base font-semibold text-white disabled:opacity-40"
          >
            {busy ? '处理中…' : '立即备份到云端'}
          </button>
          <p className="mt-2 px-1 text-[11px] text-ink-3">
            服务器只保留最近 3 份备份；开启「自动同步」后满足条件会静默备份（设置里可开）。
            {autoSync ? '（已开启）' : ''}
          </p>
        </>
      )}

      {/* 本地导出：不需要登录，随时可把当前数据导出成 .flyme 文件 */}
      <div className="mt-4 rounded-card border border-line bg-surface p-3.5">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-sm font-medium">导出备份文件</p>
          <Download className="h-4 w-4 text-ink-3" aria-hidden />
        </div>
        <p className="mt-0.5 text-[11px] text-ink-3">
          把当前全部数据导出为 .flyme 文件（网页版可直接导入）；可选密码加密，密码不保存在应用里，忘记后无法恢复。
        </p>
        <button
          onClick={() => setExportTarget({ kind: 'local' })}
          disabled={busy}
          className="mt-2.5 h-9 w-full rounded-btn bg-accent-soft text-xs font-medium text-accent disabled:opacity-40"
        >
          导出当前数据（可选密码）
        </button>
      </div>

      {/* 备份列表 */}
      <h3 className="mb-2 mt-5 px-1 text-xs font-semibold text-ink-3">云端备份（最新在前）</h3>
      {loading ? (
        <p className="py-6 text-center text-sm text-ink-3">加载中…</p>
      ) : loadError ? (
        <p className="rounded-card border border-line bg-surface p-4 text-center text-sm" style={{ color: 'var(--fou)' }}>
          {loadError}
        </p>
      ) : rows.length === 0 ? (
        <div className="rounded-card border border-dashed border-line bg-surface p-8 text-center text-sm text-ink-3">
          {ready ? '还没有云备份，点上方按钮创建第一份' : '登录后可见'}
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-card border border-line bg-surface p-3.5">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{row.label || `备份 #${row.id}`}</p>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">{row.item_count} 条</span>
              </div>
              <p className="mt-0.5 text-[11px] text-ink-3">
                {fmtTimestamp(row.created_at) || row.created_at}
                {row.device ? ` · ${row.device}` : ''}
                {row.bytes ? ` · ${(row.bytes / 1024).toFixed(1)} KB` : ''}
              </p>
              <div className="mt-2.5 flex gap-2">
                <button
                  onClick={() => void restore(row)}
                  disabled={busy}
                  className="h-8 flex-1 rounded-btn bg-accent-soft text-xs font-medium text-accent disabled:opacity-40"
                >
                  恢复
                </button>
                <button
                  onClick={() => setExportTarget({ kind: 'cloud', row })}
                  disabled={busy}
                  className="h-8 flex-1 rounded-btn bg-accent-soft text-xs font-medium text-accent disabled:opacity-40"
                >
                  下载
                </button>
                <button
                  onClick={() => void del(row)}
                  disabled={busy}
                  className="h-8 flex-1 rounded-btn border border-line text-xs disabled:opacity-40"
                  style={{ color: 'var(--fou)' }}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 导出弹层（★createPortal 到 body；密码输入非受控，规避安卓 IME） */}
      {exportTarget !== null ? (
        <ExportPasswordDialog
          title={exportTarget.kind === 'local' ? '导出备份文件' : '下载云端备份'}
          hint={
            exportTarget.kind === 'local'
              ? '将当前全部数据导出为 .flyme 文件，可留空密码（不加密）。'
              : `将云端备份「${exportTarget.row.label || `#${exportTarget.row.id}`}」导出为 .flyme 文件，可留空密码（不加密）。`
          }
          busy={busy}
          onClose={() => {
            if (!busy) setExportTarget(null);
          }}
          onConfirm={(pwd) => void doExport(pwd)}
        />
      ) : null}
    </PageShell>
  );
}

/**
 * 导出密码输入弹层。
 *
 * ★硬约束：
 * - 必须 createPortal 到 document.body（WebView 层级/滚动约束）；
 * - 密码输入**非受控**（defaultValue + ref 读值）——受控 useState 输入在
 *   安卓 WebView IME 下显示值与实际值不同步。
 */
function ExportPasswordDialog(props: {
  title: string;
  hint: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (password: string) => void;
}) {
  const pwdRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    if (props.busy) return;
    props.onConfirm(pwdRef.current?.value ?? '');
  };

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={props.onClose}>
      <div
        className="sheet-enter mx-auto w-full max-w-xl rounded-t-2xl bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}
      >
        <h2 className="mb-3 text-base font-semibold">{props.title}</h2>
        <div className="space-y-3">
          <PageField label="加密密码（可选）" hint={props.hint}>
            <input
              ref={pwdRef}
              type="text"
              defaultValue=""
              placeholder="留空则不加密"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="done"
              className="h-11 w-full nw-input"
            />
          </PageField>
          <p className="text-[11px] text-ink-3">
            加密采用 AES-256-GCM + PBKDF2（与网页版导出格式一致）；密码不会保存在应用里，忘记后无法恢复。
          </p>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            onClick={props.onClose}
            disabled={props.busy}
            className="h-11 flex-1 rounded-btn border border-line text-sm disabled:opacity-40"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={props.busy}
            className="h-11 flex-1 rounded-btn bg-accent text-sm font-semibold text-white disabled:opacity-40"
          >
            {props.busy ? '处理中…' : '导出并保存'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
