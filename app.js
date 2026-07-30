const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 6;

function applyNightMode(now) {
  const hour = now.getHours();
  const isNight = hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
  document.body.classList.toggle('night', isNight);
}

export function startClock() {
  const timeEl = document.getElementById('clock-time');
  const dateEl = document.getElementById('clock-date');

  function tick() {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dateEl.textContent = now.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });
    applyNightMode(now);
  }

  tick();
  setInterval(tick, 1000);
}
