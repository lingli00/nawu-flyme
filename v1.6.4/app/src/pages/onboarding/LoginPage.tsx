import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import PageShell from '../../components/layout/PageShell';
import { useAuthStore, toastError, toastSuccess } from '../../store';
import PageField from '../../components/ui/PageField';

/**
 * P02 登录 / P03 注册 / P04 忘记密码 —— 三合一分栏页。
 * ★R10：服务端 requireVerified=true（已实测），注册**默认展示验证码框**；
 * 同时保留自适应：注册成功无需验证码时后端直接返回 token（自动登录）。
 *
 * ★修复 v1（DOM 复用错位）：拆为 LoginForm / RegisterForm / ResetForm 三个独立子表单，
 * 父组件渲染时带 key 整组件替换，切 tab 时整棵子树重挂载，杜绝按位置索引复用 DOM input。
 *
 * ★修复 v2（Android WebView IME 真根源）：受控 value/onChange 在 Android WebView 的
 * IME 组合输入下与 DOM 脱节——输入框界面上显示完整文本，但值并未真正同步进 React
 * state，提交时读到的 email 为空/残缺（服务端日志证实）。
 * 本次把**所有输入框改为非受控**：DOM 自持值，提交/发送时用 ref 读真值，
 * 彻底绕开受控同步链路。normalizeCode 也移到「读取时」处理，输入框不再拦截键入。
 */
type Mode = 'login' | 'register' | 'reset';

/** 登录/注册/找回成功后的落地路由（首页路由已迁移至 /home）。 */
const HOME_ROUTE = '/home';

/** 提交前客户端邮箱格式校验（防呆兜底；真正校验仍以服务端为准）。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** 非受控输入框 ref 类型。 */
type InputRef = MutableRefObject<HTMLInputElement | null>;

/**
 * 验证码归一化：全角数字→半角、去空格/标点/汉字，截 8 位。
 * 手机中文输入法的「数字键盘」常打出全角字符，直接提交必然「验证码不正确」。
 * ★v2：只在读取（提交/发送前）时调用，输入框本身不拦截键入，避免干扰 IME。
 */
function normalizeCode(raw: string): string {
  return raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9]/g, '')
    .slice(0, 8);
}

/** 读取非受控输入框当前 DOM 真值（Android WebView 下这是唯一可靠的值来源）。 */
function readInput(ref: InputRef): string {
  return ref.current?.value ?? '';
}

/**
 * 提交前校验邮箱：不匹配时 toast 提示并 focus 邮箱框，不发请求。
 * @returns 合法（已 trim）的邮箱；不合法返回 null。
 */
function requireValidEmail(emailRef: InputRef): string | null {
  const email = readInput(emailRef).trim();
  if (!EMAIL_RE.test(email)) {
    toastError('邮箱格式不正确，请检查后重试');
    emailRef.current?.focus();
    return null;
  }
  return email;
}

/**
 * 邮箱输入框（三个子表单共用，非受控）。
 * ★type 用 "text" + inputMode="email"：规避 Android WebView 对 type=email 的怪异行为；
 * ★onInput 只回报「是否非空」布尔值（用于提交按钮 disabled 态），
 * 不把值写回任何 state——绝不碰受控同步链路。
 */
function EmailInput({
  inputRef,
  seed,
  onFilledChange,
}: {
  inputRef: InputRef;
  seed: string;
  onFilledChange?: (filled: boolean) => void;
}) {
  return (
    <input
      ref={inputRef}
      defaultValue={seed}
      onInput={(e) => onFilledChange?.(e.currentTarget.value.trim().length > 0)}
      type="text"
      inputMode="email"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="done"
      placeholder="you@example.com"
      className="h-11 w-full nw-input rounded-xl"
    />
  );
}

/** 密码输入框（非受控，onInput 只回报是否非空）。 */
function PasswordInput({
  inputRef,
  placeholder,
  onFilledChange,
}: {
  inputRef: InputRef;
  placeholder: string;
  onFilledChange?: (filled: boolean) => void;
}) {
  return (
    <input
      ref={inputRef}
      onInput={(e) => onFilledChange?.(e.currentTarget.value.length > 0)}
      type="password"
      placeholder={placeholder}
      className="h-11 w-full nw-input rounded-xl"
    />
  );
}

/**
 * 验证码字段（非受控）+ 发送按钮。
 * 归一化在提交时做；发送成功后清空 DOM input 值（直接写 DOM，非受控安全）。
 */
function CodeField({
  emailRef,
  codeRef,
  purpose,
  emailFilled,
}: {
  emailRef: InputRef;
  codeRef: InputRef;
  purpose: 'register' | 'reset';
  emailFilled: boolean;
}) {
  return (
    <PageField label="邮箱验证码" hint="每次重新发送后，旧验证码立即失效，请用最新一封邮件">
      <div className="flex gap-2">
        <input
          ref={codeRef}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          placeholder="6 位数字"
          className="h-11 flex-1 nw-input rounded-xl tracking-[0.3em]"
        />
        <SendCodeButton
          emailRef={emailRef}
          purpose={purpose}
          emailFilled={emailFilled}
          onSent={() => {
            if (codeRef.current) codeRef.current.value = '';
          }}
        />
      </div>
    </PageField>
  );
}

