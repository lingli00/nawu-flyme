import { useEffect, useState } from 'react';
import { CloudSun, Snowflake, Sun, Umbrella, Wind } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * 首页天气行（v1.1.4）。
 *
 * 定位：**一行 11px 的次级信息**，压在「纳物」标题下面，不新增卡片、不用彩色块，
 * 与整体「低饱和 + 细线 + 留白」的调性一致；取不到数据时整行不渲染（不占位、不报错）。
 *
 * 数据链路（都无需 API Key、都支持 CORS）：
 *   1) 定位：ipwho.is → 失败回退 ipapi.co（IPv4 城市级即可，够判断下不下雨）
 *   2) 天气：open-meteo.com 当前温度 + 当日最高/最低 + 降水概率 + 紫外线
 *   3) 缓存：localStorage 30 分钟，避免每次进首页都请求第三方
 *
 * 隐私：只发出「IP → 城市」与「经纬度 → 天气」两类查询，不上传任何本地数据；
 * 全部失败就什么都不显示。
 */

const CACHE_KEY = 'gf.weather.v1';
const TTL_MS = 30 * 60 * 1000;

type WeatherInfo = {
  city: string;
  temp: number;
  code: number;
  tMax: number;
  tMin: number;
  pop: number;
  uv: number;
};

type Cached = { ts: number; data: WeatherInfo };

const WEATHER_LABEL: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '小毛雨',
  53: '毛毛雨',
  55: '密毛雨',
  56: '冻毛雨',
  57: '冻毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '强阵雨',
  82: '暴雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷雨伴冰雹',
  99: '强雷雨伴冰雹',
};

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

function adviceOf(w: WeatherInfo): { text: string; Icon: LucideIcon } {
  if (RAIN_CODES.has(w.code) || w.pop >= 45) return { text: '出门带把伞', Icon: Umbrella };
  if (SNOW_CODES.has(w.code)) return { text: '路滑慢些走', Icon: Snowflake };
  if (w.code === 45 || w.code === 48) return { text: '能见度偏低', Icon: Wind };
  if (w.uv >= 6) return { text: '注意防晒', Icon: Sun };
  if (w.tMax >= 33) return { text: '高温少晒', Icon: Sun };
  if (w.tMin <= 0) return { text: '注意保暖', Icon: Snowflake };
  if (w.code <= 1) return { text: '适合出门', Icon: Sun };
  return { text: '天气还行', Icon: CloudSun };
}

const readCache = (): WeatherInfo | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (!c?.ts || Date.now() - c.ts > TTL_MS) return null;
    return c.data;
  } catch {
    return null;
  }
};

const writeCache = (data: WeatherInfo): void => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data } satisfies Cached));
  } catch {
    /* 隐私模式忽略 */
  }
};

/** IP 定位：先 ipwho.is，再 ipapi.co；只要 city + 经纬度。 */
async function locate(): Promise<{ city: string; lat: number; lon: number } | null> {
  const timeout = (ms: number): AbortSignal => AbortSignal.timeout(ms);
  try {
    const r = await fetch('https://ipwho.is/?fields=success,city,latitude,longitude', { signal: timeout(6000) });
    const j = (await r.json()) as { success?: boolean; city?: string; latitude?: number; longitude?: number };
    if (j?.success !== false && typeof j.latitude === 'number' && typeof j.longitude === 'number') {
      return { city: j.city || '本地', lat: j.latitude, lon: j.longitude };
    }
  } catch {
    /* 换下一个源 */
  }
  try {
    const r = await fetch('https://ipapi.co/json/', { signal: timeout(6000) });
    const j = (await r.json()) as { city?: string; latitude?: number; longitude?: number };
    if (typeof j.latitude === 'number' && typeof j.longitude === 'number') {
      return { city: j.city || '本地', lat: j.latitude, lon: j.longitude };
    }
  } catch {
    /* 全失败 */
  }
  return null;
}

async function fetchWeather(): Promise<WeatherInfo | null> {
  const loc = await locate();
  if (!loc) return null;
  const url =
    'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${loc.lat}&longitude=${loc.lon}`
    + '&current=temperature_2m,weather_code'
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max'
    + '&timezone=auto&forecast_days=1';
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const j = (await r.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
    daily?: {
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: number[];
      uv_index_max?: number[];
    };
  };
  const temp = j.current?.temperature_2m;
  const code = j.current?.weather_code;
  if (typeof temp !== 'number' || typeof code !== 'number') return null;
  return {
    city: loc.city,
    temp: Math.round(temp),
    code,
    tMax: Math.round(j.daily?.temperature_2m_max?.[0] ?? temp),
    tMin: Math.round(j.daily?.temperature_2m_min?.[0] ?? temp),
    pop: Math.round(j.daily?.precipitation_probability_max?.[0] ?? 0),
    uv: Math.round(j.daily?.uv_index_max?.[0] ?? 0),
  };
}

export default function WeatherLine({ className = '' }: { className?: string }): JSX.Element | null {
  const [info, setInfo] = useState<WeatherInfo | null>(() => readCache());

  useEffect(() => {
    let alive = true;
    if (readCache()) return undefined;
    // 首页首屏优先——天气是锦上添花，延后到空闲时再请求，不抢首帧
    const run = (): void => {
      void fetchWeather()
        .then((w) => {
          if (!alive || !w) return;
          writeCache(w);
          setInfo(w);
        })
        .catch(() => {
          /* 静默：拿不到就不显示 */
        });
    };
    const idle = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(run, { timeout: 2500 })
      : window.setTimeout(run, 1200);
    return () => {
      alive = false;
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle as number);
      else window.clearTimeout(idle as number);
    };
  }, []);

  if (!info) return null;
  const { text, Icon } = adviceOf(info);
  const label = WEATHER_LABEL[info.code] ?? '天气';

  return (
    <p
      className={`flex items-center gap-1.5 text-[11px] text-ink-3 ${className}`}
      title={`${info.city} 今日 ${info.tMin}~${info.tMax}° · 降水概率 ${info.pop}% · 紫外线 ${info.uv}`}
    >
      <Icon size={12} strokeWidth={1.8} className="shrink-0 text-ink-3/80" aria-hidden />
      <span className="truncate">
        {info.city} {info.temp}° {label}
        <span className="mx-1 text-ink-3/50">·</span>
        {text}
      </span>
    </p>
  );
}
