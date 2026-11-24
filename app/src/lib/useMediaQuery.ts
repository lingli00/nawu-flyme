import { useEffect, useState } from 'react';

/**
 * CSS 媒体查询订阅（SSR 安全、监听变化）。
 * 供响应式布局用：App / 手机网页 < 1024px 保持移动壳；PC 网页 ≥ 1024px 走桌面壳。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** 桌面断点（与 index.css 中 @media (min-width: 1024px) 保持一致）。 */
export const DESKTOP_QUERY = '(min-width: 1024px)';

/** 是否桌面宽屏（PC 网页端）。 */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
