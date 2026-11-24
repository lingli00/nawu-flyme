/**
 * ID 生成。
 *
 * ★必须与 Web 版同算法（架构 §10.3，已反查确认）：
 * `Date.now().toString(36) + Math.random().toString(36).slice(2, 8)`
 * 否则跨端恢复会 ID 冲突。
 */
export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 服务器 ID：`srv_` 前缀，便于与业务 ID 区分。 */
export function newServerId(): string {
  return `srv_${newId()}`;
}

/** P11 草稿行 key（同一批解析结果内唯一）。 */
export function newDraftKey(): string {
  return `d_${newId()}`;
}

/** 简单哈希（用于把字符串稳定映射到配色/emoji 池）。 */
export function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
