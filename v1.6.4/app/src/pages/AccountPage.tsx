import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, User } from 'lucide-react';
import PageShell from '../components/layout/PageShell';
import PageField from '../components/ui/PageField';
import { useAuthStore, currentServer, toastSuccess, toastError } from '../store';
import { getProfile, saveProfile } from '../api/user';
import { changePassword } from '../api/auth';

/**
 * P26 账号编辑：资料展示/显示名编辑 + 修改密码。
 *
 * - 资料：GET/POST `/api/user/profile`（后端字段：display_name/avatar_url/plan）；
 * - 改密码：`changePassword`（oldPassword / newPassword，见 api/auth.ts）；
 * - ★v1.1：本程序**纯免费、无任何会员/套餐体系**——账号区不再展示「套餐」，
 *   `plan` 仅为后端历史遗留字段（恒 'free'），保存资料时原样回传即可；
 * - ★所有文本输入非受控（Android WebView IME 铁律）：defaultValue + ref 读 DOM 真值。
 */

/** 页面内的资料形态（后端 profile 字段子集）。 */
interface AccountProfile {
  display_name: string;
  avatar_url: string;
  plan: string;
}

/** 未登录 / 离线占位（与 RulePage 同款）。 */
function LoginRequired() {
  const nav = useNavigate();
  return (
    <div className="rounded-card border border-dashed border-line bg-surface p-6 text-center">
      <p className="flex justify-center text-accent">
        <User size={24} strokeWidth={1.8} aria-hidden />
      </p>
      <p className="mt-2 text-sm text-ink-2">账号资料保存在服务器，需登录后使用</p>
      <button
        onClick={() => nav('/login')}
        className="mt-3 h-10 rounded-full bg-accent-soft px-4 text-xs font-medium text-accent"
      >
        去登录
      </button>
    </div>
  );
}

