import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Database, Download, KeyRound, LogOut, Mail, RefreshCw, Shield, ShieldCheck, ToggleLeft, ToggleRight, UserCog, Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { request } from '../net/httpClient';
import { ApiError } from '../lib/error';
import { currentServer, toastError, toastSuccess, useUiStore } from '../store';
import type { ServerConfig } from '../types/entities';
import { compressIconFile } from '../lib/brandIcon';
import {
  cancelJob,
  checkServerUpdate,
  fetchAppRelease,
  fetchJob,
  fetchServerInfo,
  fetchSource,
  publishAppRelease,
  rollbackServer,
  runMigration,
  saveSource,
  startServerUpdate,
  testSource,
} from '../api/serverUpdate';
import type { AppReleaseManifest, ServerUpdateInfo, UpdateCheckResult, UpdateJob } from '../api/serverUpdate';

/**
 * 管理后台（v1.0.7 起并入统一代码库，替代旧 PC 网页的 /#/admin）：
 * - 管理员账号与用户账号相互独立（flyme_admins 表，X-Admin-Token 鉴权）；
 * - 功能：注册/登录控制 · 功能开关 · 站点名称/图标 · 全站公告 · 用户管理
 *   （验证/停用/重置密码/删除）· 邮件服务（SMTP 配置/测试/清除）
 *   · 数据库（连接信息/手动改连/测试连接）· 管理员改密。
 * - 管理员无法查看或修改用户记录数据——用户数据始终只属于用户本人。
 */

const TOKEN_KEY = 'gf.adminToken';

interface AdminUserRow {
  email: string;
  display_name: string;
  verified: boolean;
  disabled: boolean;
  created_at: string;
  last_login_at: string;
}

interface AdminSettings {
  [key: string]: string;
}

const SWITCHES: Array<{ key: string; label: string; desc: string }> = [
  { key: 'siteClosed', label: '关闭站点', desc: '维护模式：除管理后台外全部不可用' },
  { key: 'allowRegister', label: '允许注册', desc: '关闭后新用户无法注册' },
  { key: 'allowLogin', label: '允许登录', desc: '关闭后用户无法登录（已登录不受影响）' },
  { key: 'requireVerified', label: '邮箱验证后才能登录', desc: '要求用户先完成邮箱验证' },
  { key: 'featAi', label: 'AI 记一笔', desc: '自然语言记账入口' },
  { key: 'featOcr', label: '识图添加', desc: 'AI 记一笔内拍照/截图识别记账' },
  { key: 'featShare', label: '分享生图', desc: '物品详情/置物墙生成分享卡片' },
  { key: 'featWall', label: '置物墙', desc: '在役物品墙展示页（我的 → 置物墙）' },
  { key: 'featSync', label: '云同步', desc: '多端数据同步' },
];

function adminHeaders(token: string): Record<string, string> {
  return { 'X-Admin-Token': token };
}

