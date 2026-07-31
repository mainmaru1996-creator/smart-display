const DEFAULT_LOCATION = { name: '東京', lat: 35.6762, lon: 139.6503 };
const LOCATION_STORAGE_KEY = 'weather-location';
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

const WEATHER_CODE_LABELS = {
  0: '晴れ',
  1: 'ほぼ晴れ',
  2: '一部曇り',
  3: '曇り',
  45: '霧',
  48: '霧',
  51: '弱い霧雨',
  53: '霧雨',
  55: '強い霧雨',
  61: '弱い雨',
  63: '雨',
  65: '強い雨',
  71: '弱い雪',
  73: '雪',
  75: '強い雪',
  80: 'にわか雨',
  81: 'にわか雨',
  82: '激しいにわか雨',
  95: '雷雨',
  96: '雷雨(あられ)',
  99: '雷雨(あられ)',
};

const WEATHER_CODE_ICONS = {
  0: '☀︎',
  1: '🌤',
  2: '⛅︎',
  3: '☁︎',
  45: '︙',
  48: '︙',
  51: '🌦',
  53: '🌦',
  55: '🌦',
  61: '🌧',
  63: '🌧',
  65: '🌧',
  71: '🌨',
  73: '🌨',
  75: '🌨',
  80: '🌦',
  81: '🌦',
  82: '🌧',
  95: '⛈',
  96: '⛈',
  99: '⛈',
};

function describeWeatherCode(code) {
  return WEATHER_CODE_LABELS[code] ?? '不明';
}

function iconForWeatherCode(code) {
  return WEATHER_CODE_ICONS[code] ?? '−';
}

export function getLocation() {
  try {
    const saved = localStorage.getItem(LOCATION_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    // 破損データは無視してデフォルトへフォールバック
  }
  return DEFAULT_LOCATION;
}

export function setLocation(location) {
  localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(location));
}

export async function geocodeCityName(cityName) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=ja&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('geocoding request failed');
  const data = await res.json();
  const result = data.results?.[0];
  if (!result) throw new Error('location not found');
  return { name: result.name, lat: result.latitude, lon: result.longitude };
}

function renderForecast(daily) {
  const forecastEl = document.getElementById('weather-forecast');
  forecastEl.innerHTML = '';
  const days = daily.time.slice(1, 4);
  days.forEach((isoDate, index) => {
    const dayIndex = index + 1;
    const date = new Date(isoDate);
    const label = date.toLocaleDateString('ja-JP', { weekday: 'short' });
    const max = Math.round(daily.temperature_2m_max[dayIndex]);
    const min = Math.round(daily.temperature_2m_min[dayIndex]);
    const icon = iconForWeatherCode(daily.weather_code[dayIndex]);

    const el = document.createElement('div');
    el.className = 'forecast-day';
    el.innerHTML = `<div>${label}</div><div class="forecast-icon">${icon}</div><div class="forecast-temp">${max}° / ${min}°</div>`;
    forecastEl.appendChild(el);
  });
}

export async function updateWeather() {
  const location = getLocation();
  const nameEl = document.getElementById('weather-location');
  const tempEl = document.getElementById('weather-temp');
  const descEl = document.getElementById('weather-desc');

  nameEl.textContent = location.name;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.lat}&longitude=${location.lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('forecast request failed');
    const data = await res.json();

    tempEl.textContent = `${Math.round(data.current.temperature_2m)}°C`;
    descEl.textContent = `${iconForWeatherCode(data.current.weather_code)} ${describeWeatherCode(data.current.weather_code)}`;
    renderForecast(data.daily);
  } catch {
    descEl.textContent = '天気情報を取得できませんでした';
  }
}

export function scheduleWeatherRefresh() {
  updateWeather();
  setInterval(updateWeather, REFRESH_INTERVAL_MS);
}
