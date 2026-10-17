import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudSun, LocateFixed, MapPin, RefreshCw, Snowflake, Sun, Umbrella, Wind } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Sheet } from './ui/Sheet';

/**
 * 首页天气行（v1.1.5）。
 *
 * 定位策略（**精度优先**）：手机定位 → 反向地理编码到区县；拿不到再退回 IP 推测。
 * 旧版只用 IP（ipwho.is），国内运营商出口 IP 常被归到省会甚至北京（实测：手机在
 * 河南南阳桐柏，IP 库给北京；挂香港代理反而准），所以必须给「用手机定位」这条硬路径，
 * 并把当前来源明确告诉用户。
 *
 * 数据链路（全部免密钥、均实测 CORS 可用）：
 *   1) 手机定位：navigator.geolocation（需用户授权）
 *   2) 反向编码：api.bigdatacloud.net/data/reverse-geocode-client → 省/市/区县
 *   3) IP 兜底：ipwho.is → get.geojs.io（均到市级）
 *   4) 天气：open-meteo.com（当前温度/天气码 + 当日最高最低/降水概率/紫外线）
 *   5) 缓存：位置选择持久化；天气按位置键缓存 30 分钟
 *
 * 隐私：只在需要时请求「坐标→地名」「经纬度→天气」；全部失败就整行不渲染。
 */

const LOC_KEY = 'gf.weather.loc.v1';
const WX_KEY = 'gf.weather.wx.v1';
const TTL_MS = 30 * 60 * 1000;

type LocSrc = 'geo' | 'ip';
type Loc = {
  /** 展示用短名（区县优先，其次市） */
  short: string;
  /** 完整地名（tooltip 用） */
  full: string;
  lat: number;
  lon: number;
  src: LocSrc;
};

type WeatherInfo = {
  temp: number;
  code: number;
  tMax: number;
  tMin: number;
  pop: number;
  uv: number;
};

type LocCache = { ts: number; loc: Loc };
type WxCache = { ts: number; key: string; data: WeatherInfo };

const WEATHER_LABEL: Record<number, string> = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '小毛雨', 53: '毛毛雨', 55: '密毛雨', 56: '冻毛雨', 57: '冻毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷雨伴冰雹', 99: '强雷雨伴冰雹',
};

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

/** 去掉行政区划后缀，让一行更紧凑（桐柏县 → 桐柏，南阳市 → 南阳）。 */
function shortName(s: string): string {
  return s.replace(/(特别行政区|自治区|自治州|地区|盟|市|县|区|旗)$/u, '') || s;
}

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

const locKey = (l: Loc): string => `${l.lat.toFixed(2)},${l.lon.toFixed(2)}`;

function readLoc(): Loc | null {
  try {
    const raw = localStorage.getItem(LOC_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as LocCache;
    if (!c?.loc || typeof c.loc.lat !== 'number') return null;
    // 位置选择长期有效（不按 30 分钟过期）；只在用户主动「恢复自动」时清掉
    return c.loc;
  } catch {
    return null;
  }
}

function writeLoc(loc: Loc | null): void {
  try {
    if (loc) localStorage.setItem(LOC_KEY, JSON.stringify({ ts: Date.now(), loc } satisfies LocCache));
    else localStorage.removeItem(LOC_KEY);
  } catch {
    /* 隐私模式忽略 */
  }
}

function readWx(loc: Loc): WeatherInfo | null {
  try {
    const raw = localStorage.getItem(WX_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as WxCache;
    if (!c?.data || c.key !== locKey(loc) || Date.now() - c.ts > TTL_MS) return null;
    return c.data;
  } catch {
    return null;
  }
}

function writeWx(loc: Loc, data: WeatherInfo): void {
  try {
    localStorage.setItem(WX_KEY, JSON.stringify({ ts: Date.now(), key: locKey(loc), data } satisfies WxCache));
  } catch {
    /* ignore */
  }
}

/** 反向地理编码：坐标 → 省/市/区县（BigDataCloud，免密钥、CORS 开放）。 */
async function reverseName(lat: number, lon: number): Promise<{ short: string; full: string }> {
  try {
    const r = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (r.ok) {
      const j = (await r.json()) as {
        principalSubdivision?: string;
        city?: string;
        locality?: string;
        localityInfo?: { administrative?: Array<{ name?: string; adminLevel?: number }> };
      };
      // 区县优先：locality 常是「桐柏县」；有些地区 locality 为空则退到 city
      const district = j.locality || '';
      const city = j.city || '';
      const province = j.principalSubdivision || '';
      const parts = [province, city, district].filter(Boolean);
      const short = shortName(district || city || province || '当前位置');
      const full = parts.join('') || '当前位置';
      if (short) return { short, full };
    }
  } catch {
    /* 回落 */
  }
  return { short: '当前位置', full: '当前位置' };
}

/** IP 推测：ipwho.is → get.geojs.io（均为市级）。 */
async function ipLocate(): Promise<Loc | null> {
  try {
    const r = await fetch('https://ipwho.is/?fields=success,city,region,latitude,longitude', { signal: AbortSignal.timeout(6000) });
    const j = (await r.json()) as { success?: boolean; city?: string; region?: string; latitude?: number; longitude?: number };
    if (j?.success !== false && typeof j.latitude === 'number' && typeof j.longitude === 'number') {
      const city = j.city || '本地';
      return { short: shortName(city), full: [j.region, city].filter(Boolean).join(' '), lat: j.latitude, lon: j.longitude, src: 'ip' };
    }
  } catch {
    /* 换源 */
  }
  try {
    const r = await fetch('https://get.geojs.io/v1/ip/geo.json', { signal: AbortSignal.timeout(6000) });
    const j = (await r.json()) as { city?: string; region?: string; latitude?: string; longitude?: string };
    const lat = parseFloat(String(j.latitude ?? ''));
    const lon = parseFloat(String(j.longitude ?? ''));
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const city = j.city || '本地';
      return { short: shortName(city), full: [j.region, city].filter(Boolean).join(' '), lat, lon, src: 'ip' };
    }
  } catch {
    /* 全失败 */
  }
  return null;
}

async function fetchWeather(loc: Loc): Promise<WeatherInfo | null> {
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
    temp: Math.round(temp),
    code,
    tMax: Math.round(j.daily?.temperature_2m_max?.[0] ?? temp),
    tMin: Math.round(j.daily?.temperature_2m_min?.[0] ?? temp),
    pop: Math.round(j.daily?.precipitation_probability_max?.[0] ?? 0),
    uv: Math.round(j.daily?.uv_index_max?.[0] ?? 0),
  };
}