export default function AdminPage(): JSX.Element {
  const nav = useNavigate();
  const [token, setToken] = useState<string>(() => {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [tab, setTab] = useState<'users' | 'switches' | 'mail' | 'db' | 'update' | 'security'>('users');
  const [updateDot, setUpdateDot] = useState(false);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [settings, setSettings] = useState<AdminSettings>({});
  const [admins, setAdmins] = useState<Array<{ username: string; display_name: string; created_at: string }>>([]);
  const [busy, setBusy] = useState(false);

  /** 请求时实时解析当前服务器（自动注册是异步的，渲染时可能还没有）。 */
  const serverNow = (): ServerConfig | null => currentServer();

  /** 统一 admin 请求：带 X-Admin-Token，ok!==true 抛错。 */
  const adminPost = useCallback(
    async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
      const res = await request<Record<string, unknown>>(serverNow(), {
        method: 'POST',
        path,
        body: body ?? {},
        auth: false,
        retry: 0,
        ignoreUnauth: true,
        headers: token ? adminHeaders(token) : undefined,
      });
      if (!res.data || res.data.ok !== true) {
        throw new ApiError('http', (res.data as { error?: string })?.error ?? '请求失败', res.status, res.data);
      }
      return res.data;
    },
    [serverNow, token],
  );

  const adminGet = useCallback(
    async (path: string): Promise<Record<string, unknown>> => {
      const res = await request<Record<string, unknown>>(serverNow(), {
        method: 'GET',
        path,
        auth: false,
        ignoreUnauth: true,
        headers: token ? adminHeaders(token) : undefined,
      });
      if (!res.data || res.data.ok !== true) {
        throw new ApiError('http', (res.data as { error?: string })?.error ?? '请求失败', res.status, res.data);
      }
      return res.data;
    },
    [serverNow, token],
  );

  const loadAll = useCallback(async (): Promise<void> => {
    if (!token) return;
    setBusy(true);
    try {
      const [u, s, m] = await Promise.all([
        adminGet('/api/admin/users'),
        adminGet('/api/admin/settings'),
        adminGet('/api/admin/me'),
      ]);
      setUsers((u.rows as AdminUserRow[]) ?? []);
      setSettings((s.settings as AdminSettings) ?? {});
      setAdmins((m.admins as Array<{ username: string; display_name: string; created_at: string }>) ?? []);
    } catch (e) {
      // token 失效 → 退回登录
      if (e instanceof ApiError && e.status === 401) {
        try {
          localStorage.removeItem(TOKEN_KEY);
        } catch { /* ignore */ }
        setToken('');
      } else {
        toastError(e instanceof Error ? e.message : '加载失败');
      }
    } finally {
      setBusy(false);
    }
  }, [adminGet, token]);

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /* ---------------- 登录卡 ---------------- */
  if (!token) {
    return (
      <LoginPage
        onLogin={(t) => {
          try {
            localStorage.setItem(TOKEN_KEY, t);
          } catch { /* ignore */ }
          setToken(t);
        }}
        serverNow={serverNow}
      />
    );
  }

  /* ---------------- 后台主体 ---------------- */
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-16 pt-6 sm:px-6">
      {/* 头部 */}
      <div className="mb-5 flex items-center gap-3">
        <button
          onClick={() => nav('/me')}
          aria-label="返回"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink-2 active:bg-surface-2"
        >
          <ArrowLeft size={18} strokeWidth={1.8} aria-hidden />
        </button>
        <span className="text-accent">
          <Shield size={22} strokeWidth={1.8} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="t-h2 leading-tight">管理后台</h1>
          <p className="text-xs text-ink-3">注册与登录控制 · 用户管理 · 功能开关 · 管理员账号</p>
        </div>
        <button
          onClick={() => void loadAll()}
          aria-label="刷新"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink-2 active:bg-surface-2"
        >
          <RefreshCw size={16} strokeWidth={1.8} className={busy ? 'animate-spin' : ''} aria-hidden />
        </button>
      </div>

      {/* Tab */}
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-card border border-line bg-surface p-1">
        {(
          [
            ['users', '用户管理', Users],
            ['switches', '站点开关', ToggleLeft],
            ['mail', '邮件服务', Mail],
            ['db', '数据库', Database],
            ['update', '在线更新', Download],
            ['security', '账号安全', KeyRound],
          ] as Array<[typeof tab, string, LucideIcon]>
        ).map(([k, label, Icon]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`relative flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-btn px-3 py-2 text-sm transition-colors ${
              tab === k ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-3'
            }`}
          >
            <Icon size={16} strokeWidth={1.8} aria-hidden />
            {label}
            {k === 'update' && updateDot ? (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-danger" aria-label="有新版本" />
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'users' ? <UsersTab users={users} adminPost={adminPost} reload={() => void loadAll()} /> : null}
      {tab === 'switches' ? <SwitchesTab settings={settings} adminPost={adminPost} reload={() => void loadAll()} /> : null}
      {tab === 'mail' ? <MailTab adminGet={adminGet} adminPost={adminPost} /> : null}
      {tab === 'db' ? <DbTab adminGet={adminGet} adminPost={adminPost} /> : null}
      {tab === 'update' ? <ServerUpdateTab token={token} onDot={setUpdateDot} /> : null}
      {tab === 'security' ? <SecurityTab admins={admins} adminPost={adminPost} onLogout={() => setToken('')} /> : null}
    </div>
  );
}

/* ---------------- 登录 ---------------- */

function LoginPage({ onLogin, serverNow }: { onLogin: (token: string) => void; serverNow: () => ServerConfig | null }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const username = String(fd.get('username') ?? '').trim();
    const password = String(fd.get('password') ?? '');
    if (!username || !password) return;
    setBusy(true);
    setErr('');
    try {
      const res = await request<{ ok: boolean; token?: string; error?: string }>(serverNow(), {
        method: 'POST',
        path: '/api/admin/login',
        body: { username, password },
        auth: false,
        retry: 0,
        ignoreUnauth: true,
      });
      if (res.data?.ok === true && res.data.token) {
        onLogin(res.data.token);
      } else {
        setErr(res.data?.error ?? '登录失败');
      }
    } catch (e) {
      // 401 等 ApiError 的 message 已是服务端文案（如「用户名或密码不正确」）
      setErr(e instanceof Error ? e.message : '网络错误，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm rounded-card border border-line bg-surface p-6 shadow-lg">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <ShieldCheck size={24} strokeWidth={1.8} aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">管理后台</h1>
            <p className="text-xs text-ink-3">仅限管理员，普通用户无需访问</p>
          </div>
        </div>
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <input
            name="username"
            placeholder="管理员用户名"
            autoComplete="username"
            className="h-11 w-full nw-input"
          />
          <input
            name="password"
            type="password"
            placeholder="密码"
            autoComplete="current-password"
            className="h-11 w-full nw-input"
          />
          {err ? <p className="text-xs" style={{ color: 'var(--danger)' }}>{err}</p> : null}
          <button
            type="submit"
            disabled={busy}
            className="h-11 w-full rounded-btn bg-accent text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? '登录中…' : '进入后台'}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ---------------- 用户管理 ---------------- */

function UsersTab({
  users,
  adminPost,
  reload,
}: {
  users: AdminUserRow[];
  adminPost: (path: string, body?: unknown) => Promise<Record<string, unknown>>;
  reload: () => void;
}): JSX.Element {
  const act = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : '操作失败');
    }
  };

  return (
    <div className="space-y-2">
      {users.length === 0 ? <p className="px-1 py-8 text-center text-sm text-ink-3">暂无用户</p> : null}
      {users.map((u) => (
        <div key={u.email} className="rounded-card border border-line bg-surface p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{u.display_name || '（未设昵称）'}</p>
              <p className="truncate text-xs text-ink-3">{u.email}</p>
            </div>
            <span
              className="rounded-full px-2 py-0.5 text-[11px]"
              style={{
                background: u.disabled ? 'var(--danger-soft)' : 'var(--accent-soft)',
                color: u.disabled ? 'var(--danger)' : 'var(--accent)',
              }}
            >
              {u.disabled ? '已停用' : '正常'}
            </span>
            <span
              className="rounded-full px-2 py-0.5 text-[11px]"
              style={{
                background: u.verified ? 'var(--accent-soft)' : 'var(--warn-soft)',
                color: u.verified ? 'var(--accent)' : 'var(--warn)',
              }}
            >
              {u.verified ? '已验证' : '未验证'}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-ink-3">
            注册 {u.created_at?.slice(0, 10) ?? '—'} · 最近登录 {u.last_login_at ? u.last_login_at.slice(0, 16).replace('T', ' ') : '从未'}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <MiniBtn
              onClick={() =>
                void act(async () => {
                  await adminPost('/api/admin/users/verify', { email: u.email, verified: !u.verified });
                  toastSuccess(u.verified ? '已取消验证' : '已通过验证');
                })
              }
            >
              {u.verified ? '取消验证' : '通过验证'}
            </MiniBtn>
            <MiniBtn
              onClick={() =>
                void act(async () => {
                  await adminPost('/api/admin/users/disable', { email: u.email, disabled: !u.disabled });
                  toastSuccess(u.disabled ? '已启用' : '已停用');
                })
              }
            >
              {u.disabled ? '启用' : '停用'}
            </MiniBtn>
            <MiniBtn
              onClick={() => {
                const np = window.prompt(`为 ${u.email} 设置新密码（至少 6 位）：`);
                if (!np) return;
                void act(async () => {
                  await adminPost('/api/admin/users/password', { email: u.email, newPassword: np });
                  toastSuccess('密码已重置');
                });
              }}
            >
              重置密码
            </MiniBtn>
            <MiniBtn
              danger
              onClick={() => {
                if (!window.confirm(`确定删除用户 ${u.email}？该用户的云备份与资料将一并清除，且不可恢复。`)) return;
                void act(async () => {
                  await adminPost('/api/admin/users/delete', { email: u.email });
                  toastSuccess('已删除');
                });
              }}
            >
              删除
            </MiniBtn>
          </div>
        </div>
      ))}
    </div>
  );
}

function MiniBtn({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="rounded-full border border-line px-3 py-1 text-xs text-ink-2 transition-colors active:bg-surface-2"
      style={danger ? { color: 'var(--danger)' } : undefined}
    >
      {children}
    </button>
  );
}

/* ---------------- 站点开关 ---------------- */

function SwitchesTab({
  settings,
  adminPost,
  reload,
}: {
  settings: AdminSettings;
  adminPost: (path: string, body?: unknown) => Promise<Record<string, unknown>>;
  reload: () => void;
}): JSX.Element {
  const [busyKey, setBusyKey] = useState('');
  const [notice, setNotice] = useState('');
  const [siteName, setSiteName] = useState<string | null>(null);
  const [siteIcon, setSiteIcon] = useState<string | null>(null);
  const iconFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setNotice(settings.notice ?? '');
    setSiteName(settings.siteName ?? '');
    setSiteIcon(settings.siteIcon ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const flip = async (key: string): Promise<void> => {
    setBusyKey(key);
    try {
      await adminPost('/api/admin/settings', { key, value: settings[key] === 'true' ? 'false' : 'true' });
      reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusyKey('');
    }
  };

  const saveText = async (key: string, value: string): Promise<void> => {
    setBusyKey(key);
    try {
      await adminPost('/api/admin/settings', { key, value });
      toastSuccess('已保存');
      reload();
    } catch (e) {
      toastError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusyKey('');
    }
  };

  return (
    <div className="space-y-2">
      {SWITCHES.map((s) => {
        const on = settings[s.key] === 'true';
        return (
          <div key={s.key} className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                {s.label}
              </p>
              <p className="text-[11px] text-ink-3">{s.desc}</p>
            </div>
            <button
              onClick={() => void flip(s.key)}
              disabled={busyKey === s.key}
              aria-label={s.label}
              className={on ? 'text-accent' : 'text-ink-3'}
            >
              {on ? <ToggleRight size={26} strokeWidth={1.6} aria-hidden /> : <ToggleLeft size={26} strokeWidth={1.6} aria-hidden />}
            </button>
          </div>
        );
      })}

      <div className="rounded-card border border-line bg-surface p-4">
        <p className="text-sm font-medium">站点名称</p>
        <div className="mt-2 flex gap-2">
          <input
            defaultValue={siteName ?? ''}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder="留空使用默认「纳物」"
            className="h-10 min-w-0 flex-1 nw-input"
          />
          <button
            onClick={() => void saveText('siteName', siteName ?? '')}
            disabled={busyKey === 'siteName'}
            className="h-10 rounded-btn bg-accent px-4 text-sm font-medium text-white disabled:opacity-60"
          >
            保存
          </button>
        </div>
      </div>

      <div className="rounded-card border border-line bg-surface p-4">
        <p className="text-sm font-medium">站点图标</p>
        <p className="mt-0.5 text-[11px] text-ink-3">显示在浏览器标签页与登录页；支持图片链接或本地上传（自动压缩）</p>
        <div className="mt-2 flex items-center gap-3">
          {siteIcon ? (
            <img
              src={siteIcon}
              alt="站点图标"
              className="h-12 w-12 shrink-0 rounded-xl border border-line object-contain p-1"
              onError={(e) => {
                (e.target as HTMLImageElement).style.opacity = '0.3';
              }}
            />
          ) : (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-dashed border-line text-xs text-ink-3">
              无
            </span>
          )}
          <input
            value={siteIcon ?? ''}
            onChange={(e) => setSiteIcon(e.target.value)}
            placeholder="https://…/favicon.png 或上传"
            className="h-10 min-w-0 flex-1 nw-input"
          />
        </div>
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => iconFileRef.current?.click()}
            className="h-9 rounded-full border border-line px-4 text-xs text-ink-2 active:bg-surface-2"
          >
            本地上传
          </button>
          <input
            ref={iconFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                const data = await compressIconFile(f, 128);
                setSiteIcon(data);
                await saveText('siteIcon', data);
              } catch (err) {
                toastError(err instanceof Error ? err.message : '图片处理失败');
              }
            }}
          />
          <button
            onClick={() => {
              setSiteIcon('');
              void saveText('siteIcon', '');
            }}
            disabled={busyKey === 'siteIcon' || !siteIcon}
            className="h-9 rounded-full border border-line px-4 text-xs text-ink-2 disabled:opacity-40"
          >
            清除
          </button>
          <button
            onClick={() => void saveText('siteIcon', siteIcon ?? '')}
            disabled={busyKey === 'siteIcon'}
            className="ml-auto h-9 rounded-btn bg-accent px-4 text-xs font-medium text-white disabled:opacity-60"
          >
            保存图标
          </button>
        </div>
      </div>

      <div className="rounded-card border border-line bg-surface p-4">
        <p className="text-sm font-medium">全站公告</p>
        <textarea
          defaultValue={notice}
          onChange={(e) => setNotice(e.target.value)}
          rows={3}
          placeholder="会显示在登录/注册页；留空不显示"
          className="mt-2 w-full rounded-btn border border-line bg-surface-2 p-3 text-sm outline-none focus:border-accent"
        />
        <button
          onClick={() => void saveText('notice', notice)}
          disabled={busyKey === 'notice'}
          className="mt-2 h-10 rounded-btn bg-accent px-4 text-sm font-medium text-white disabled:opacity-60"
        >
          保存公告
        </button>
      </div>
    </div>
  );
}

/* ---------------- 账号安全 ---------------- */

function SecurityTab({
  admins,
  adminPost,
  onLogout,
}: {
  admins: Array<{ username: string; display_name: string; created_at: string }>;
  adminPost: (path: string, body?: unknown) => Promise<Record<string, unknown>>;
  onLogout: () => void;
}): JSX.Element {
  const [msg, setMsg] = useState('');
  const [nameBusy, setNameBusy] = useState(false);

  /** 修改管理员登录名。 */
  const changeName = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const username = String(new FormData(e.currentTarget).get('username') ?? '').trim();
    if (!username) return;
    setNameBusy(true);
    try {
      await adminPost('/api/admin/username', { username });
      toastSuccess('登录名已更新，下次登录请使用新用户名');
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      toastError(err instanceof Error ? err.message : '修改失败');
    } finally {
      setNameBusy(false);
    }
  };

  const changePwd = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const oldPassword = String(fd.get('old') ?? '');
    const newPassword = String(fd.get('new') ?? '');
    const confirm = String(fd.get('confirm') ?? '');
    if (newPassword !== confirm) {
      setMsg('两次输入的新密码不一致');
      return;
    }
    setMsg('');
    try {
      await adminPost('/api/admin/password', { oldPassword, newPassword });
      toastSuccess('密码已更新');
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      toastError(err instanceof Error ? err.message : '修改失败');
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await adminPost('/api/admin/logout');
    } catch { /* 本地退出即可 */ }
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch { /* ignore */ }
    onLogout();
  };

  return (
    <div className="space-y-2">
      <form onSubmit={(e) => void changeName(e)} className="rounded-card border border-line bg-surface p-4">
        <p className="mb-3 flex items-center gap-2 text-sm font-medium">
          <ShieldCheck size={16} strokeWidth={1.8} className="text-accent" aria-hidden />
          修改管理员登录名
        </p>
        <div className="flex gap-2">
          <input
            name="username"
            defaultValue={admins[0]?.username ?? ''}
            placeholder="新的登录用户名（3-40 字符）"
            autoComplete="username"
            className="h-11 min-w-0 flex-1 nw-input"
          />
          <button type="submit" disabled={nameBusy} className="h-11 shrink-0 rounded-btn bg-accent px-4 text-sm font-medium text-white disabled:opacity-60">
            {nameBusy ? '保存中…' : '更新登录名'}
          </button>
        </div>
      </form>

      <form onSubmit={(e) => void changePwd(e)} className="rounded-card border border-line bg-surface p-4">
        <p className="mb-3 flex items-center gap-2 text-sm font-medium">
          <UserCog size={16} strokeWidth={1.8} className="text-accent" aria-hidden />
          修改管理员密码
        </p>
        <div className="space-y-2">
          <input name="old" type="password" placeholder="当前密码" autoComplete="current-password" className="h-11 w-full nw-input" />
          <input name="new" type="password" placeholder="新密码（至少 6 位）" autoComplete="new-password" className="h-11 w-full nw-input" />
          <input name="confirm" type="password" placeholder="确认新密码" autoComplete="new-password" className="h-11 w-full nw-input" />
          {msg ? <p className="text-xs" style={{ color: 'var(--danger)' }}>{msg}</p> : null}
          <button type="submit" className="h-10 w-full rounded-btn bg-accent text-sm font-medium text-white">
            更新密码
          </button>
        </div>
      </form>

      <div className="rounded-card border border-line bg-surface p-4">
        <p className="mb-2 text-sm font-medium">管理员列表</p>
        <ul className="space-y-1.5">
          {admins.map((a) => (
            <li key={a.username} className="flex items-center justify-between text-sm">
              <span>
                {a.display_name || a.username}
                <span className="ml-2 text-xs text-ink-3">{a.username}</span>
              </span>
              <span className="text-[11px] text-ink-3">{a.created_at?.slice(0, 10) ?? ''}</span>
            </li>
          ))}
        </ul>
      </div>

      <button
        onClick={() => void logout()}
        className="flex w-full items-center justify-center gap-2 rounded-card border py-3 text-sm"
        style={{ borderColor: 'var(--danger-soft)', background: 'var(--danger-soft)', color: 'var(--danger)' }}
      >
        <LogOut size={16} strokeWidth={1.8} aria-hidden />
        退出管理后台
      </button>
    </div>
  );
}

