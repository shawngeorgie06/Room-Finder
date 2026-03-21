const clockEl = document.getElementById('clock');
const filterEl = document.getElementById('building-filter');
const containerEl = document.getElementById('rooms-container');
const statusEl = document.getElementById('status');

let currentBuilding = '';
let knownBuildings = new Set();

// ── Clock ──────────────────────────────────────────────────────────────────

function updateClock() {
  clockEl.textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}
updateClock();
setInterval(updateClock, 1000);

// ── DOM helpers ────────────────────────────────────────────────────────────

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function text(tag, className, content) {
  const node = el(tag, className);
  node.textContent = content;
  return node;
}

// ── Render ─────────────────────────────────────────────────────────────────

function formatTimeUntil(minutes) {
  if (minutes === null || minutes === undefined) return 'Free for rest of day';
  if (minutes < 60) return `Next class in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `Next class in ${h}h${m > 0 ? ' ' + m + 'm' : ''}`;
}

function makeCard(room) {
  const card = el('div', 'card');

  card.appendChild(text('div', 'card-building', room.building));
  card.appendChild(text('div', 'card-room', `${room.building} ${room.room}`));

  const badge = text('span', 'card-badge', 'Empty now');
  card.appendChild(badge);

  const isSoon = room.minutes_until_next !== null && room.minutes_until_next <= 30;
  const timeEl = text('div', isSoon ? 'card-time soon' : 'card-time', formatTimeUntil(room.minutes_until_next));
  card.appendChild(timeEl);

  return card;
}

function renderRooms(rooms) {
  containerEl.textContent = '';  // clear safely

  if (!rooms || rooms.length === 0) {
    containerEl.appendChild(text('p', 'empty-state', 'No empty rooms found right now.'));
    return;
  }

  rooms.forEach(room => containerEl.appendChild(makeCard(room)));
}

function updateBuildingDropdown(rooms) {
  const incoming = rooms.map(r => r.building).filter(b => !knownBuildings.has(b));
  if (incoming.length === 0) return;
  incoming.forEach(b => knownBuildings.add(b));

  const sorted = [...knownBuildings].sort();
  filterEl.textContent = '';  // clear safely

  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All Buildings';
  filterEl.appendChild(all);

  sorted.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = b;
    if (b === currentBuilding) opt.selected = true;
    filterEl.appendChild(opt);
  });
}

function updateStatus(count) {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  statusEl.textContent = `${count} empty room${count !== 1 ? 's' : ''} \u00b7 Updated ${t}`;
}

// ── Fetch ──────────────────────────────────────────────────────────────────

async function fetchRooms() {
  const url = currentBuilding
    ? `/api/rooms?building=${encodeURIComponent(currentBuilding)}`
    : '/api/rooms';

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const rooms = await resp.json();
    renderRooms(rooms);
    updateBuildingDropdown(rooms);
    updateStatus(rooms.length);
  } catch (err) {
    containerEl.textContent = '';
    containerEl.appendChild(text('p', 'error-state', 'Could not load rooms. Is the server running?'));
    console.error('Fetch error:', err);
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

filterEl.addEventListener('change', () => {
  currentBuilding = filterEl.value;
  fetchRooms();
});

fetchRooms();
setInterval(fetchRooms, 60_000);
