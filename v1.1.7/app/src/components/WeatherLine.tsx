import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudSun, MapPin, RefreshCw, Snowflake, Sun, Umbrella, Wind } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { get } from '../net/httpClient';
import { EP } from '../api/endpoints';
import { currentServer } from '../store';
import { Sheet } from './ui/Sheet';

/**
 * 首页天气行（v1.1.7 · 纯 IP 定位版）。
 *
 * 为什么重写：v1.1.6 走「手机定位 → BigDataCloud 反查区县」，但用户要求
 * **只按 IP 定位**（不想为了看天气授权精确定位）；而 IP 一换，原来的境外
 * 免费接口（ipwho.is / ipapi.co）常把国内手机 IP 归到省会甚至北京 ——
 * 实测手机在河南南阳桐柏，却显示郑州/北京。
 *
 * 现在：
 *   1) `/api/geo`（自家服务端）读本地纯真库 → 省 / 市 / 区县，**直接拿到区县**；
 *      服务端查本地库，不外发用户 IP，也不受第三方限流影响。
 *   2) 区县没有经纬度（公开地理编码库普遍缺区县），天气用**所属地级市**的坐标取，
 *      一行文案显示到区县 —— 同市天气差异极小，体感一致。
 *   3) 天气仍走 open-meteo（免密钥），按坐标缓存 30 分钟；地名→坐标缓存 30 天。
 *   4) 地级市查不到坐标时，退回 ipwho.is / geojs 的坐标（只借坐标，名字仍用 IP 库的）。
 *
 * 隐私：只把「本机 IP」发给**自建服务器**；第三方只收到「城市名」（地名词典查询）
 * 和「经纬度」（天气），不含 IP。
 */

const WX_KEY = 'gf.weather.wx.v2';
const GEO_KEY = 'gf.weather.geo.v2';
const TTL_MS = 30 * 60 * 1000;
const GEO_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Loc = {
  /** 展示用短名（区县优先，其次市） */
  short: string;
  /** 完整地名（弹层里显示） */
  full: string;
  province: string;
  city: string;
  district: string;
  /** 服务端判定的客户端 IP */
  ip: string;
  /** IP 对应的运营商 */
  isp: string;
  lat: number;
  lon: number;
  /** 2 = 区县级，1 = 市级，0 = 省级 */
  accuracy: number;
};

type WeatherInfo = {
  temp: number;
  code: number;
  tMax: number;
  tMin: number;
  pop: number;
  uv: number;
};

type GeoResp = {
  ok: boolean;
  ip?: string;
  province?: string;
  city?: string;
  district?: string;
  isp?: string;
  display?: string;
  /** 服务端随包带的行政区划中心点：直接给经纬度，前端不再自己地理编码 */
  lat?: number;
  lon?: number;
  /** 2 = 区县级，1 = 市级，0 = 省级兜底 */
  accuracy?: number;
  error?: string;
};

type WxCache = { ts: number; key: string; data: WeatherInfo };
type GeoCache = { ts: number; lat: number; lon: number };

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