/**
 * 「发送验证码」按钮（含 60s 倒计时）。
 * ★倒计时 state 放在本组件内部：每秒 tick 只重渲染这个按钮，不打断其他输入。
 * ★sending state：请求进行中禁用——修复连点并发 5 个请求、toast 叠 5 条的问题。
 * ★email 值在点击时用 ref 读 DOM 真值，不再依赖受控 prop。
 */
function SendCodeButton({
  emailRef,
  purpose,
  emailFilled,
  onSent,
}: {
  emailRef: InputRef;
  purpose: 'register' | 'reset';
  emailFilled: boolean;
  onSent: () => void;
}) {
  const sendCode = useAuthStore((s) => s.sendCode);
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const send = async () => {
    if (sending || countdown > 0) return;
    const email = readInput(emailRef).trim();
    if (!email) return;
    setSending(true);
    try {
      await sendCode(email, purpose);
      toastSuccess('验证码已发送，注意查收（可能在垃圾邮件里）');
      onSent();
      setCountdown(60);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1 && timerRef.current) clearInterval(timerRef.current);
          return c <= 1 ? 0 : c - 1;
        });
      }, 1000);
    } catch (e) {
      toastError((e as Error).message);
    }
    setSending(false);
  };

  return (
    <button
      onClick={() => void send()}
      disabled={sending || countdown > 0 || !emailFilled}
      className="h-11 w-28 shrink-0 rounded-xl bg-accent-soft text-xs font-medium text-accent disabled:opacity-40"
    >
      {sending ? '发送中…' : countdown > 0 ? `${countdown}s 后重发` : '发送验证码'}
    </button>
  );
}

/** 三个子表单共享的 props：邮箱 ref 由父组件持有（跨 tab 共享同一 DOM 引用）。 */
interface SubFormProps {
  /** 邮箱输入框 ref（父组件持有，切 tab 时读取旧值、重挂载后重新绑定）。 */
  emailRef: InputRef;
  /** 邮箱初始值（切 tab 前从旧 input 读出的 DOM 真值，重挂载后经 defaultValue 回填）。 */
  emailSeed: string;
}

/** P02 登录子表单：独立持有密码 ref / busy。 */
function LoginForm({ emailRef, emailSeed }: SubFormProps) {
  const nav = useNavigate();
  const login = useAuthStore((s) => s.login);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailFilled, setEmailFilled] = useState(emailSeed.trim().length > 0);
  const [passwordFilled, setPasswordFilled] = useState(false);

  const submit = async () => {
    if (busy) return;
    const email = requireValidEmail(emailRef);
    if (email === null) return;
    const password = readInput(passwordRef);
    if (!password) return;
    setBusy(true);
    try {
      await login(email, password);
      toastSuccess('登录成功');
      nav(HOME_ROUTE, { replace: true });
    } catch (e) {
      toastError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <>
      <PageField label="邮箱">
        <EmailInput inputRef={emailRef} seed={emailSeed} onFilledChange={setEmailFilled} />
      </PageField>

      <PageField label="密码">
        <PasswordInput inputRef={passwordRef} placeholder="密码" onFilledChange={setPasswordFilled} />
      </PageField>

      <button
        onClick={() => void submit()}
        disabled={busy || !emailFilled || !passwordFilled}
        className="mt-1 h-12 w-full rounded-xl bg-accent text-base font-semibold text-white active:opacity-90 disabled:opacity-40"
      >
        {busy ? '请稍候…' : '登录'}
      </button>
    </>
  );
}

/** P03 注册子表单：独立持有密码/确认密码/验证码 ref / busy。 */
function RegisterForm({ emailRef, emailSeed }: SubFormProps) {
  const nav = useNavigate();
  const register = useAuthStore((s) => s.register);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const password2Ref = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailFilled, setEmailFilled] = useState(emailSeed.trim().length > 0);
  const [passwordFilled, setPasswordFilled] = useState(false);

  const submit = async () => {
    if (busy) return;
    const email = requireValidEmail(emailRef);
    if (email === null) return;
    const password = readInput(passwordRef);
    const password2 = readInput(password2Ref);
    if (password.length < 6) {
      toastError('密码至少 6 位');
      return;
    }
    if (password !== password2) {
      toastError('两次输入的密码不一致');
      return;
    }
    // 验证码归一化移到读取时：不拦截键入，避免干扰 IME
    const code = normalizeCode(readInput(codeRef)).trim();
    setBusy(true);
    try {
      await register(email, password, code || undefined);
      toastSuccess('注册成功，已自动登录');
      nav(HOME_ROUTE, { replace: true });
    } catch (e) {
      toastError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <>
      <PageField label="邮箱">
        <EmailInput inputRef={emailRef} seed={emailSeed} onFilledChange={setEmailFilled} />
      </PageField>

      <CodeField emailRef={emailRef} codeRef={codeRef} purpose="register" emailFilled={emailFilled} />

      <PageField label="密码">
        <PasswordInput inputRef={passwordRef} placeholder="密码" onFilledChange={setPasswordFilled} />
      </PageField>

      <PageField label="确认密码">
        <PasswordInput inputRef={password2Ref} placeholder="再输一次" />
      </PageField>

      <button
        onClick={() => void submit()}
        disabled={busy || !emailFilled || !passwordFilled}
        className="mt-1 h-12 w-full rounded-xl bg-accent text-base font-semibold text-white active:opacity-90 disabled:opacity-40"
      >
        {busy ? '请稍候…' : '注册并登录'}
      </button>
    </>
  );
}