export default function AccountPage() {
  const nav = useNavigate();
  const sessionState = useAuthStore((s) => s.sessionState);
  const session = useAuthStore((s) => s.session);

  const loggedIn = sessionState === 'valid' && Boolean(session?.token);
  const server = currentServer();

  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [savingPwd, setSavingPwd] = useState(false);

  // 显示名编辑：非受控
  const nameRef = useRef<HTMLInputElement | null>(null);
  // 改密码：三个输入全部非受控
  const oldPwdRef = useRef<HTMLInputElement | null>(null);
  const newPwdRef = useRef<HTMLInputElement | null>(null);
  const confirmPwdRef = useRef<HTMLInputElement | null>(null);

  /** 拉取云端资料；失败回落到会话里的用户信息。 */
  const load = async () => {
    if (!loggedIn || !server) return;
    setLoading(true);
    try {
      const raw = (await getProfile(server)) as Record<string, unknown>;
      setProfile({
        display_name: typeof raw.display_name === 'string' ? raw.display_name : '',
        avatar_url: typeof raw.avatar_url === 'string' ? raw.avatar_url : '',
        plan: typeof raw.plan === 'string' ? raw.plan : 'free',
      });
    } catch {
      // 拉取失败不阻塞页面：回落展示会话信息
      setProfile({
        display_name: session?.user?.display_name ?? '',
        avatar_url: '',
        plan: 'free',
      });
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, server?.id]);

  const email = session?.user?.email ?? '';

  /** 保存显示名（POST /api/user/profile 整包：display_name/avatar_url/plan）。 */
  const persistName = async () => {
    if (savingName || !server) return;
    const dn = (nameRef.current?.value ?? '').trim();
    if (!dn) {
      toastError('昵称不能为空');
      nameRef.current?.focus();
      return;
    }
    setSavingName(true);
    try {
      await saveProfile(server, {
        display_name: dn,
        avatar_url: profile?.avatar_url ?? '',
        plan: profile?.plan ?? 'free',
      });
      toastSuccess('昵称已保存');
      setProfile((p) => (p ? { ...p, display_name: dn } : { display_name: dn, avatar_url: '', plan: 'free' }));
    } catch (e) {
      toastError((e as Error).message || '保存失败，请稍后重试');
    }
    setSavingName(false);
  };

  /** 修改密码。 */
  const submitPassword = async () => {
    if (savingPwd || !server) return;
    const oldPwd = oldPwdRef.current?.value ?? '';
    const newPwd = newPwdRef.current?.value ?? '';
    const confirmPwd = confirmPwdRef.current?.value ?? '';
    if (!oldPwd) {
      toastError('请输入当前密码');
      oldPwdRef.current?.focus();
      return;
    }
    if (newPwd.length < 6) {
      toastError('新密码至少 6 位');
      newPwdRef.current?.focus();
      return;
    }
    if (newPwd !== confirmPwd) {
      toastError('两次输入的新密码不一致');
      confirmPwdRef.current?.focus();
      return;
    }
    setSavingPwd(true);
    try {
      await changePassword(server, oldPwd, newPwd);
      toastSuccess('密码已修改，下次登录请使用新密码');
      // 清空三个输入框（直接写 DOM，非受控安全）
      if (oldPwdRef.current) oldPwdRef.current.value = '';
      if (newPwdRef.current) newPwdRef.current.value = '';
      if (confirmPwdRef.current) confirmPwdRef.current.value = '';
    } catch (e) {
      toastError((e as Error).message || '修改密码失败，请稍后重试');
    }
    setSavingPwd(false);
  };

  /** ★v1.3.2：输入框圆角补齐到 12px（与卡片 16px 的语言衔接，旧 10px 偏尖锐）。 */
  const inputCls = 'h-11 w-full nw-input rounded-xl';

  return (
    <PageShell title="账号编辑" onBack={() => nav('/me')} flushOnDesktop>
      {!loggedIn ? (
        <LoginRequired />
      ) : (
        <>
          {/* 账号信息（只读展示） */}
          <section className="rounded-card border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold">账号</h2>
            <p className="mt-1 text-xs text-ink-3">{email || '未知邮箱'}</p>
          </section>

          {/* 显示名编辑 */}
          <section className="mt-3 rounded-card border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold">昵称</h2>
            <div className="mt-3 space-y-3">
              <PageField label="显示名">
                <input
                  ref={nameRef}
                  defaultValue={profile?.display_name ?? session?.user?.display_name ?? ''}
                  placeholder="怎么称呼你"
                  enterKeyHint="done"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className={inputCls}
                />
              </PageField>
              <button
                onClick={() => void persistName()}
                disabled={savingName || loading}
                className="h-11 w-full rounded-xl bg-accent text-sm font-semibold text-white disabled:opacity-40"
              >
                {savingName ? '保存中…' : '保存昵称'}
              </button>
            </div>
          </section>

          {/* 修改密码 */}
          <section className="mt-3 rounded-card border border-line bg-surface p-4">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <KeyRound size={16} strokeWidth={1.8} aria-hidden />
              修改密码
            </h2>
            <div className="mt-3 space-y-3">
              <PageField label="当前密码">
                <input ref={oldPwdRef} type="password" placeholder="当前密码" className={inputCls} />
              </PageField>
              <PageField label="新密码">
                <input ref={newPwdRef} type="password" placeholder="至少 6 位" className={inputCls} />
              </PageField>
              <PageField label="确认新密码">
                <input ref={confirmPwdRef} type="password" placeholder="再输一次" className={inputCls} />
              </PageField>
              <button
                onClick={() => void submitPassword()}
                disabled={savingPwd}
                className="h-11 w-full rounded-xl bg-accent text-sm font-semibold text-white disabled:opacity-40"
              >
                {savingPwd ? '提交中…' : '修改密码'}
              </button>
            </div>
          </section>
        </>
      )}
    </PageShell>
  );
}