function readGeoCache(name: string): { lat: number; lon: number } | null {
  try {
    const raw = localStorage.getItem(GEO_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, GeoCache>;
    const c = all[name];
    if (!c || Date.now() - c.ts > GEO_TTL_MS) return null;
    return { lat: c.lat, lon: c.lon };
  } catch {
    return null;
  }
}

function writeGeoCache(name: string, v: { lat: number; lon: number }): void {
  try {
    const raw = localStorage.getItem(GEO_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, GeoCache>) : {};
    all[name] = { ts: Date.now(), lat: v.lat, lon: v.lon };
    localStorage.setItem(GEO_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** 服务端 IP 归属地（自家接口，含区县）。 */
async function fetchIpGeo(): Promise<GeoResp | null> {
  try {
    const res = await get<GeoResp>(currentServer(), EP.geo, undefined, 8000);
    if (!res.data || res.data.ok !== true) return null;
    return res.data;
  } catch {
    return null;
  }
}

/** 城市名 → 经纬度（open-meteo geocoding，免密钥；按城市名缓存 30 天）。 */
async function geocode(city: string, province: string): Promise<{ lat: number; lon: number } | null> {
  const key = city || province;
  if (!key) return null;
  const cached = readGeoCache(key);
  if (cached) return cached;

  /* 「桐柏县」这类区县名在公开地名词典里通常查不到 → 依次试「去后缀的市名」「省名」 */
  const tries = [city, city.replace(/(市|地区|自治州|盟)$/u, ''), province].filter(Boolean);
  for (const name of tries) {
    try {
      const r = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=6&language=zh&format=json`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!r.ok) continue;
      const j = (await r.json()) as {
        results?: Array<{ name: string; latitude: number; longitude: number; admin1?: string; country_code?: string }>;
      };
      const list = (j.results ?? []).filter((x) => x.country_code === 'CN');
      if (list.length === 0) continue;
      const hint = province.replace(/(省|市|自治区|特别行政区)$/u, '');
      const hit = list.find((x) => hint !== '' && (x.admin1 ?? '').includes(hint)) ?? list[0];
      const out = { lat: hit.latitude, lon: hit.longitude };
      writeGeoCache(key, out);
      return out;
    } catch {
      /* 换下一个候选名 */
    }
  }
  return null;
}

/** 兜底坐标：境外接口只借经纬度，地名仍用 IP 库的（避免「桐柏被写成北京」）。 */
async function fallbackCoords(): Promise<{ lat: number; lon: number } | null> {
  try {
    const r = await fetch('https://ipwho.is/?fields=success,latitude,longitude', { signal: AbortSignal.timeout(6000) });
    const j = (await r.json()) as { success?: boolean; latitude?: number; longitude?: number };
    if (j?.success !== false && typeof j.latitude === 'number' && typeof j.longitude === 'number') {
      return { lat: j.latitude, lon: j.longitude };
    }
  } catch {
    /* 换源 */
  }
  try {
    const r = await fetch('https://get.geojs.io/v1/ip/geo.json', { signal: AbortSignal.timeout(6000) });
    const j = (await r.json()) as { latitude?: string; longitude?: string };
    const lat = parseFloat(String(j.latitude ?? ''));
    const lon = parseFloat(String(j.longitude ?? ''));
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
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

/** 组装一次完整定位：IP → 地名 → 坐标。 */
async function resolveLoc(): Promise<Loc | null> {
  const geo = await fetchIpGeo();
  if (!geo) return null;

  const province = (geo.province ?? '').trim();
  const city = (geo.city ?? '').trim();
  const district = (geo.district ?? '').trim();

  /* 坐标优先用服务端给的（随包带行政区划中心点，区县级准）；拿不到再退回在线地名词典 */
  let coords: { lat: number; lon: number } | null = null;
  if (typeof geo.lat === 'number' && typeof geo.lon === 'number'
      && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
    coords = { lat: geo.lat, lon: geo.lon };
  }
  if (!coords) coords = await geocode(city || province, province);
  if (!coords) coords = await fallbackCoords();
  if (!coords) return null;

  const parts: string[] = [];
  for (const p of [province, city, district]) {
    if (p && !parts.some((x) => x === p)) parts.push(p);
  }

  return {
    short: shortName(district || city || province || '本地'),
    full: parts.join('') || '本地',
    province,
    city,
    district,
    ip: geo.ip ?? '',
    isp: geo.isp ?? '',
    lat: coords.lat,
    lon: coords.lon,
    accuracy: typeof geo.accuracy === 'number' ? geo.accuracy : (district ? 2 : 1),
  };
}

export default function WeatherLine({ className = '' }: { className?: string }): JSX.Element | null {
  const [loc, setLoc] = useState<Loc | null>(null);
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

  /* 首次：放到空闲时段，不抢首屏 */
  useEffect(() => {
    let alive = true;
    const run = (): void => {
      void (async () => {
        const target = await resolveLoc();
        if (!alive || !target) return;
        setLoc(target);
        await load(target);
      })().catch(() => {
        /* 静默：拿不到就不显示这一行 */
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

  /** 重新按当前网络 IP 定位（换了 Wi-Fi / 流量后可手动刷新）。 */
  const refresh = (): void => {
    if (busy) return;
    setBusy(true);
    setHint('正在按当前网络 IP 重新定位…');
    void (async () => {
      const target = await resolveLoc();
      if (target) {
        setLoc(target);
        await load(target);
        setHint('');
        setOpen(false);
      } else {
        setHint('这次没取到归属地，稍后再试');
      }
      setBusy(false);
    })();
  };

  const advice = useMemo(() => (wx ? adviceOf(wx) : null), [wx]);
  if (!loc) return null;

  const label = wx ? WEATHER_LABEL[wx.code] ?? '天气' : '';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${loc.full} · 按网络 IP 定位${wx ? ` · 今日 ${wx.tMin}~${wx.tMax}° · 降水概率 ${wx.pop}% · 紫外线 ${wx.uv}` : ''}（点击查看定位详情）`}
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
          </p>
          <p className="mt-1 text-[11px] leading-5 text-ink-3">
            {loc.ip ? `按网络 IP ${loc.ip}${loc.isp ? `（${loc.isp}）` : ''} 定位` : '按当前网络 IP 定位'}
            {loc.accuracy >= 2 && loc.district
              ? `，精确到${loc.district}`
              : '，到地级市（该 IP 段运营商只登记到市）'}
            。定位只用你自己的服务器，不外发。
          </p>
          {hint ? <p className="mt-2 text-[11px] text-accent">{hint}</p> : null}
          <div className="mt-3 space-y-2">
            <button
              onClick={refresh}
              disabled={busy}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-btn bg-accent text-sm font-semibold text-white disabled:opacity-50"
            >
              <RefreshCw size={15} strokeWidth={2} aria-hidden className={busy ? 'animate-spin' : ''} />
              {busy ? '重新定位中…' : '按当前 IP 重新定位'}
            </button>
            <p className="text-center text-[11px] leading-5 text-ink-3">
              换了 Wi-Fi 或流量后点一下即可更新，位置不会上传给第三方。
            </p>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
