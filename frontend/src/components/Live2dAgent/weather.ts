/** Browser-only IP city estimates. Raw IP and coordinates never enter chat payloads or storage. */
export interface CurrentWeather {
    city: string;
    country_code: string;
    temperature_c: number;
    weather_code: number;
    humidity_percent: number;
    wind_speed_kmh: number;
    valid_at: number;
    source: 'Open-Meteo';
    location_source: 'GeoJS IP';
}

declare global {
    interface Window { __agentCurrentWeather?: () => CurrentWeather | null }
}

const KEY = 'saudade-current-weather-v1';
const TTL = 10 * 60 * 1000;
const CODES = new Set([0,1,2,3,45,48,51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99]);
let cached: {savedAt: number; value: CurrentWeather} | null = null;
let pending: Promise<void> | null = null;
let retryAt = 0;
let consumers = 0;
const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const label = (value: unknown): value is string => typeof value === 'string'
    && !!value.trim() && value.length <= 80 && ![...value].some(ch => ch.codePointAt(0)! < 32 || ch.codePointAt(0) === 127);

function project(value: unknown): CurrentWeather | null {
    if (!record(value) || !label(value.city) || typeof value.country_code !== 'string'
        || !/^[A-Z]{2}$/.test(value.country_code) || !number(value.temperature_c, -100, 70)
        || !number(value.humidity_percent, 0, 100) || !number(value.wind_speed_kmh, 0, 500)
        || !number(value.weather_code, 0, 99) || !Number.isInteger(value.weather_code) || !CODES.has(value.weather_code)
        || !number(value.valid_at, 1, Number.MAX_SAFE_INTEGER) || !Number.isInteger(value.valid_at)
        || !number(Date.now()/1000-value.valid_at, -300, 3600)) return null;
    return {city: value.city.trim(), country_code: value.country_code,
        temperature_c: value.temperature_c, humidity_percent: value.humidity_percent,
        wind_speed_kmh: value.wind_speed_kmh, weather_code: value.weather_code,
        valid_at: value.valid_at, source: 'Open-Meteo', location_source: 'GeoJS IP'};
}
try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (record(saved) && number(saved.savedAt, 0, Date.now())) {
        const value = project(saved.value);
        if (value) cached = {savedAt: saved.savedAt, value};
    }
} catch { /* Optional storage never prevents chat. */ }

async function json(url: string, timeout: number): Promise<unknown> {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), timeout);
    try {
        const response = await fetch(url, {credentials: 'omit', referrerPolicy: 'no-referrer',
            redirect: 'error', cache: 'no-store', signal: control.signal});
        if (!response.ok) throw new Error('Weather source unavailable');
        const body = await response.text();
        if (body.length > 32768) throw new Error('Weather response exceeds limit');
        return JSON.parse(body);
    } finally { clearTimeout(timer); }
}

export function warmWeather(): Promise<void> | null {
    if (pending || Date.now() < retryAt || cached && project(cached.value) && Date.now()-cached.savedAt < TTL)
        return pending;
    pending = (async () => {
        const geo = await json('https://get.geojs.io/v1/ip/geo.json', 3500);
        if (!record(geo) || !label(geo.city) || typeof geo.country_code !== 'string'
            || !/^[A-Z]{2}$/.test(geo.country_code) || !label(geo.latitude) || !label(geo.longitude))
            throw new Error('IP city unavailable');
        const latitude = Number(geo.latitude), longitude = Number(geo.longitude);
        if (!number(latitude, -90, 90) || !number(longitude, -180, 180))
            throw new Error('IP location unavailable');
        const url = new URL('https://api.open-meteo.com/v1/forecast');
        url.search = new URLSearchParams({latitude: latitude.toFixed(1), longitude: longitude.toFixed(1),
            current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m',
            temperature_unit: 'celsius', wind_speed_unit: 'kmh', timeformat: 'unixtime',
            forecast_days: '1'}).toString();
        const result = await json(url.href, 5000);
        if (!record(result) || !record(result.current) || !record(result.current_units))
            throw new Error('Current weather unavailable');
        const row = result.current, units = result.current_units;
        if (units.time !== 'unixtime' || units.temperature_2m !== '°C'
            || units.relative_humidity_2m !== '%' || units.wind_speed_10m !== 'km/h')
            throw new Error('Unexpected weather units');
        const value = project({city: geo.city, country_code: geo.country_code,
            temperature_c: row.temperature_2m, humidity_percent: row.relative_humidity_2m,
            wind_speed_kmh: row.wind_speed_10m, weather_code: row.weather_code, valid_at: row.time});
        if (!value) throw new Error('Invalid current weather');
        cached = {savedAt: Date.now(), value};
        try { sessionStorage.setItem(KEY, JSON.stringify(cached)); } catch { /* Memory cache remains. */ }
    })().catch(() => { retryAt = Date.now()+60000; }).finally(() => { pending = null; });
    return pending;
}

export function getCurrentWeather(): CurrentWeather | null {
    const value = cached && project(cached.value);
    void warmWeather();
    return value;
}

function onFocus(event: FocusEvent) {
    if (event.target instanceof HTMLElement && event.target.id === 'chat-input') void warmWeather();
}

export function installWeatherContext(): () => void {
    if (consumers++ === 0) {
        window.__agentCurrentWeather = getCurrentWeather;
        document.addEventListener('focusin', onFocus);
    }
    return () => {
        if (--consumers === 0) {
            document.removeEventListener('focusin', onFocus);
            if (window.__agentCurrentWeather === getCurrentWeather) delete window.__agentCurrentWeather;
        }
    };
}
