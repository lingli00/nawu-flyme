// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ★v1.3.3 多服务器独立登录态。
 *
 * 需求：同一个 APP 最多配 3 个服务端，每台的登录状态各自保存；
 * 切换服务器时直接恢复那台已登录的账号，**不丢会话、不用重新登录**。
 *
 * 实现要点（被测对象 `src/store/useAuthStore.ts`）：
 * - `flyme.sessions = { [serverId]: Session }` 是真正的多槽存储；
 * - `flyme.user` 只是「当前服务器」的镜像（旧版 / Web 版读这里）；
 * - `switchServer(nextId)` 从 map 里换出目标那份，找不到就显示未登录，
 *   **绝不去动别的服务器的槽位**。
 */

vi.mock('../src/api/auth', () => ({
  // 切服务器后 store 会后台 verify()，这里给一个稳定的「已登录用户」
  me: vi.fn(async () => ({ id: 'u_x', email: 'restored@nawu.local' })),
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(async () => undefined),
  sendCode: vi.fn(),
  resetPassword: vi.fn(),
  changePassword: vi.fn(),
}));

import { readServerSessions, useAuthStore } from '../src/store/useAuthStore';
import { useServerStore } from '../src/store/useServerStore';
import { getKV, removeKV, setKV } from '../src/storage/kv';
import { K_SESSIONS, K_USER } from '../src/storage/keys';
import type { ServerConfig, Session } from '../src/types/entities';

function server(id: string, url: string): ServerConfig {
  return { id, alias: id, url, createdAt: '2026-01-01T00:00:00.000Z' };
}

function session(token: string, email: string): Session {
  return {
    token,
    savedAt: '2026-01-01T00:00:00.000Z',
    user: { id: 'u_' + token, email },
  } as Session;
}

beforeEach(async () => {
  await setKV(K_SESSIONS, {});
  await removeKV(K_USER);
  useServerStore.setState({
    servers: [server('srv_a', 'http://a.local:3030'), server('srv_b', 'http://b.local:3030')],
    currentId: 'srv_a',
  });
  useAuthStore.setState({ session: null, sessionState: 'unknown', sessionServerId: null, error: '', busy: false });
});

describe('多服务器独立登录态', () => {
  it('两台服务器的会话各存各的，切换时不互相覆盖', async () => {
    await setKV(K_SESSIONS, {
      srv_a: session('tok-a', 'a@nawu.local'),
      srv_b: session('tok-b', 'b@nawu.local'),
    });

    await useAuthStore.getState().switchServer('srv_b');
    expect(useAuthStore.getState().session?.token).toBe('tok-b');
    expect(useAuthStore.getState().sessionServerId).toBe('srv_b');

    // 切回来必须还是 a 的那份 —— 这就是「不丢会话、不用重新登录」
    await useAuthStore.getState().switchServer('srv_a');
    expect(useAuthStore.getState().session?.token).toBe('tok-a');
    expect(useAuthStore.getState().sessionServerId).toBe('srv_a');
  });

  it('切到没登录过的服务器只显示未登录，别的服务器会话仍然在', async () => {
    await setKV(K_SESSIONS, { srv_a: session('tok-a', 'a@nawu.local') });

    await useAuthStore.getState().switchServer('srv_b');
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().sessionState).toBe('unknown');

    const map = (await getKV<Record<string, Session>>(K_SESSIONS, {})) ?? {};
    expect(Object.keys(map)).toEqual(['srv_a']);
    expect(map.srv_a.token).toBe('tok-a');
  });

  it('flyme.user 始终镜像当前服务器那一份（旧版/Web 版兼容）', async () => {
    await setKV(K_SESSIONS, {
      srv_a: session('tok-a', 'a@nawu.local'),
      srv_b: session('tok-b', 'b@nawu.local'),
    });

    await useAuthStore.getState().switchServer('srv_b');
    const mirror = await getKV<Session>(K_USER, null);
    expect(mirror?.token).toBe('tok-b');
  });

  it('readServerSessions 只回邮箱，绝不回 token', async () => {
    await setKV(K_SESSIONS, {
      srv_a: session('tok-a', 'a@nawu.local'),
      srv_b: session('tok-b', 'b@nawu.local'),
    });

    const brief = await readServerSessions();
    expect(brief).toEqual({
      srv_a: { email: 'a@nawu.local' },
      srv_b: { email: 'b@nawu.local' },
    });
    expect(JSON.stringify(brief)).not.toContain('tok-');
  });

  it('旧数据迁移：只有 flyme.user 时归到当前服务器并补写 map', async () => {
    await setKV(K_USER, session('legacy-tok', 'old@nawu.local'));

    await useAuthStore.getState().hydrateSession();
    expect(useAuthStore.getState().session?.token).toBe('legacy-tok');

    const map = (await getKV<Record<string, Session>>(K_SESSIONS, {})) ?? {};
    expect(map.srv_a?.token).toBe('legacy-tok');
  });

  it('坏数据（数组 / 无 token 的对象）当空表处理，不抛错', async () => {
    await setKV(K_SESSIONS, {
      srv_a: { token: 'ok-tok', user: { email: 'ok@nawu.local' } },
      srv_b: { user: { email: 'no-token@nawu.local' } },
      srv_c: 'garbage',
    } as unknown as Record<string, Session>);

    const brief = await readServerSessions();
    expect(Object.keys(brief)).toEqual(['srv_a']);
    expect(brief.srv_a.email).toBe('ok@nawu.local');
  });
});
