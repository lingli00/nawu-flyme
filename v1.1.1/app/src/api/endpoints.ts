/**
 * 后端接口路径常量（唯一真实来源：服务端 app/Api.php）。
 *
 * ⚠️ 本文件只导出常量，**不依赖任何运行时模块**，
 * 因此 `net/httpClient.ts` 可以安全引用它而不会形成循环依赖。
 */

export const EP = {
  // 探活 / 设置
  health: '/api/health',
  settings: '/api/settings',

  // 认证
  login: '/api/auth/login',
  register: '/api/auth/register',
  sendCode: '/api/auth/send-code',
  reset: '/api/auth/reset',
  logout: '/api/auth/logout',
  me: '/api/auth/me',
  changePassword: '/api/auth/changepassword',

  // 用户资料与规则
  rules: '/api/user/rules',
  profile: '/api/user/profile',

  // 备份
  backups: '/api/user/backups',
  /** 单份备份（详情 / 删除） */
  backup: (id: number | string): string => `/api/user/backups/${id}`,

  // 同步（P1 备用）
  syncList: '/api/sync/list',
  syncPush: '/api/sync/push',
  syncPull: '/api/sync/pull',
  syncDelete: '/api/sync/delete',
} as const;

/**
 * 免鉴权路径白名单。
 *
 * ★F2：`/api/settings` **需要登录**，故意不在白名单里。
 * 其余所有路径默认带 `Authorization: Bearer <token>`。
 */
export const NO_AUTH_PATHS: readonly string[] = [
  EP.health,
  EP.login,
  EP.register,
  EP.sendCode,
  EP.reset,
];

/** 判断某路径是否在免鉴权白名单内。 */
export function isNoAuthPath(path: string): boolean {
  return NO_AUTH_PATHS.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`));
}
