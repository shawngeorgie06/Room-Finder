const clockEl    = document.getElementById('clock');
const filterEl   = document.getElementById('building-filter');
const containerEl = document.getElementById('rooms-container');
const statusEl   = document.getElementById('status');

let currentBuilding = '';
let knownBuildings  = new Set();

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

// ── Format time ────────────────────────────────────────────────────────────

function formatTimeUntil(minutes) {
  if (minutes === null || minutes === undefined) return 'FREE ALL DAY';
  if (minutes < 60) return `~${minutes} MIN`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}H ${m}M` : `${h}H`;
}

// ── Render cards ───────────────────────────────────────────────────────────

function makeCard(room, index) {
  const isSoon = room.minutes_until_next !== null && room.minutes_until_next <= 30;
  const card = el('div', isSoon ? 'card soon' : 'card');

  // Stagger entrance — cap at 30 cards to avoid slow tail
  card.style.animationDelay = `${Math.min(index, 30) * 28}ms`;

  card.appendChild(text('div', 'card-building', room.building));
  card.appendChild(text('div', 'card-room', room.room));

  const footer = el('div', 'card-footer');

  const status = el('div', 'card-status');
  status.appendChild(el('span', 'status-dot'));
  status.appendChild(text('span', 'status-label', isSoon ? 'CLOSING' : 'OPEN'));
  footer.appendChild(status);

  footer.appendChild(text('div', 'card-time', formatTimeUntil(room.minutes_until_next)));

  card.appendChild(footer);
  return card;
}

function renderRooms(rooms) {
  containerEl.textContent = '';

  if (!rooms || rooms.length === 0) {
    containerEl.appendChild(text('p', 'empty-state', 'No empty rooms right now.'));
    return;
  }

  const fragment = document.createDocumentFragment();
  rooms.forEach((room, i) => fragment.appendChild(makeCard(room, i)));
  containerEl.appendChild(fragment);
}

// ── Building chips ─────────────────────────────────────────────────────────

function renderChips() {
  filterEl.textContent = '';

  const allChip = el('button', currentBuilding === '' ? 'chip active' : 'chip');
  allChip.dataset.value = '';
  allChip.setAttribute('aria-pressed', currentBuilding === '' ? 'true' : 'false');
  allChip.textContent = 'ALL';
  allChip.addEventListener('click', () => selectBuilding(''));
  filterEl.appendChild(allChip);

  [...knownBuildings].sort().forEach(b => {
    const chip = el('button', currentBuilding === b ? 'chip active' : 'chip');
    chip.dataset.value = b;
    chip.setAttribute('aria-pressed', currentBuilding === b ? 'true' : 'false');
    chip.textContent = b;
    chip.addEventListener('click', () => selectBuilding(b));
    filterEl.appendChild(chip);
  });
}

function selectBuilding(value) {
  currentBuilding = value;
  renderChips();
  fetchRooms();
}

function updateBuildingChips(rooms) {
  const incoming = rooms.map(r => r.building).filter(b => !knownBuildings.has(b));
  if (incoming.length === 0) return;
  incoming.forEach(b => knownBuildings.add(b));
  renderChips();
}

// ── Status bar ─────────────────────────────────────────────────────────────

function updateStatus(count) {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  statusEl.textContent = `${count} room${count !== 1 ? 's' : ''} available  ·  live sync ${t}`;
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
    updateBuildingChips(rooms);
    updateStatus(rooms.length);
  } catch (err) {
    containerEl.textContent = '';
    containerEl.appendChild(text('p', 'error-state', 'Could not reach server.'));
    console.error('Fetch error:', err);
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

fetchRooms();
setInterval(fetchRooms, 60_000);
