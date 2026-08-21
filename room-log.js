const supabaseUrl = "https://bhfgcmknhrilmevclmye.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJoZmdjbWtuaHJpbG1ldmNsbXllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTMyNzM2ODMsImV4cCI6MjA2ODg0OTY4M30.1jWsjTGwhrcHeQrLritZODyaEl98vWRmNq0_slSMEzk";
const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);

const ONE_HOUR_MS = 60 * 60 * 1000;

let logRealtimeChannel = null;
let logEntries = [];
let logSearchTerm = "";
let logRoomFilter = "";
let logRoomStyles = new Map(); // room_name -> { bg, color, icon }
let logRoomStylesSite = null;

function normalizeHex(hex) {
  if (!hex) return '';
  let h = String(hex).trim();
  if (h && h[0] !== '#') h = '#' + h;
  if (/^#[0-9a-fA-F]{3}$/.test(h)) h = '#' + h.slice(1).split('').map(c => c + c).join('');
  return /^#[0-9a-fA-F]{6}$/.test(h) ? h.toLowerCase() : '';
}
function textForBg(bg) {
  try {
    const c = bg.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum < 140 ? '#fff' : '#000';
  } catch { return '#000'; }
}
async function loadRoomStylesForSite(site) {
  if (!site) { logRoomStyles.clear(); logRoomStylesSite = null; return; }
  if (logRoomStylesSite === site && logRoomStyles.size > 0) return; // already loaded

  const { data: rows, error } = await supabaseClient
    .from('rooms')
    .select('room_name, color_hex, icon_emoji')
    .eq('site', site);

  logRoomStyles.clear();
  logRoomStylesSite = site;
  if (!error && Array.isArray(rows)) {
    rows.forEach(r => {
      const bg = normalizeHex(r.color_hex) || '#eef2fb';
      const color = bg === '#eef2fb' ? '#000' : textForBg(bg);
      const icon = (r.icon_emoji || '').trim();
      logRoomStyles.set(r.room_name, { bg, color, icon });
    });
  }
}
function styleForRoom(name) {
  return logRoomStyles.get(name) || { bg: '#eef2fb', color: '#000', icon: '' };
}
function buildRoomPill(roomName) {
  const st = styleForRoom(roomName);
  const pill = document.createElement('span');
  pill.className = 'room-pill';
  pill.style.backgroundColor = st.bg;
  pill.style.color = st.color;
  pill.style.margin = '0 0.25em';
  pill.textContent = st.icon ? `${st.icon} ${roomName}` : roomName;
  return pill;
}

function populateRoomFilterOptions() {
  const select = document.getElementById('log-room-filter');
  if (!select) return;
  const previousValue = select.value;

  const rooms = Array.from(logRoomStyles.keys()).sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">All Rooms</option>';
  rooms.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });

  if (rooms.includes(previousValue)) select.value = previousValue; // preserve selection across reloads
}

async function deleteLogEntry(entry) {
  const target = entry.previous_room || 'unassigned';
  const ok = confirm(`Delete this log entry and revert ${entry.student_name} to ${target}? This can go over room capacity if needed.`);
  if (!ok) return;

  const { data, error } = await supabaseClient.rpc('revert_assignment_log_entry', {
    p_log_id: entry.id
  });

  if (error) {
    alert('Error reverting entry: ' + error.message);
    return;
  }
  if (data !== 'success') {
    alert('Could not revert that entry — it may have already been deleted or reverted elsewhere.');
    return;
  }
  await loadLog(); // realtime will also pick this up; refresh now so it's instant
}

// --- Site resolution — mirrors supervisor.js's normalizeSite/getSelectedSite,
// so this page always shows whatever site is currently selected elsewhere ---
function normalizeSite(raw) {
  if (!raw) return '';
  const val = String(raw);
  const sep = val.indexOf('|');
  if (sep === -1) return val;
  const column = val.slice(0, sep);
  const value = val.slice(sep + 1);
  if (column === 'site') return value;
  if (column === 'summer_site') return value;
  if (column === 'non_school_day') return 'Non-School Day';
  return value || '';
}
function getSelectedSite() {
  const raw = localStorage.getItem('studentListFilter') || '';
  return normalizeSite(raw);
}

