import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Download, Upload } from 'lucide-react';
import PageShell from '../components/layout/PageShell';
import PageField from '../components/ui/PageField';
import { useAuthStore, useServerStore, useSettingsStore, useUiStore, toastError, toastSuccess, fetchBackupList, restoreBackup, uploadBackup, deleteRemoteBackup, importBackupPayload, currentServer } from '../store';
import type { BackupRow } from '../types/api';
import { humanMessage } from '../lib/error';
import { fmtTimestamp } from '../lib/date';
import { exportCloudBackup, exportLocalBackup } from '../lib/backupExport';
import {
  BACKUP_FILE_ACCEPT,
  looksLikeBackup,
  previewBackupBytes,
  readBackupFile,
  type BackupFilePreview,
} from '../lib/backupImport';
import { isEncryptedFlyme } from '../lib/flymeFile';

/**
 * P21 备份与恢复（★服务端只保留最近 3 份）。
 *
 * v0.6.0 增强：本地数据与云端备份均可「导出 .flyme 文件」，
 * 可选密码加密（AES-256-GCM + PBKDF2，与网页版导出格式二进制互通，
 * 见 src/lib/flymeFile.ts 的格式逆向说明）。真机走 Filesystem 落盘
 * + Share 系统分享面板；浏览器 dev 直接触发下载。
 *
 * ★v1.0.34 补齐反向链路：新增「导入备份文件」——
 * 选一份 .flyme（或网页版导出的 JSON）→ 解密 → 预览摘要 → 确认后覆盖本机数据，
 * 可选同时上传一份到云端。此前只有导出没有导入，用户换机/误删后拿着文件无从恢复。
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

  /* ---------------- 导入备份文件（v1.0.34） ---------------- */

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 待输密码的加密备份（选了加密文件才会出现） */
  const [importAskPwd, setImportAskPwd] = useState<{ fileName: string; bytes: Uint8Array } | null>(null);
  const [importPwdError, setImportPwdError] = useState('');
  /** 解析成功的备份预览（确认弹层） */
  const [importPreview, setImportPreview] = useState<BackupFilePreview | null>(null);

  /** 导入后「同时上传云端」需要登录 + 已配服务器。 */
  const canUploadAfterImport = ready;

  /** 解密并按预览弹层。失败时：密码弹层还开着就显示在弹层内，否则走 Toast。 */
  const previewBytes = async (fileName: string, bytes: Uint8Array, password: string) => {
    setBusy(true);
    try {
      const p = await previewBackupBytes(fileName, bytes, password);
      setImportAskPwd(null);
      setImportPwdError('');
      setImportPreview(p);
    } catch (e) {
      const msg = humanMessage(e);
      if (importAskPwd) setImportPwdError(msg);
      else toastError(msg);
    } finally {
      setBusy(false);
    }
  };

  const onFilePicked = async (file: File) => {
    try {
      const bytes = await readBackupFile(file);
      if (!looksLikeBackup(bytes)) {
        toastError('这不是备份文件（.flyme 或备份 JSON），请重新选择');
        return;
      }
      if (isEncryptedFlyme(bytes)) {
        setImportPwdError('');
        setImportAskPwd({ fileName: file.name, bytes });
        return;
      }
      await previewBytes(file.name, bytes, '');
    } catch (e) {
      toastError(humanMessage(e));
    }
  };

  /** 确认导入：覆盖本机数据；upload=true 时顺带往云端传一份。 */
  const doImport = async (upload: boolean) => {
    const p = importPreview;
    if (!p || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await importBackupPayload(p.payload, { upload });
      let msg = `已导入「${p.fileName}」，恢复 ${r.total} 条记录`;
      if (r.exportedAt) msg += `（备份时间 ${fmtTimestamp(r.exportedAt)}）`;
      if (r.restoredIcons > 0) msg += `，含图标缓存 ${r.restoredIcons} 个`;
      if (upload) {
        msg += r.uploaded ? '，并已同步一份到云端' : `（云端同步失败：${r.uploadError ?? '未知原因'}）`;
      }
      useUiStore.getState().toast(msg, 'success', { durationMs: 8000 });
      setImportPreview(null);
      if (ready) await load();
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

      {/* 本地导入：不需要登录，拿着 .flyme 文件即可恢复（v1.0.34 新增） */}
      <div className="mt-3 rounded-card border border-line bg-surface p-3.5">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-sm font-medium">导入备份文件</p>
          <Upload className="h-4 w-4 text-ink-3" aria-hidden />
        </div>
        <p className="mt-0.5 text-[11px] text-ink-3">
          选择之前导出的 .flyme 文件，把里面的数据恢复到本机（会覆盖当前全部数据）。加密文件需输入导出时设置的密码；不登录也能用。
        </p>
        <button
          onClick={() => {
            if (!busy) fileInputRef.current?.click();
          }}
          disabled={busy}
          className="mt-2.5 h-9 w-full rounded-btn bg-accent-soft text-xs font-medium text-accent disabled:opacity-40"
        >
          选择备份文件并导入
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={BACKUP_FILE_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void onFilePicked(f);
          }}
        />
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

      {/* 导入-密码弹层（选中的是加密备份时出现） */}
      {importAskPwd !== null ? (
        <ImportPasswordDialog
          fileName={importAskPwd.fileName}
          error={importPwdError}
          busy={busy}
          onClose={() => {
            if (!busy) {
              setImportAskPwd(null);
              setImportPwdError('');
            }
          }}
          onConfirm={(pwd) => void previewBytes(importAskPwd.fileName, importAskPwd.bytes, pwd)}
        />
      ) : null}

      {/* 导入-确认弹层（解析成功、覆盖前最后一道闸） */}
      {importPreview !== null ? (
        <ImportConfirmDialog
          preview={importPreview}
          busy={busy}
          canUpload={canUploadAfterImport}
          onClose={() => {
            if (!busy) setImportPreview(null);
          }}
          onImport={(upload) => void doImport(upload)}
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

/**
 * 导入-密码弹层（v1.0.34）。
 *
 * 与导出侧 `ExportPasswordDialog` 同样的两条硬约束：必须 createPortal 到
 * document.body、密码输入**非受控**（安卓 WebView IME 下受控输入会显示值与实际值不同步）。
 * 额外多一行错误提示，密码输错可以原地重输，不必重新选文件。
 */
function ImportPasswordDialog(props: {
  fileName: string;
  error: string;
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
        <h2 className="mb-1 text-base font-semibold">这份备份已加密</h2>
        <p className="mb-3 break-all text-[11px] text-ink-3">文件：{props.fileName}</p>
        <div className="space-y-3">
          <PageField label="备份密码" hint="输入导出这份备份时设置的密码；密码不保存在应用里，忘记后无法恢复。">
            <input
              ref={pwdRef}
              type="text"
              defaultValue=""
              placeholder="请输入密码"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="done"
              className="h-11 w-full nw-input"
            />
          </PageField>
          {props.error ? (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>
              {props.error}
            </p>
          ) : null}
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
            {props.busy ? '解密中…' : '解密并预览'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 导入-确认弹层（v1.0.34）：解析成功、真正覆盖本机数据之前的最后一道闸。
 *
 * 把「要覆盖什么」摊开给用户看（文件名 / 条数 / 备份时间 / 是否加密 / 来源），
 * 再让用户点确认；已登录且配了服务器时，额外给一颗「同时上传云端」的按钮。
 */
function ImportConfirmDialog(props: {
  preview: BackupFilePreview;
  busy: boolean;
  canUpload: boolean;
  onClose: () => void;
  onImport: (upload: boolean) => void;
}) {
  const p = props.preview;
  const timeText = p.exportedAt ? fmtTimestamp(p.exportedAt) : '未知时间';

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={props.onClose}>
      <div
        className="sheet-enter mx-auto w-full max-w-xl rounded-t-2xl bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}
      >
        <h2 className="mb-3 text-base font-semibold">导入这份备份？</h2>
        <div className="rounded-card border border-line bg-surface-2 p-3 text-xs leading-6 text-ink-2">
          <p className="break-all">
            文件：<span className="text-ink">{p.fileName}</span>
          </p>
          <p>
            内容：<span className="text-ink">{p.count} 条记录</span>（备份于 {timeText}）
          </p>
          <p>
            加密：{p.encrypted ? '已加密（密码已通过）' : '未加密'}
            {p.app ? ` · 来源 ${p.app}` : ''}
          </p>
        </div>
        <p
          className="mt-3 rounded-card border p-3 text-[11px] leading-5"
          style={{ borderColor: 'var(--danger-soft)', background: 'var(--danger-soft)', color: 'var(--danger)' }}
        >
          ⚠ 导入会用备份内容覆盖本机全部数据（12 个集合与设置），且无法撤销。
          建议先「导出当前数据」留一份再导入。
        </p>
        <div className="mt-4 space-y-2">
          <div className="flex gap-2">
            <button
              onClick={props.onClose}
              disabled={props.busy}
              className="h-11 flex-1 rounded-btn border border-line text-sm disabled:opacity-40"
            >
              取消
            </button>
            <button
              onClick={() => props.onImport(false)}
              disabled={props.busy}
              className="h-11 flex-1 rounded-btn bg-accent text-sm font-semibold text-white disabled:opacity-40"
            >
              {props.busy ? '导入中…' : '仅恢复到本机'}
            </button>
          </div>
          {props.canUpload ? (
            <button
              onClick={() => props.onImport(true)}
              disabled={props.busy}
              className="h-10 w-full rounded-btn bg-accent-soft text-xs font-medium text-accent disabled:opacity-40"
            >
              同时上传一份到云端备份
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
