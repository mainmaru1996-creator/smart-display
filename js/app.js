const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  const title = document.getElementById('calendar-title');
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  title.textContent = `${year}年${month + 1}月`;
  grid.innerHTML = '';

  WEEKDAYS.forEach((label, index) => {
    const cell = document.createElement('div');
    cell.className = 'calendar-weekday';
    if (index === 0) cell.classList.add('sunday');
    if (index === 6) cell.classList.add('saturday');
    cell.textContent = label;
    grid.appendChild(cell);
  });

  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < firstWeekday; i++) {
    grid.appendChild(document.createElement('div'));
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const weekday = new Date(year, month, day).getDay();
    const cell = document.createElement('div');
    cell.className = 'calendar-day';
    if (weekday === 0) cell.classList.add('sunday');
    if (weekday === 6) cell.classList.add('saturday');
    if (day === today.getDate()) cell.classList.add('today');
    cell.textContent = String(day);
    grid.appendChild(cell);
  }
}

function msUntilNextMidnight() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  return nextMidnight - now;
}

export function scheduleCalendarRefresh() {
  renderCalendar();

  function scheduleNext() {
    setTimeout(() => {
      renderCalendar();
      scheduleNext();
    }, msUntilNextMidnight());
  }

  scheduleNext();
}