function formatTime(entry) {
  return new Date(entry.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Builds the middle "action" portion of a log row as DOM nodes, so room
// names render as colored/icon pills instead of plain text.
function buildActionFragment(entry) {
  const frag = document.createDocumentFragment();
  if (entry.is_checkout) {
    frag.appendChild(document.createTextNode('signed out for the day'));
    return frag;
  }
  if (!entry.previous_room) {
    frag.appendChild(document.createTextNode('switched to '));
    frag.appendChild(buildRoomPill(entry.new_room));
    return frag;
  }
  frag.appendChild(document.createTextNode('moved from '));
  frag.appendChild(buildRoomPill(entry.previous_room));
  frag.appendChild(document.createTextNode(' to '));
  frag.appendChild(buildRoomPill(entry.new_room));
  return frag;
}

function renderLog() {
  const list = document.getElementById('log-list');
  const emptyMsg = document.getElementById('log-empty-message');
  if (!list) return;
  list.innerHTML = '';

  const cutoff = Date.now() - ONE_HOUR_MS;
  const term = logSearchTerm.trim().toLowerCase();

  const visible = logEntries
    .filter(e => !e.deleted_at && new Date(e.created_at).getTime() >= cutoff)
    .filter(e => !term || e.student_name.toLowerCase().includes(term))
    .filter(e => !logRoomFilter || e.previous_room === logRoomFilter || e.new_room === logRoomFilter)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (visible.length === 0) {
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  visible.forEach(entry => {
    const li = document.createElement('li');
    li.style.padding = '0.6rem 0';
    li.style.borderBottom = '1px solid #eee';
    li.style.fontSize = '1.05rem';
    li.style.display = 'flex';
    li.style.flexWrap = 'wrap';
    li.style.alignItems = 'center';
    li.style.gap = '0.3em';

    const nameEl = document.createElement('strong');
    nameEl.textContent = entry.student_name;
    li.appendChild(nameEl);
    li.appendChild(buildActionFragment(entry));

    const timeEl = document.createElement('span');
    timeEl.style.color = '#888';
    timeEl.style.fontSize = '0.9rem';
    timeEl.style.marginLeft = 'auto';
    timeEl.textContent = `— ${formatTime(entry)}`;
    li.appendChild(timeEl);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'btn btn-danger-subtle';
    deleteBtn.style.fontSize = '0.85rem';
    deleteBtn.style.padding = '0.3rem 0.7rem';
    deleteBtn.style.marginLeft = '0.5rem';
    deleteBtn.addEventListener('click', () => deleteLogEntry(entry));
    li.appendChild(deleteBtn);

    list.appendChild(li);
  });
}

async function loadLog() {
  const site = getSelectedSite();
  const badge = document.getElementById('log-site-badge');
  if (badge) badge.textContent = site ? `Site: ${site}` : 'No site selected';

  if (!site) {
    logEntries = [];
    renderLog();
    return;
  }

  await loadRoomStylesForSite(site);
  populateRoomFilterOptions();

  const cutoffIso = new Date(Date.now() - ONE_HOUR_MS).toISOString();
  const { data, error } = await supabaseClient
    .from('assignment_log')
    .select('id, student_id, student_name, previous_room, new_room, is_checkout, created_at')
    .eq('site', site)
    .is('deleted_at', null)
    .gte('created_at', cutoffIso)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error loading room log:', error.message);
    return;
  }
  logEntries = data || [];
  renderLog();
}

function startLogRealtime() {
  if (logRealtimeChannel) {
    try { supabaseClient.removeChannel(logRealtimeChannel); } catch {}
    logRealtimeChannel = null;
  }
  const site = getSelectedSite();
  if (!site) return;

  const safeVal = site.replace(/,/g, '\\,');
  logRealtimeChannel = supabaseClient
    .channel('room_log_' + safeVal)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'assignment_log', filter: `site=eq.${safeVal}` }, (payload) => {
      if (payload.eventType === 'INSERT') {
        logEntries.push(payload.new);
      } else if (payload.eventType === 'UPDATE') {
        logEntries = logEntries.map(e => e.id === payload.new.id ? payload.new : e);
      } else if (payload.eventType === 'DELETE') {
        logEntries = logEntries.filter(e => e.id !== payload.old.id);
      }
      renderLog();
    })
    .subscribe();
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadLog();
  startLogRealtime();

  const searchInput = document.getElementById('log-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      logSearchTerm = e.target.value;
      renderLog();
    });
  }
  const roomFilter = document.getElementById('log-room-filter');
  if (roomFilter) {
    roomFilter.addEventListener('change', (e) => {
      logRoomFilter = e.target.value;
      renderLog();
    });
  }

  // Safety net: re-checks every 60s — drops entries as they age past the
  // 1-hour window, and self-corrects if a realtime message was ever missed
  setInterval(loadLog, 60000);
});

// React immediately if the site is changed on another tab (e.g., Supervisor Dashboard)
window.addEventListener('storage', (e) => {
  if (e.key === 'studentListFilter') {
    loadLog();
    startLogRealtime();
  }
});