/** P04 找回密码子表单：独立持有新密码/验证码 ref / busy；成功后切回登录 tab。 */
function ResetForm({
  emailRef,
  emailSeed,
  onSwitchToLogin,
}: SubFormProps & { onSwitchToLogin: () => void }) {
  const resetPassword = useAuthStore((s) => s.resetPassword);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailFilled, setEmailFilled] = useState(emailSeed.trim().length > 0);
  const [passwordFilled, setPasswordFilled] = useState(false);

  const submit = async () => {
    if (busy) return;
    const email = requireValidEmail(emailRef);
    if (email === null) return;
    const password = readInput(passwordRef);
    if (password.length < 6) {
      toastError('新密码至少 6 位');
      return;
    }
    const code = normalizeCode(readInput(codeRef)).trim();
    setBusy(true);
    try {
      await resetPassword(email, code, password);
      toastSuccess('密码已重置，请用新密码登录');
      onSwitchToLogin();
    } catch (e) {
      toastError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <>
      <PageField label="邮箱">
        <EmailInput inputRef={emailRef} seed={emailSeed} onFilledChange={setEmailFilled} />
      </PageField>

      <CodeField emailRef={emailRef} codeRef={codeRef} purpose="reset" emailFilled={emailFilled} />

      <PageField label="新密码">
        <PasswordInput inputRef={passwordRef} placeholder="至少 6 位" onFilledChange={setPasswordFilled} />
      </PageField>

      <button
        onClick={() => void submit()}
        disabled={busy || !emailFilled || !passwordFilled}
        className="mt-1 h-12 w-full rounded-xl bg-accent text-base font-semibold text-white active:opacity-90 disabled:opacity-40"
      >
        {busy ? '请稍候…' : '重置密码'}
      </button>
    </>
  );
}

export default function LoginPage({ initialMode = 'login' }: { initialMode?: Mode }) {
  const nav = useNavigate();
  const [mode, setMode] = useState<Mode>(initialMode);
  // ★邮箱 ref 由父组件持有：跨 tab 共享同一 ref；emailSeed 用于切 tab 重挂载时回填。
  // 非受控方案下这是唯一能跨 tab 保留输入内容的方式（DOM 值在卸载时即消失）。
  const emailRef = useRef<HTMLInputElement | null>(null);
  const [emailSeed, setEmailSeed] = useState('');

  const tabs: Array<[Mode, string]> = [
    ['login', '登录'],
    ['register', '注册'],
    ['reset', '找回密码'],
  ];

  /** 切 tab：先把当前邮箱框的 DOM 真值存进 seed，再换 mode 重挂载子表单。 */
  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setEmailSeed(readInput(emailRef));
    setMode(m);
  };

  return (
    <PageShell
      title={mode === 'login' ? '登录' : mode === 'register' ? '注册' : '找回密码'}
      onBack={() => nav(HOME_ROUTE, { replace: true })}
      flushOnDesktop
    >
      <div className="mb-4 flex gap-1 rounded-xl bg-surface-2 p-1">
        {tabs.map(([m, label]) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={`h-9 flex-1 rounded-[10px] text-sm ${
              mode === m ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-3'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="space-y-3 rounded-card border border-line bg-surface p-4">
        {/* ★带 key 的整组件替换：切 tab 时子表单整棵重挂载，杜绝 DOM input 复用错位。 */}
        {mode === 'login' ? (
          <LoginForm key="login" emailRef={emailRef} emailSeed={emailSeed} />
        ) : mode === 'register' ? (
          <RegisterForm key="register" emailRef={emailRef} emailSeed={emailSeed} />
        ) : (
          <ResetForm
            key="reset"
            emailRef={emailRef}
            emailSeed={emailSeed}
            onSwitchToLogin={() => switchMode('login')}
          />
        )}
      </div>

      <p className="mt-4 text-center text-xs leading-5 text-ink-3">
        登录后数据可云备份、跨设备恢复。
        <br />
        不登录也能正常记账，数据保存在本机。
      </p>
    </PageShell>
  );
}
