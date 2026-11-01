import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Home } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { haptic } from '../lib/haptics';

/**
 * 404 · 页面走丢了（v1.1.7）。
 *
 * 之前 router 没有兜底路由，`/#/乱写` 会渲染成空白页；而服务端更把「/乱写」
 * 一律回落到 SPA → 首页，用户根本看不出地址是错的。现在两端都给了明确交代：
 * - 服务端 unrecognized path → HTTP 404 + 品牌 404 页（见 server/404.html）
 * - 前端 hash 路由 unrecognized → 本页
 *
 * 调性沿用「01 净白印」：白磁贴字标 + 大量留白 + 一句人话，不做花哨插画。
 */
export default function NotFoundPage() {
  const nav = useNavigate();

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6 py-10">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-5 w-fit">
          <BrandMark size={64} />
        </div>

        <p className="font-serif text-[56px] font-bold leading-none tracking-tight text-ink-3/60">404</p>

        <h1 className="mt-3 text-lg font-semibold text-ink">这条路走到头了</h1>
        <p className="mx-auto mt-2 max-w-[19rem] text-sm leading-6 text-ink-2">
          你要找的页面不在这里 —— 也许是链接记错了，也许它已经搬走了。
        </p>

        <button
          onClick={() => {
            void haptic('select');
            nav('/home', { replace: true });
          }}
          className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-btn bg-accent text-sm font-semibold text-white active:opacity-90"
        >
          <Home size={16} strokeWidth={2} aria-hidden />
          回到首页
        </button>

        <button
          onClick={() => {
            void haptic('select');
            nav(-1);
          }}
          className="mt-2 flex h-10 w-full items-center justify-center gap-1.5 rounded-btn text-xs text-ink-3 active:bg-surface-2"
        >
          <ArrowLeft size={14} strokeWidth={1.8} aria-hidden />
          返回上一页
        </button>
      </div>
    </div>
  );
}