/* ---------------- 邮件服务（SMTP） ---------------- */

interface SmtpConf {
  configured: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
  passMasked?: string;
}

function MailTab({
  adminGet,
  adminPost,
}: {
  adminGet: (path: string) => Promise<Record<string, unknown>>;
  adminPost: (path: string, body?: unknown) => Promise<Record<string, unknown>>;
}): JSX.Element {
  const [conf, setConf] = useState<SmtpConf | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await adminGet('/api/admin/smtp');
      setConf(res as unknown as SmtpConf);
    } catch (e) {
      toastError(e instanceof Error ? e.message : '加载失败');
    }
  }, [adminGet]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {
      host: String(fd.get('host') ?? '').trim(),
      port: Number(fd.get('port')) || 0,
      secure: fd.get('secure') === 'on',
      user: String(fd.get('user') ?? '').trim(),
      from: String(fd.get('from') ?? '').trim(),
    };
    const pass = String(fd.get('pass') ?? '');
    if (pass) body.pass = pass;
    setBusy('save');
    setMsg('');
    try {
      await adminPost('/api/admin/smtp', body);
      toastSuccess('SMTP 配置已保存');
      setMsg('已保存。可用「发送测试邮件」验证。');
      await load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy('');
    }
  };

  const test = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const to = String(new FormData(e.currentTarget).get('to') ?? '').trim();
    if (!to) return;
    setBusy('test');
    setMsg('');
    try {
      await adminPost('/api/admin/smtp/test', { to });
      toastSuccess('测试邮件已发送');
      setMsg(`测试邮件已发送至 ${to}，请查收。`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '发送失败');
      toastError('测试邮件发送失败');
    } finally {
      setBusy('');
    }
  };

  const clear = async (): Promise<void> => {
    if (!window.confirm('确定清除 SMTP 配置？清除后注册验证码邮件将无法发送。')) return;
    setBusy('clear');
    try {
      await adminPost('/api/admin/smtp/clear');
      toastSuccess('已清除');
      await load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy('');
    }
  };

  const inputCls =
    'h-10 w-full nw-input';

  return (
    <div className="space-y-2">
      <div className="rounded-card border border-line bg-surface p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">发件邮箱（SMTP）</p>
          <span
            className="rounded-full px-2 py-0.5 text-[11px]"
            style={{
              background: conf?.configured ? 'var(--accent-soft)' : 'var(--warn-soft)',
              color: conf?.configured ? 'var(--accent)' : 'var(--warn)',
            }}
          >
            {conf?.configured ? '已配置' : '未配置'}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-ink-3">
          用于发送注册/找回密码验证码。{conf?.configured ? `当前：${conf.host}:${conf.port}（${conf.user}）` : '尚未配置。'}
        </p>
        <form onSubmit={(e) => void save(e)} className="mt-3 grid gap-2 sm:grid-cols-2">
          <input name="host" defaultValue={conf?.host ?? ''} placeholder="SMTP 服务器（如 smtp.qq.com）" className={inputCls} />
          <input name="port" defaultValue={conf?.port ? String(conf.port) : '465'} placeholder="端口（465/587/25）" inputMode="numeric" className={inputCls} />
          <input name="user" defaultValue={conf?.user ?? ''} placeholder="发件账号（邮箱）" autoComplete="off" className={inputCls} />
          <input name="pass" type="password" placeholder="密码/授权码（留空保持不变）" autoComplete="new-password" className={inputCls} />
          <input name="from" defaultValue={conf?.from ?? ''} placeholder="发件人地址（一般同账号）" className={inputCls} />
          <label className="flex items-center gap-2 text-xs text-ink-2">
            <input name="secure" type="checkbox" defaultChecked={conf?.secure ?? true} className="h-4 w-4 accent-[var(--accent)]" />
            SSL/TLS（端口 465 勾选）
          </label>
          <button type="submit" disabled={busy === 'save'} className="h-10 rounded-btn bg-accent text-sm font-medium text-white disabled:opacity-60 sm:col-span-2">
            {busy === 'save' ? '保存中…' : '保存 SMTP 配置'}
          </button>
        </form>
      </div>

      <form onSubmit={(e) => void test(e)} className="rounded-card border border-line bg-surface p-4">
        <p className="text-sm font-medium">发送测试邮件</p>
        <div className="mt-2 flex gap-2">
          <input name="to" type="email" required placeholder="你的邮箱" className={`${inputCls} min-w-0 flex-1`} />
          <button type="submit" disabled={busy === 'test'} className="h-10 shrink-0 rounded-btn border border-accent px-4 text-sm font-medium text-accent disabled:opacity-60">
            {busy === 'test' ? '发送中…' : '发送测试'}
          </button>
        </div>
      </form>

      <div className="rounded-card border border-line bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-xs text-ink-3">{msg || '配置保存后即可用测试邮件验证连通性。'}</p>
          <button
            onClick={() => void clear()}
            disabled={busy === 'clear' || !conf?.configured}
            className="h-9 shrink-0 rounded-full border px-4 text-xs disabled:opacity-40"
            style={{ color: 'var(--danger)', borderColor: 'var(--danger-soft)' }}
          >
            清除配置
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 数据库 ---------------- */

interface DbInfo {
  connected: boolean;
  error?: string;
  host?: string;
  database?: string;
  user?: string;
  latencyMs?: number;
  tables?: string[];
  rowCount?: number;
  driver?: string;
}

interface DbConf {
  host: string;
  port: number;
  user: string;
  database: string;
  passMasked: string;
  connected: boolean;
  dbError?: string;
}

function DbTab({
  adminGet,
  adminPost,
}: {
  adminGet: (path: string) => Promise<Record<string, unknown>>;
  adminPost: (path: string, body?: unknown) => Promise<Record<string, unknown>>;
}): JSX.Element {
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [conf, setConf] = useState<DbConf | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  /* ---------------- 导入备份（v1.0.34） ---------------- */
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [includeAdmins, setIncludeAdmins] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const importFileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [i, c] = await Promise.all([adminGet('/api/admin/dbinfo'), adminGet('/api/admin/dbconf')]);
      setInfo(i as unknown as DbInfo);
      setConf(c as unknown as DbConf);
    } catch (e) {
      toastError(e instanceof Error ? e.message : '加载失败');
    }
  }, [adminGet]);

  useEffect(() => {
    void load();
  }, [load]);

  const inputCls =
    'h-10 w-full nw-input';

  /** 提交 dbconf（test=true 只测不存）。 */
  const submitConf = async (form: HTMLFormElement, testOnly: boolean): Promise<void> => {
    const fd = new FormData(form);
    const body: Record<string, unknown> = {
      host: String(fd.get('host') ?? '').trim(),
      port: Number(fd.get('port')) || 3306,
      user: String(fd.get('user') ?? '').trim(),
      name: String(fd.get('name') ?? '').trim(),
    };
    const pass = String(fd.get('pass') ?? '');
    if (pass) body.pass = pass;
    setBusy(testOnly ? 'test' : 'save');
    setMsg('');
    try {
      await adminPost(testOnly ? '/api/admin/dbconf/test' : '/api/admin/dbconf', body);
      if (testOnly) {
        setMsg('连接成功，配置可用。点「保存并切换」生效。');
        toastSuccess('连接成功');
      } else {
        setMsg('配置已保存并重新连接。');
        toastSuccess('数据库配置已保存');
        await load();
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '操作失败');
      toastError(testOnly ? '连接失败' : '保存失败');
    } finally {
      setBusy('');
    }
  };

  /** 导出备份为 JSON 文件下载。 */
  const exportBackup = async (scope: 'all' | 'site'): Promise<void> => {
    setBusy(scope);
    setMsg('');
    try {
      const res = await adminGet(`/api/admin/backup?scope=${scope}`);
      const dump = {
        app: 'nawu',
        exportedAt: new Date().toISOString(),
        scope,
        tables: res.tables ?? {},
      };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `nawu-backup-${scope}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      const n = Object.values(dump.tables as Record<string, unknown[]>).reduce((acc, v) => acc + (Array.isArray(v) ? v.length : 0), 0);
      setMsg(`备份已下载（${Object.keys(dump.tables as object).length} 张表 / ${n} 行）。可在下方「导入备份」里把这份文件灌回去。`);
      toastSuccess('备份已下载');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '导出失败');
      toastError('备份导出失败');
    } finally {
      setBusy('');
    }
  };

  /** 读取本地 JSON 文件为文本（FileReader，兼容低版本 WebView）。 */
  const readText = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.onload = () => {
        if (typeof fr.result === 'string') resolve(fr.result);
        else reject(new Error('读取文件失败'));
      };
      fr.readAsText(file);
    });

  /**
   * 导入备份（v1.0.34）：选文件 → 本地预览概要并二次确认 → 交给服务端事务导入。
   *
   * 客户端只做「格式体检 + 让人看清要覆盖什么」；真正的表名/列名白名单校验
   * 与事务回滚都在服务端（app/Api.php 的 /api/admin/backup/import）。
   */
  const doImport = async (file: File): Promise<void> => {
    setBusy('import');
    setImportMsg('');
    try {
      const text = await readText(file);
      let dump: { scope?: string; tables?: Record<string, unknown> } | null = null;
      try {
        dump = JSON.parse(text) as { scope?: string; tables?: Record<string, unknown> };
      } catch {
        throw new Error('备份文件不是合法的 JSON');
      }
      const rawTables = dump && dump.tables;
      if (!rawTables || typeof rawTables !== 'object' || Array.isArray(rawTables)) {
        throw new Error('备份文件里没有 tables 字段（不是本系统「数据备份」导出的文件）');
      }
      const tables = rawTables as Record<string, unknown>;
      const names = Object.keys(tables);
      if (names.length === 0) {
        throw new Error('备份文件里没有任何数据表');
      }
      const rowTotal = names.reduce((acc, k) => acc + (Array.isArray(tables[k]) ? (tables[k] as unknown[]).length : 0), 0);
      const scope = dump && dump.scope === 'site' ? 'site' : 'all';

      const head =
        importMode === 'replace'
          ? `⚠ 覆盖模式：会先【清空】下面这些表再导入，备份之后新增的数据会丢。\n${names.join('、')}`
          : '合并模式：只覆盖同名主键的行，备份里没有的现有数据一律保留。';
      const tail = includeAdmins
        ? '⚠ 已勾选「同时导入管理员表」：导入后后台登录账号与密码会变成备份里的那一套。'
        : '管理员账号表不会被改动。';
      const summary = `范围：${scope === 'site' ? '站点数据' : '全站'} · ${names.length} 张表 · ${rowTotal} 行`;
      if (!window.confirm(`${head}\n\n${summary}\n${tail}\n\n确定现在导入？`)) {
        setBusy('');
        return;
      }

      const res = await adminPost('/api/admin/backup/import', { scope, mode: importMode, includeAdmins, tables });
      const detail = (res.tables ?? {}) as Record<string, { imported?: number; total?: number }>;
      const skipped = (res.skipped ?? []) as Array<{ table?: string; reason?: string }>;
      const lines = Object.keys(detail).map(
        (t) => `  ${t}：导入 ${detail[t]?.imported ?? 0} / 备份 ${detail[t]?.total ?? 0} 行`,
      );
      const skipLines = skipped.map((s) => `  ${s.table ?? '?'}：${s.reason ?? ''}`);
      setImportMsg(
        [
          `导入完成（${importMode === 'replace' ? '覆盖' : '合并'}模式）：${Number(res.tableCount ?? 0)} 张表 / ${Number(res.rowCount ?? 0)} 行。`,
          ...lines,
          ...(skipLines.length ? ['以下表被安全策略跳过：', ...skipLines] : []),
        ].join('\n'),
      );
      toastSuccess('备份导入完成');
      await load();
    } catch (err) {
      const m = err instanceof Error ? err.message : '导入失败';
      setImportMsg(m);
      toastError(m);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-2">
      {/* 备份导出 */}
      <div className="rounded-card border border-line bg-surface p-4">
        <p className="text-sm font-medium">数据备份 / 恢复</p>
        <p className="mt-0.5 text-[11px] text-ink-3">导出为 JSON 文件保存在本地；建议定期下载留存，需要时可在下面直接导入回去。</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            onClick={() => void exportBackup('site')}
            disabled={busy === 'site' || busy === 'import'}
            className="h-10 rounded-btn border border-accent px-4 text-sm font-medium text-accent disabled:opacity-60"
          >
            {busy === 'site' ? '导出中…' : '站点数据备份（用户/云备份/名册）'}
          </button>
          <button
            onClick={() => void exportBackup('all')}
            disabled={busy === 'all' || busy === 'import'}
            className="h-10 rounded-btn border border-accent px-4 text-sm font-medium text-accent disabled:opacity-60"
          >
            {busy === 'all' ? '导出中…' : '全站备份（全部数据表）'}
          </button>
        </div>

        {/* 导入备份（v1.0.34 补的缺口：此前只有导出、没有导入） */}
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-sm font-medium">导入备份</p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            选一份上面导出的 .json 文件灌回当前数据库。服务端会先校验表名与列名白名单，全部写入包在一个事务里，任一步失败自动回滚。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-2">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="nawuImportMode"
                checked={importMode === 'merge'}
                onChange={() => setImportMode('merge')}
              />
              合并（保留现有，同名覆盖）
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="nawuImportMode"
                checked={importMode === 'replace'}
                onChange={() => setImportMode('replace')}
                style={{ accentColor: 'var(--danger)' }}
              />
              <span style={importMode === 'replace' ? { color: 'var(--danger)' } : undefined}>覆盖（先清空再导入）</span>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={includeAdmins} onChange={(e) => setIncludeAdmins(e.target.checked)} />
              同时导入管理员表
            </label>
          </div>
          <button
            onClick={() => {
              if (busy === '') importFileRef.current?.click();
            }}
            disabled={busy !== ''}
            className="mt-2 h-10 rounded-btn border border-accent px-4 text-sm font-medium text-accent disabled:opacity-60"
          >
            {busy === 'import' ? '导入中…' : '选择备份文件并导入'}
          </button>
          <input
            ref={importFileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void doImport(f);
            }}
          />
          {importMsg ? (
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-btn border border-line bg-surface-2 p-3 text-[11px] leading-5 text-ink-2">
              {importMsg}
            </pre>
          ) : null}
        </div>
      </div>

      {/* 连接状态 */}
      <div className="rounded-card border border-line bg-surface p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">当前连接</p>
          <span
            className="rounded-full px-2 py-0.5 text-[11px]"
            style={{
              background: info?.connected ? 'var(--accent-soft)' : 'var(--danger-soft)',
              color: info?.connected ? 'var(--accent)' : 'var(--danger)',
            }}
          >
            {info?.connected ? '已连接' : '未连接'}
          </span>
        </div>
        {info?.connected ? (
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-ink-2 sm:grid-cols-3">
            <p>主机：<span className="text-ink">{info.host}</span></p>
            <p>数据库：<span className="text-ink">{info.database}</span></p>
            <p>用户：<span className="text-ink">{info.user}</span></p>
            <p>延迟：<span className="text-ink">{info.latencyMs} ms</span></p>
            <p>数据行：<span className="text-ink">{info.rowCount}</span></p>
            <p>表：<span className="text-ink">{info.tables?.length ?? 0} 张</span></p>
          </div>
        ) : (
          <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>{info?.error ?? '数据库不可用'}</p>
        )}
        {info?.tables?.length ? (
          <p className="mt-2 text-[11px] leading-5 text-ink-3">{info.tables.join(' · ')}</p>
        ) : null}
      </div>

      {/* 手动改连 */}
      <div className="rounded-card border border-line bg-surface p-4">
        <p className="text-sm font-medium">手动连接数据库</p>
        <p className="mt-0.5 text-[11px] text-ink-3">
          切换到其他 MySQL 实例（如迁移服务器）。密码留空表示保持现有密码；保存前会先测试连接，失败不落盘。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitConf(e.currentTarget, false);
          }}
          className="mt-3 grid gap-2 sm:grid-cols-2"
        >
          <input name="host" defaultValue={conf?.host ?? ''} placeholder="主机（如 127.0.0.1）" className={inputCls} />
          <input name="port" defaultValue={conf?.port ? String(conf.port) : '3306'} placeholder="端口" inputMode="numeric" className={inputCls} />
          <input name="user" defaultValue={conf?.user ?? ''} placeholder="用户名" autoComplete="off" className={inputCls} />
          <input name="pass" type="password" placeholder={`密码（当前 ${conf?.passMasked ?? '未设置'}，留空不变）`} autoComplete="new-password" className={inputCls} />
          <input name="name" defaultValue={conf?.database ?? ''} placeholder="数据库名" className={`${inputCls} sm:col-span-2`} />
          <div className="flex gap-2 sm:col-span-2">
            <button
              type="button"
              onClick={(e) => void submitConf(e.currentTarget.form as HTMLFormElement, true)}
              disabled={busy !== ''}
              className="h-10 flex-1 rounded-btn border border-accent text-sm font-medium text-accent disabled:opacity-60"
            >
              {busy === 'test' ? '测试中…' : '测试连接'}
            </button>
            <button type="submit" disabled={busy !== ''} className="h-10 flex-1 rounded-btn bg-accent text-sm font-medium text-white disabled:opacity-60">
              {busy === 'save' ? '保存中…' : '保存并切换'}
            </button>
          </div>
        </form>
        {msg ? <p className="mt-2 whitespace-pre-wrap text-xs text-ink-2">{msg}</p> : null}
      </div>
    </div>
  );
}

/* ==================== v1.0.36 · 在线更新 Tab ==================== */

const UPDATE_CHECK_KEY = 'gf.adminUpdateCheck';
const UPDATE_CHECK_TTL_MS = 24 * 3600 * 1000;

function fmtSizeMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return '—';
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}

/**
 * 服务端在线更新 + App 安装包发布（v1.0.36）。
 *
 * - 卡片 A 版本信息：本地服务端版本 / 更新源 / 已应用版本 / 磁盘 / schema / App 发布版；
 * - 卡片 B 检查更新：diff 统计（新增·更新·删除·保留）+ 删除清单预览 + 强制重装；
 * - 卡片 C 更新进度：2s 轮询（轮询本身即在服务端推进任务），完成自动刷新页面；
 * - 卡片 D App 发布：选 APK + 版本号 + 说明 → 服务端原子写 manifest（免手工维护）；
 * - 卡片 E 更新源：URL + 自动检查开关 + 测试连接；
 * - 卡片 F 历史与回滚：备份列表 + 一键回滚 + 数据库迁移。
 *
 * 进后台每 24h 静默检查一次（localStorage 节流），发现新版在 Tab 上亮红点。
 */
function ServerUpdateTab({ token, onDot }: { token: string; onDot: (dot: boolean) => void }): JSX.Element {
  const [info, setInfo] = useState<ServerUpdateInfo | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [job, setJob] = useState<UpdateJob | null>(null);
  const [force, setForce] = useState(false);
  const [lastAutoCheck, setLastAutoCheck] = useState('');
  const [srcUrl, setSrcUrl] = useState('');
  const [srcAuto, setSrcAuto] = useState(true);
  const [appFile, setAppFile] = useState<File | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [appNotes, setAppNotes] = useState('');
  const [appManifest, setAppManifest] = useState<AppReleaseManifest | null>(null);
  const [appExists, setAppExists] = useState(false);
  const [publishMsg, setPublishMsg] = useState('');
  const apkInputRef = useRef<HTMLInputElement | null>(null);

  const loadInfo = useCallback(async (): Promise<void> => {
    try {
      const [i, s, a] = await Promise.all([
        fetchServerInfo(currentServer(), token),
        fetchSource(currentServer(), token),
        fetchAppRelease(currentServer(), token),
      ]);
      setInfo(i.info);
      setSrcUrl(s.url);
      setSrcAuto(s.autoCheck);
      setAppManifest(a.manifest);
      setAppExists(a.fileExists);
    } catch (e) {
      toastError(e instanceof Error ? e.message : '加载失败');
    }
  }, [token]);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  /* ---- 自动检查：每 24h 一次，静默，只亮红点 ---- */
  useEffect(() => {
    if (!token) return;
    let last = '0';
    try {
      last = localStorage.getItem(UPDATE_CHECK_KEY) ?? '0';
    } catch {
      /* 隐私模式等场景读不到就算了 */
    }
    if (Date.now() - Number(last) < UPDATE_CHECK_TTL_MS) return;
    try {
      localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    void (async () => {
      try {
        const r = await checkServerUpdate(currentServer(), token);
        setLastAutoCheck(new Date().toLocaleString('zh-CN', { hour12: false }));
        setCheck(r);
        if (r.comparison === 'newer' && r.canUpdate) onDot(true);
      } catch {
        /* 静默失败不打扰用户 */
      }
    })();
  }, [token, onDot]);

  /* ---- 任务轮询：轮询即推进（服务端每次响应前先干 ≤18s 的活） ---- */
  useEffect(() => {
    const id = job?.id;
    const st = job?.status;
    if (!id || (st !== 'running' && st !== 'stalled')) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const r = await fetchJob(currentServer(), token, id);
          setJob(r.job);
          const j = r.job;
          if (j && j.status !== 'running' && j.status !== 'stalled') {
            window.clearInterval(timer);
            if (j.status === 'done') {
              toastSuccess('更新完成，页面即将刷新');
              window.setTimeout(() => window.location.reload(), 1500);
            } else if (j.status === 'rolled_back') {
              toastError('更新失败，已自动回滚：' + (j.error ?? ''));
            } else {
              toastError('更新失败：' + (j.error ?? ''));
            }
            void loadInfo();
          }
        } catch {
          /* 轮询失败不打断，下一轮再试 */
        }
      })();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status, token, loadInfo]);

  const doCheck = async (forceMode = false): Promise<void> => {
    setBusy('check');
    setMsg('');
    try {
      const r = await checkServerUpdate(currentServer(), token, forceMode);
      setCheck(r);
      setForce(forceMode);
      onDot(r.comparison === 'newer' && r.canUpdate);
      if (!r.canUpdate && r.reason) setMsg(r.reason);
      else if (r.comparison === 'newer') toastSuccess(`发现新版本 v${r.remote.version}`);
    } catch (e) {
      toastError(e instanceof Error ? e.message : '检查更新失败');
    } finally {
      setBusy('');
    }
  };

  const doUpdate = async (): Promise<void> => {
    const s = currentServer();
    if (!s) {
      toastError('请先配置服务器');
      return;
    }
    if (!check || !check.canUpdate) {
      toastError('请先检查更新');
      return;
    }
    const d = check.diff;
    const delPreview = d.deletedList.slice(0, 50).join('；');
    const ok = await useUiStore.getState().confirm({
      title: `更新到 v${check.remote.version}？`,
      message:
        `新增 ${d.added} 个文件 · 更新 ${d.updated} 个 · 删除 ${d.deleted} 个 · 保留 ${d.kept} 个` +
        (d.deleted > 0
          ? `。将删除：${delPreview}${d.deleted > 50 ? ' …等共 ' + d.deleted + ' 个' : ''}`
          : '。') +
        '。更新前自动备份，失败可一键回滚；更新期间请勿关闭页面。',
      confirmText: '开始更新',
      danger: d.deleted > 0,
    });
    if (!ok) return;
    setBusy('update');
    setMsg('');
    try {
      const r = await startServerUpdate(s, token, force, s.url);
      const jr = await fetchJob(s, token, r.jobId);
      setJob(jr.job);
      setMsg(r.resumed ? '已接管此前的更新任务，继续执行。' : '更新任务已启动。');
    } catch (e) {
      toastError(e instanceof Error ? e.message : '启动更新失败');
    } finally {
      setBusy('');
    }
  };

  const doCancel = async (): Promise<void> => {
    if (!job) return;
    setBusy('cancel');
    try {
      await cancelJob(currentServer(), token, job.id);
      setJob(null);
      toastSuccess('已取消');
      void loadInfo();
    } catch (e) {
      toastError(e instanceof Error ? e.message : '取消失败');
    } finally {
      setBusy('');
    }
  };

  const doRollback = async (backupId: string): Promise<void> => {
    const ok = await useUiStore.getState().confirm({
      title: '回滚到该备份？',
      message: '将用备份覆盖当前站点文件（更新新增的文件会被删除）。回滚后页面自动刷新。',
      confirmText: '确认回滚',
      danger: true,
    });
    if (!ok) return;
    setBusy('rollback');
    try {
      const r = await rollbackServer(currentServer(), token, backupId);
      toastSuccess(`已回滚（恢复 ${r.restored} 个文件）`);
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      toastError(e instanceof Error ? e.message : '回滚失败');
    } finally {
      setBusy('');
    }
  };

  const doSaveSource = async (): Promise<void> => {
    setBusy('source');
    try {
      await saveSource(currentServer(), token, srcUrl.trim(), srcAuto);
      toastSuccess('更新源已保存');
      void loadInfo();
    } catch (e) {
      toastError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy('');
    }
  };

  const doTestSource = async (): Promise<void> => {
    setBusy('test');
    try {
      const r = await testSource(currentServer(), token, srcUrl.trim());
      toastSuccess(`连接成功：远端版本 v${r.remoteVersion}`);
    } catch (e) {
      toastError(e instanceof Error ? e.message : '连接失败');
    } finally {
      setBusy('');
    }
  };

  const doPublish = async (): Promise<void> => {
    if (!appFile) {
      toastError('请先选择 APK 文件');
      return;
    }
    const v = appVersion.trim();
    if (!/^[0-9A-Za-z._-]{1,32}$/.test(v)) {
      toastError('版本号不合法（字母/数字/点/中划线/下划线，≤32 位）');
      return;
    }
    if (appFile.size > 300 * 1024 * 1024) {
      toastError('APK 超过 300MB 上限');
      return;
    }
    const ok = await useUiStore.getState().confirm({
      title: `发布 App v${v}？`,
      message: '将替换当前安装包，用户端下次检查更新即可收到；旧安装包会被清理。',
      confirmText: '发布',
      danger: true,
    });
    if (!ok) return;
    setBusy('publish');
    setPublishMsg('');
    try {
      const r = await publishAppRelease(currentServer(), token, appFile, v, appNotes.trim());
      setPublishMsg(`已发布 v${r.manifest.version}（${(r.manifest.fileSize / 1048576).toFixed(1)} MB，${r.manifest.publishedAt}）`);
      setAppFile(null);
      setAppNotes('');
      if (apkInputRef.current) apkInputRef.current.value = '';
      toastSuccess('App 安装包已发布');
      void loadInfo();
    } catch (e) {
      setPublishMsg(e instanceof Error ? e.message : '发布失败');
      toastError('发布失败');
    } finally {
      setBusy('');
    }
  };

  const doMigrate = async (): Promise<void> => {
    setBusy('migrate');
    try {
      const r = await runMigration(currentServer(), token);
      toastSuccess(r.log.length > 0 ? `迁移完成：v${r.from} → v${r.to}` : '没有待执行的迁移');
      void loadInfo();
    } catch (e) {
      toastError(e instanceof Error ? e.message : '迁移失败');
    } finally {
      setBusy('');
    }
  };

  const inputCls = 'h-10 w-full nw-input';
  const btnPrimary = 'h-10 rounded-btn bg-accent text-sm font-medium text-white disabled:opacity-60';
  const btnGhost = 'h-10 rounded-btn border border-accent text-sm font-medium text-accent disabled:opacity-60';
  const btnDanger = 'h-10 rounded-btn border border-danger text-sm font-medium text-danger disabled:opacity-60';

  const jobActive = job !== null && (job.status === 'running' || job.status === 'stalled');

  return (
    <div>
      {/* 卡片 A · 版本信息 */}
      <div className="rounded-card border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">版本信息</h2>
        <div className="mt-3 grid grid-cols-2 gap-y-2 text-xs sm:grid-cols-3">
          <div>
            <p className="text-ink-3">服务端版本</p>
            <p className="mt-0.5 font-semibold">v{info?.version ?? '—'}</p>
          </div>
          <div>
            <p className="text-ink-3">已应用版本</p>
            <p className="mt-0.5 font-semibold">{info?.applied ? `v${info.applied.version}（${info.applied.appliedAt}）` : '尚未通过在线更新'}</p>
          </div>
          <div>
            <p className="text-ink-3">App 发布版本</p>
            <p className="mt-0.5 font-semibold">
              {appManifest?.version ? `v${appManifest.version}${appExists ? '' : '（安装包缺失）'}` : '未发布'}
            </p>
          </div>
          <div>
            <p className="text-ink-3">更新源</p>
            <p className="mt-0.5 break-all">{info?.source.effective ?? '—'}</p>
          </div>
          <div>
            <p className="text-ink-3">运行环境</p>
            <p className="mt-0.5">PHP {info?.php ?? '—'} · {info?.os ?? '—'}</p>
          </div>
          <div>
            <p className="text-ink-3">磁盘可用</p>
            <p className="mt-0.5">{fmtSizeMb(info?.diskFreeMb)}</p>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">
          数据库结构版本 v{info?.schema.current ?? '—'} / v{info?.schema.target ?? '—'}
          {lastAutoCheck ? ` · 上次自动检查 ${lastAutoCheck}` : ''}
        </p>
      </div>

      {/* 卡片 B · 检查更新 */}
      <div className="mt-3 rounded-card border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">检查更新</h2>
        <p className="mt-1 text-[11px] text-ink-3">
          从更新源拉取版本清单（manifest 仅几 KB），本地逐文件比对后给出变更统计；不会自动下载。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={() => void doCheck(false)} disabled={busy === 'check'} className={btnPrimary}>
            {busy === 'check' ? '检查中…' : '检查更新'}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              style={{ accentColor: 'var(--danger)' }}
            />
            强制重装（同版本修复安装 / 降级）
          </label>
        </div>
        {msg ? <p className="mt-2 whitespace-pre-wrap text-xs text-ink-2">{msg}</p> : null}
        {check ? (
          <div className="mt-3 rounded-btn border border-line bg-paper p-3 text-xs">
            <p className="font-semibold">
              远端 v{check.remote.version}
              {check.remote.publishedAt ? `（${check.remote.publishedAt}）` : ''} · 安装包 {(check.remote.packageSize / 1048576).toFixed(1)} MB
              <span className="ml-2 text-ink-3">对比本地 v{check.local.version}</span>
            </p>
            <p className="mt-1 text-ink-2">
              新增 {check.diff.added} · 更新 {check.diff.updated} · 删除 {check.diff.deleted} · 保留 {check.diff.kept} · 清单共 {check.diff.totalRemote} 个文件
            </p>
            {check.remote.notes ? (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-btn bg-surface p-2 text-[11px] leading-relaxed text-ink-2">
                {check.remote.notes}
              </pre>
            ) : null}
            {check.diff.deleted > 0 ? (
              <div className="mt-2">
                <p className="text-danger">将删除的文件（前 {Math.min(check.diff.deletedList.length, 50)} 个）：</p>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-btn bg-surface p-2 text-[11px] leading-relaxed text-ink-2">
                  {check.diff.deletedList.slice(0, 50).join('\n')}
                  {check.diff.deleted > 50 ? `\n…等共 ${check.diff.deleted} 个` : ''}
                </pre>
              </div>
            ) : null}
            <div className="mt-3">
              <button
                onClick={() => void doUpdate()}
                disabled={!check.canUpdate || busy === 'update' || jobActive}
                className={btnPrimary}
              >
                {busy === 'update' ? '启动中…' : jobActive ? '更新进行中…' : '立即更新'}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* 卡片 C · 更新进度 */}
      {job ? (
        <div className="mt-3 rounded-card border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold">
            更新进度 · {job.phaseLabel}
            {job.status === 'done' ? '（已完成）' : job.status === 'failed' || job.status === 'rolled_back' ? '（已终止）' : ''}
          </h2>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-btn bg-accent transition-all" style={{ width: `${job.percent}%` }} />
          </div>
          <p className="mt-2 text-xs text-ink-2">
            {job.message}
            {job.progress && job.phase === 'downloading'
              ? ` · ${(job.progress.bytes / 1048576).toFixed(1)} / ${(job.progress.totalBytes / 1048576).toFixed(1)} MB`
              : ''}
            {job.progress && (job.phase === 'extracting' || job.phase === 'applying')
              ? ` · ${job.progress.fileIndex} / ${job.progress.fileTotal} 个文件`
              : ''}
          </p>
          {job.error ? <p className="mt-1 text-xs text-danger">{job.error}</p> : null}
          {job.migration && job.migration.log.length > 0 ? (
            <p className="mt-1 text-xs text-ink-2">数据库迁移：{job.migration.log.join('；')}</p>
          ) : null}
          {job.log.length > 0 ? (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-btn bg-paper p-2 text-[11px] leading-relaxed text-ink-2">
              {job.log.map((l) => `${l.t} ${l.msg}`).join('\n')}
            </pre>
          ) : null}
          {jobActive ? (
            <button onClick={() => void doCancel()} disabled={busy === 'cancel'} className={`mt-3 ${btnDanger}`}>
              {busy === 'cancel' ? '取消中…' : '取消更新'}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 卡片 D · App 发布 */}
      <div className="mt-3 rounded-card border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">App 安装包发布</h2>
        <p className="mt-1 text-[11px] text-ink-3">
          上传 APK 即发布：服务端自动写入 storage/app-release/manifest.json（含历史记录），用户端下次检查更新即可收到。
          当前发布：{appManifest?.version ? `v${appManifest.version}` : '未发布'}
          {appManifest?.publishedAt ? ` · ${appManifest.publishedAt}` : ''}
          {appManifest?.version && !appExists ? ' · 安装包文件缺失' : ''}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            value={appVersion}
            onChange={(e) => setAppVersion(e.target.value)}
            placeholder="版本号（如 1.0.36）"
            className={inputCls}
          />
          <input
            value={appNotes}
            onChange={(e) => setAppNotes(e.target.value)}
            placeholder="更新说明（可选，≤4000 字）"
            className={inputCls}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button onClick={() => apkInputRef.current?.click()} className={btnGhost}>
            选择 APK 文件
          </button>
          <span className="text-xs text-ink-2">
            {appFile ? `${appFile.name}（${(appFile.size / 1048576).toFixed(1)} MB）` : '未选择文件'}
          </span>
          <button onClick={() => void doPublish()} disabled={busy === 'publish' || !appFile} className={btnPrimary}>
            {busy === 'publish' ? '发布中…' : '发布'}
          </button>
        </div>
        <input
          ref={apkInputRef}
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setAppFile(f);
            if (f && !appVersion.trim()) {
              const m = f.name.match(/nawu-v([0-9A-Za-z._-]+)\.apk$/i);
              if (m) setAppVersion(m[1]);
            }
          }}
        />
        {publishMsg ? <p className="mt-2 whitespace-pre-wrap text-xs text-ink-2">{publishMsg}</p> : null}
        {appManifest && appManifest.history.length > 0 ? (
          <p className="mt-2 text-[11px] text-ink-3">
            历史发布：{appManifest.history.map((h) => `v${h.version}`).join('、')}
          </p>
        ) : null}
      </div>

      {/* 卡片 E · 更新源设置 */}
      <div className="mt-3 rounded-card border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">更新源</h2>
        <p className="mt-1 text-[11px] text-ink-3">
          服务端在线更新与 App 更新默认都走官方频道；此处可改为你自己的频道地址（留空恢复官方默认）。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={srcUrl}
            onChange={(e) => setSrcUrl(e.target.value)}
            placeholder={info?.source.effective ?? 'http://127.0.0.1:2233/nawu-update/'}
            className={`${inputCls} flex-1`}
          />
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={srcAuto}
              onChange={(e) => setSrcAuto(e.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            进后台自动检查
          </label>
        </div>
        <div className="mt-2 flex gap-2">
          <button onClick={() => void doTestSource()} disabled={busy === 'test'} className={btnGhost}>
            {busy === 'test' ? '测试中…' : '测试连接'}
          </button>
          <button onClick={() => void doSaveSource()} disabled={busy === 'source'} className={btnPrimary}>
            {busy === 'source' ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {/* 卡片 F · 历史与回滚 */}
      <div className="mt-3 rounded-card border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">历史与回滚</h2>
        <p className="mt-1 text-[11px] text-ink-3">
          每次更新前自动备份待改文件（最多保留 3 份）。更新出问题时可回滚到任一备份。
        </p>
        {info && info.backups.length > 0 ? (
          <div className="mt-3 space-y-2">
            {info.backups.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-2 rounded-btn border border-line bg-paper p-2 text-xs">
                <span className="min-w-0">
                  <span className="font-semibold">v{b.version || '—'}</span>
                  <span className="ml-2 text-ink-3">
                    {b.createdAt} · {b.fileCount} 个文件 · {fmtSizeMb(b.sizeMb)}
                  </span>
                </span>
                <button
                  onClick={() => void doRollback(b.id)}
                  disabled={busy === 'rollback' || jobActive}
                  className="h-8 shrink-0 rounded-btn border border-danger px-3 text-xs font-medium text-danger disabled:opacity-60"
                >
                  回滚
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-ink-3">暂无备份（完成一次更新后会出现）。</p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => void doMigrate()} disabled={busy === 'migrate'} className={btnGhost}>
            {busy === 'migrate' ? '执行中…' : '执行数据库迁移'}
          </button>
          <span className="text-[11px] text-ink-3">
            当前 v{info?.schema.current ?? '—'} / 目标 v{info?.schema.target ?? '—'}
          </span>
        </div>
      </div>
    </div>
  );
}