export default function WeatherLine({ className = '' }: { className?: string }): JSX.Element | null {
  const [loc, setLoc] = useState<Loc | null>(() => readLoc());
  const [wx, setWx] = useState<WeatherInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');

  const load = useCallback(async (target: Loc) => {
    const cached = readWx(target);
    if (cached) {
      setWx(cached);
      return;
    }
    const w = await fetchWeather(target);
    if (w) {
      writeWx(target, w);
      setWx(w);
    }
  }, []);

  // 首次：已存位置优先，其次 IP 推测（放到空闲时段，不抢首屏）
  useEffect(() => {
    let alive = true;
    const run = (): void => {
      void (async () => {
        const saved = readLoc();
        const target = saved ?? (await ipLocate());
        if (!alive || !target) return;
        if (!saved) writeLoc(target);
        setLoc(target);
        await load(target);
      })().catch(() => {
        /* 静默 */
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
  }, [load]);

  /** 用手机定位（可到区县）——需要浏览器/App 授权。 */
  const useGeo = (): void => {
    if (busy) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setHint('这台设备不支持定位，先按 IP 显示了');
      return;
    }
    setBusy(true);
    setHint('正在定位…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void (async () => {
          const { latitude, longitude } = pos.coords;
          const { short, full } = await reverseName(latitude, longitude);
          const next: Loc = { short, full, lat: latitude, lon: longitude, src: 'geo' };
          writeLoc(next);
          setLoc(next);
          await load(next);
          setBusy(false);
          setHint('');
          setOpen(false);
        })();
      },
      (err) => {
        setBusy(false);
        setHint(
          err.code === err.PERMISSION_DENIED
            ? '定位权限被拒绝，可以在浏览器设置里允许后重试'
            : '定位超时了，还是先用 IP 推测',
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5 * 60 * 1000 },
    );
  };

  /** 恢复 IP 自动（清掉已保存的位置）。 */
  const useIp = (): void => {
    if (busy) return;
    setBusy(true);
    setHint('正在按 IP 推测…');
    void (async () => {
      const target = await ipLocate();
      if (target) {
        writeLoc(target);
        setLoc(target);
        await load(target);
        setHint('');
        setOpen(false);
      } else {
        setHint('IP 推测失败，稍后再试');
      }
      setBusy(false);
    })();
  };

  const advice = useMemo(() => (wx ? adviceOf(wx) : null), [wx]);
  if (!loc) return null;

  const srcLabel = loc.src === 'geo' ? '手机定位' : 'IP 推测';
  const label = wx ? WEATHER_LABEL[wx.code] ?? '天气' : '';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${loc.full} · ${srcLabel}${wx ? ` · 今日 ${wx.tMin}~${wx.tMax}° · 降水概率 ${wx.pop}% · 紫外线 ${wx.uv}` : ''}（点击可切换定位方式）`}
        className={`flex w-full items-center gap-1.5 text-left text-[11px] text-ink-3 active:opacity-70 ${className}`}
      >
        {advice ? (
          <advice.Icon size={12} strokeWidth={1.8} className="shrink-0 text-ink-3/80" aria-hidden />
        ) : (
          <MapPin size={12} strokeWidth={1.8} className="shrink-0 text-ink-3/80" aria-hidden />
        )}
        <span className="min-w-0 truncate">
          {loc.short}
          {wx ? ` ${wx.temp}° ${label}` : ' …'}
          {advice ? (
            <>
              <span className="mx-1 text-ink-3/50">·</span>
              {advice.text}
            </>
          ) : null}
        </span>
      </button>

      {open ? (
        <Sheet side="center" title="天气位置" onClose={() => setOpen(false)}>
          <p className="text-xs leading-5 text-ink-2">
            当前：<b className="font-semibold text-ink">{loc.full}</b>
            <span className="ml-1 text-ink-3">（{srcLabel}）</span>
          </p>
          <p className="mt-1 text-[11px] leading-5 text-ink-3">
            运营商 IP 常被归到省会或北京，想准到区县请用手机定位。
          </p>
          {hint ? <p className="mt-2 text-[11px] text-accent">{hint}</p> : null}
          <div className="mt-3 space-y-2">
            <button
              onClick={useGeo}
              disabled={busy}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-btn bg-accent text-sm font-semibold text-white disabled:opacity-50"
            >
              <LocateFixed size={16} strokeWidth={2} aria-hidden />
              {busy ? '定位中…' : '用手机定位（准到区县）'}
            </button>
            <button
              onClick={useIp}
              disabled={busy}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-btn border border-line text-sm text-ink-2 disabled:opacity-50"
            >
              <RefreshCw size={15} strokeWidth={2} aria-hidden />
              恢复 IP 自动推测
            </button>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
