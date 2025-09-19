//push trigger 8/5 5:30 PM

// --- FILTERED STUDENT LIST SUPPORT ---
async function fetchFilteredStudents() {
  const col = currentDevice?.column;
  const val = currentDevice?.value;
  if (!col) return [];

  const build = (selectCols) => {
    let q = supabase.from('master_roster').select(selectCols);
    if (col === 'non_school_day') {
      const boolVal = (val === true || String(val) === 'true');
      q = q.eq('non_school_day', boolVal);
    } else {
      q = q.eq(col, val);
    }
    return q;
  };

  // attempt kgroups → k_groups → kgroup
  let query = build('id, firstname, lastname, grade, kgroups');
  let { data, error } = await query;
  if (error && error.code === '42703') {
    query = build('id, firstname, lastname, grade, k_groups');
    ({ data, error } = await query);
    if (error && error.code === '42703') {
      query = build('id, firstname, lastname, grade, kgroup');
      ({ data, error } = await query);
    }
  }
  if (error) {
    console.error('Error fetching students:', error.message);
    return [];
  }
  return data || [];
}

// --- END FILTERED STUDENT LIST SUPPORT ---

// ---- Sorting helpers ----
function normalizeGrade(g) {
  if (g === null || g === undefined || g === '') return 'Unknown';
  if (String(g).trim().toUpperCase() === 'K') return 'K';
  return String(g);
}

function gradeWeightKey(gradeKey) {
  if (gradeKey === 'K') return 0; // K first
  const n = parseInt(gradeKey, 10);
  if (!Number.isNaN(n)) return n; // 1..7 as numbers
  return 999; // Unknown or anything else at the end
}

function compareFirstLast(a, b) {
  const af = (a.firstname || '').toLowerCase();
  const bf = (b.firstname || '').toLowerCase();
  if (af !== bf) return af.localeCompare(bf);
  const al = (a.lastname || '').toLowerCase();
  const bl = (b.lastname || '').toLowerCase();
  return al.localeCompare(bl);
}
// ---- End sorting helpers ----

// Add these two lines at the very top of your app.js file
let statusBarUpdateTimeout;
const STATUS_BAR_DEBOUNCE_DELAY = 50; // milliseconds - adjust this value if needed (e.g., 50, 200)

let lastOverlayOpenTime = 0;

// Overlay fade-in/fade-out helpers
function showOverlay() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.classList.add('show');
}

function hideOverlay() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.classList.remove('show');
}

const supabaseUrl = "https://bhfgcmknhrilmevclmye.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJoZmdjbWtuaHJpbG1ldmNsbXllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTMyNzM2ODMsImV4cCI6MjA2ODg0OTY4M30.1jWsjTGwhrcHeQrLritZODyaEl98vWRmNq0_slSMEzk";

// --- Dynamic session start times (overrides hardcoded defaults when present) ---
let sessionStartMinutes = { // minutes after midnight
  session1: 355,  // 5:55 AM (fallback)
  session2: 535,  // 8:55 AM
  session3: 775,  // 12:55 PM
  session4: 895   // 2:55 PM
};

function parseTimeToMinutes(t) {
  if (!t) return null;
  try {
    // Accept "HH:MM" (24h) or "H:MM"
    const [hh, mm] = String(t).split(':').map(x => parseInt(x, 10));
    if (Number.isFinite(hh) && Number.isFinite(mm)) return (hh * 60) + mm;
  } catch {}
  return null;
}

function getCurrentRoomTable() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();

  const sessionStartTimes = {
    session1: 355,  // 5:55 AM
    session2: 535,  // 8:55 AM
    session3: 775,  // 12:55 PM
    session4: 895   // 2:55 PM
  };

  if (minutes >= sessionStartTimes.session1 && minutes < sessionStartTimes.session2) {
    return "6:00_rooms";
  } else if (minutes >= sessionStartTimes.session2 && minutes < sessionStartTimes.session3) {
    return "9:00_rooms";
  } else if (minutes >= sessionStartTimes.session3 && minutes < sessionStartTimes.session4) {
    return "1:00_rooms";
  } else {
    return "3:00_rooms"; // After 2:55 PM and before 5:55 AM
  }
}

const supabase = window.supabase.createClient(supabaseUrl, supabaseKey);

async function loadSessionTimes() {
  try {
    const { data, error } = await supabase
      .from('session_start_times')
      .select('session_key, start_time');
    if (error) throw error;
    if (Array.isArray(data)) {
      const next = { ...sessionStartMinutes };
      for (const row of data) {
        const key = row.session_key; // e.g., 'session1'
        const mins = parseTimeToMinutes(row.start_time);
        if (key && mins != null && Object.prototype.hasOwnProperty.call(next, key)) {
          next[key] = mins;
        }
      }
      sessionStartMinutes = next;
    }
  } catch (e) {
    console.warn('[session times] using fallback defaults', e?.message || e);
  }
}

function bindSessionTimesRealtime() {
  if (window.__sessionTimesBound) return;
  supabase
    .channel('public:session_start_times')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'session_start_times' }, async () => {
      await loadSessionTimes();
      // Refresh UI pieces that depend on slot
      await loadRoomStatusBar();
    })
    .subscribe();
  window.__sessionTimesBound = true;
}

// --- Rooms style-aware select helper (resilient) ---
async function selectRoomsWithStyles(baseQuery) {
  // Try with style columns first; if the columns don't exist on this project,
  // fall back to a minimal selection automatically.
  let q = baseQuery.select('room_name, capacity, active, color_hex, icon_emoji');
  let { data, error } = await q;
  if (error && error.code === '42703') {
    // Columns not found -> retry without them
    const retry = baseQuery.select('room_name, capacity, active');
    const r2 = await retry;
    return r2;
  }
  return { data, error };
}

// ---- Device filter support ----
function uuidish() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
let currentDevice = { key: null, column: null, value: null, name: null };

async function ensureDeviceRow() {
  // Stable local key
  let key = localStorage.getItem('device_key');
  if (!key) { key = uuidish(); localStorage.setItem('device_key', key); }
  if (!window.currentDevice) window.currentDevice = {};
  currentDevice.key = key;

  // Fetch existing (do NOT upsert device_name here)
  const { data, error } = await supabase
    .from('device_roster_filters')
    .select('*')
    .eq('device_key', key)
    .maybeSingle();

  if (error) {
    console.error('[device] fetch failed', error);
  }

  if (!data) {
    // Create minimal row; leave name NULL so supervisor naming sticks
    const { error: insErr } = await supabase
      .from('device_roster_filters')
      .insert({ device_key: key, active: true });
    if (insErr) console.error('[device] insert failed', insErr);
  } else {
    console.log('[device] initial row', data);
    applyDeviceFilterRow(data);
  }

  // Realtime: listen to just this device row
  if (!window.__deviceRealtimeBound) {
    supabase
      .channel('device_row_' + key)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'device_roster_filters', filter: `device_key=eq.${key}` }, (payload) => {
        if (payload?.new) applyDeviceFilterRow(payload.new);
      })
      .subscribe();
    window.__deviceRealtimeBound = true;
  }

  // Periodic read-only refresh (no writes)
  if (!window.__deviceRefreshInterval) {
    window.__deviceRefreshInterval = setInterval(async () => {
      const { data: row, error: rerr } = await supabase
        .from('device_roster_filters')
        .select('*')
        .eq('device_key', key)
        .maybeSingle();
      if (!rerr && row) applyDeviceFilterRow(row);
    }, 10000);
  }
}

function updateSiteTitleFromDevice(){
  const col = currentDevice?.column;
  const val = currentDevice?.value;
  let label = '';
  if (col === 'site' || col === 'summer_site') label = val || '';
  else if (col === 'non_school_day' && String(val) === 'true') label = 'Non-School Day';

  // Prefer a dedicated element if present, otherwise fall back to the main H1
  const el = document.getElementById('site-title')
        || document.querySelector('header h1')
        || Array.from(document.querySelectorAll('h1')).find(h => /digital switching/i.test(h.textContent))
        || document.querySelector('h1');
  if (el && label) {
    el.textContent = label;
  }
}

function applyDeviceFilterRow(row) {
  if (!row) return;
  if (!window.currentDevice) window.currentDevice = {};

  if (Object.prototype.hasOwnProperty.call(row, 'device_name')) {
    currentDevice.name = row.device_name; // accept NULL/empty; do not write defaults
  }
  if (Object.prototype.hasOwnProperty.call(row, 'filter_column')) currentDevice.column = row.filter_column;
  if (Object.prototype.hasOwnProperty.call(row, 'filter_value')) currentDevice.value = row.filter_value;
  if (Object.prototype.hasOwnProperty.call(row, 'updated_at')) currentDevice.updated_at = row.updated_at;

  const deviceNameEl = document.getElementById('device-name');
  const deviceFilterEl = document.getElementById('device-filter');
  if (deviceNameEl) deviceNameEl.textContent = (currentDevice.name ?? 'Device');
  if (deviceFilterEl) {
    let label = 'No list';
    if (currentDevice.column === 'site') label = currentDevice.value;
    else if (currentDevice.column === 'summer_site') label = `Summer: ${currentDevice.value}`;
    else if (currentDevice.column === 'non_school_day' && String(currentDevice.value) === 'true') label = 'Non-School Day';
    deviceFilterEl.textContent = label;
  }

  if (typeof renderDeviceInfoPanel === 'function') renderDeviceInfoPanel();
  updateSiteTitleFromDevice();
}

// Determine site used by rooms for this device's filter
function resolveSiteForRoomsFromDevice() {
  if (!currentDevice.column) return null;
  if (currentDevice.column === 'site') return currentDevice.value;
  if (currentDevice.column === 'summer_site') return currentDevice.value;
  if (currentDevice.column === 'non_school_day' && String(currentDevice.value) === 'true') return 'Non-School Day';
  return null;
}

// Session label for time-based sites (matches rooms.time_slot values)
function currentTimeSlotLabel() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const s1 = sessionStartMinutes.session1;
  const s2 = sessionStartMinutes.session2;
  const s3 = sessionStartMinutes.session3;
  const s4 = sessionStartMinutes.session4;
  if (minutes >= s1 && minutes < s2) return '6:00';
  if (minutes >= s2 && minutes < s3) return '9:00';
  if (minutes >= s3 && minutes < s4) return '1:00';
  return '3:00';
}

async function fetchEligibleRooms(site, timeSlot) {
  if (!site) return [];

  // Base select WITH style columns first
  let q = supabase
    .from('rooms')
    .select('room_name, capacity, active, color_hex, icon_emoji')
    .eq('site', site)
    .eq('active', true);

  // Time-slot scoping for Kids Play / Club Knights / Non-School Day
  if (["Kids Play", "Club Knights", "Non-School Day"].includes(site)) {
    q = q.eq('time_slot', timeSlot);
  } else {
    q = q.is('time_slot', null);
  }

  // Order by room name for stable UI
  q = q.order('room_name', { ascending: true });

  // Try with style columns; if they don't exist, retry without them
  let { data, error } = await q;
  if (error && error.code === '42703') {
    const retry = supabase
      .from('rooms')
      .select('room_name, capacity, active')          // no style cols
      .eq('site', site)
      .eq('active', true);

    if (["Kids Play", "Club Knights", "Non-School Day"].includes(site)) {
      retry.eq('time_slot', timeSlot);
    } else {
      retry.is('time_slot', null);
    }

    retry.order('room_name', { ascending: true });
    const r2 = await retry;
    data = r2.data;
    error = r2.error;
  }

  if (error) {
    console.error('rooms load error', error);
    return [];
  }

  // Hide placeholder rows and capacity==0
  return (data || []).filter((r) => {
    const n = (r.room_name || '').trim().toLowerCase();
    return n !== 'gone' && n !== 'activity in building' && (r.capacity || 0) > 0;
  });
}

async function fetchRoomCounts(site) {
  // Returns a Map<room_name, count>
  if (!site) return new Map();

  // Decide which master_roster column to filter by based on the device's roster mode
  //  - School-year sites:     filter by master_roster.site
  //  - Summer sites:          filter by master_roster.summer_site
  //  - Non-school day lists:  filter by master_roster.non_school_day = true
  let q = supabase.from('master_roster').select('assigned_room, is_gone');
  const mode = (currentDevice?.column || '').toString();

  if (mode === 'site') {
    q = q.eq('site', site);
  } else if (mode === 'summer_site') {
    q = q.eq('summer_site', site);
  } else if (mode === 'non_school_day') {
    q = q.eq('non_school_day', true);
  }

  // Count only students who are not gone (is_gone = false) or where the column is still NULL
  // PostgREST `or` syntax: field.is.null OR field.eq.false
  q = q.or('is_gone.is.null,is_gone.eq.false');

  const { data, error } = await q;
  if (error) {
    console.error('count load error', error);
    return new Map();
  }

  const map = new Map();
  (data || []).forEach((s) => {
    if (!s.assigned_room) return;
    map.set(s.assigned_room, (map.get(s.assigned_room) || 0) + 1);
  });
  return map;
}

// Helper function to get room colors (extracted for reuse)
function getRoomColors(roomName) {
  let bgColor = "#f0f0f0"; // Default light gray
  let textColor = "#000"; // Always black for text

  switch (roomName) {
    case "Art Room":
      bgColor = "#ff0000"; break;
    case "Cafeteria":
      bgColor = "#7a5937"; break;
    case "Room A":
      bgColor = "#ff9900"; break;
    case "Room B":
      bgColor = "#ff99cc"; break;
    case "Room C":
      bgColor = "#fad45e"; break;
    case "Room D":
      bgColor = "#8e7cc3"; break;
    case "Room E":
      bgColor = "#46bdc6"; break;
    case "Gym":
      bgColor = "#6aa84f"; break;
    case "Outside":
      bgColor = "#4a86e8"; break;
    case "FACS":
      bgColor = "#ffebb7"; break;
    case "Hallway (Atrium)":
      bgColor = "#ffff00"; break;
    case "Media Center":
      bgColor = "#d9ead3"; break;
    case "Tennis Courts":
      bgColor = "#f4cccc"; break;
    case "Pool":
      bgColor = "#c9daf8"; break;
    case "Activity in Building":
      bgColor = "#d9d9d9"; break;
    case "Gone":
      bgColor = "#d9d9d9"; break;
    case "Creative Corner":
      bgColor = "#6a1b9a"; break; // purple
    case "Discovery Den":
      bgColor = "#00897b"; break; // teal
    case "Imagination Station":
      bgColor = "#5e35b1"; break; // deep purple
  }
  return { bgColor, textColor };
}

// Optional icon map; used if rooms.icon_key is set or we infer from name
const ROOM_ICON_MAP = {
  art: '🎨', cafeteria: '🍽️', gym: '🏀', outside: '🌳', media: '📚', pool: '🏊',
  tennis: '🎾', hallway: '🚪', facs: '🧵', rooma: '🅰️', roomb: '🅱️', roomc: '🇨',
  roomd: '🇩', roome: '🇪',
  creative: '🧩', discovery: '🔎', imagination: '💡'
};

const KG_ANIMAL_STYLES = {
  bears: { emoji: '🐻', color: '#8D5524' },
  bear:  { emoji: '🐻', color: '#8D5524' },
  tigers:{ emoji: '🐯', color: '#F59E0B' },
  tiger: { emoji: '🐯', color: '#F59E0B' },
  lions: { emoji: '🦁', color: '#FACC15' },
  lion:  { emoji: '🦁', color: '#FACC15' },
  giraffes:{emoji:'🦒', color:'#FBBF24'},
  giraffe:{ emoji:'🦒', color:'#FBBF24'},
  pandas:{ emoji:'🐼', color:'#4B5563'},
  panda: { emoji:'🐼', color:'#4B5563'},
  foxes: { emoji:'🦊', color:'#F97316'},
  fox:   { emoji:'🦊', color:'#F97316'},
  owls:  { emoji:'🦉', color:'#6B7280'},
  owl:   { emoji:'🦉', color:'#6B7280'},
  dolphins:{emoji:'🐬', color:'#60A5FA'},
  dolphin:{emoji:'🐬', color:'#60A5FA'},
  penguins:{emoji:'🐧', color:'#374151'},
  penguin:{ emoji:'🐧', color:'#374151'},
  zebras:{ emoji:'🦓', color:'#111827'},
  zebra: { emoji:'🦓', color:'#111827'},
  elephants: { emoji: '🐘', color: '#9CA3AF' },
  elephant:  { emoji: '🐘', color: '#9CA3AF' },
  frogs:     { emoji: '🐸', color: '#22C55E' },
  frog:      { emoji: '🐸', color: '#22C55E' }
};
function styleForKAnimal(name){
  const k = (name||'').toString().trim().toLowerCase();
  return KG_ANIMAL_STYLES[k] || { emoji:'🐾', color:'#94a3b8' };
}

function resolveRoomStyle(room) {
  // --- normalize color_hex ---
  const raw = (room.color_hex || '').trim();
  let hex = raw;

  // add leading # if missing
  if (hex && !hex.startsWith('#')) hex = `#${hex}`;

  // normalize 3-digit to 6-digit (#abc -> #aabbcc)
  const hex3 = /^#[0-9a-fA-F]{3}$/;
  const hex6 = /^#[0-9a-fA-F]{6}$/;
  if (hex3.test(hex)) {
    hex = '#' + hex.slice(1).split('').map(c => c + c).join('');
  }

  // validate final hex
  const validHex = hex6.test(hex) ? hex.toLowerCase() : '';

  // use configured color if valid; otherwise legacy fallback
  let bgColor = validHex || getRoomColors(room.room_name).bgColor;

  // text contrast (simple luminance)
  let textColor = '#000';
  try {
    const c = bgColor.replace('#','');
    const r = parseInt(c.substring(0,2),16);
    const g = parseInt(c.substring(2,4),16);
    const b = parseInt(c.substring(4,6),16);
    const luminance = 0.299*r + 0.587*g + 0.114*b;
    if (luminance < 140) textColor = '#fff';
  } catch {}

  // --- icon resolution ---
  let icon = '';
  const rawEmoji = (room.icon_emoji || '').trim();
  if (rawEmoji) {
    icon = rawEmoji; // exact emoji from DB
  } else {
    const key = (room.icon_key || '').toLowerCase();
    const n = (room.room_name || '').toLowerCase();
    if (ROOM_ICON_MAP[key]) icon = ROOM_ICON_MAP[key];
    else if (n.includes('art')) icon = ROOM_ICON_MAP.art;
    else if (n.includes('cafeteria')) icon = ROOM_ICON_MAP.cafeteria;
    else if (n.includes('gym')) icon = ROOM_ICON_MAP.gym;
    else if (n.includes('outside')) icon = ROOM_ICON_MAP.outside;
    else if (n.includes('media')) icon = ROOM_ICON_MAP.media;
    else if (n.includes('pool')) icon = ROOM_ICON_MAP.pool;
    else if (n.includes('tennis')) icon = ROOM_ICON_MAP.tennis;
    else if (n.includes('hallway')) icon = ROOM_ICON_MAP.hallway;
    else if (n.includes('creative')) icon = ROOM_ICON_MAP.creative;
    else if (n.includes('discovery')) icon = ROOM_ICON_MAP.discovery;
    else if (n.includes('imagination')) icon = ROOM_ICON_MAP.imagination;
    else if (n.includes('facs')) icon = ROOM_ICON_MAP.facs;
  }

  return { bgColor, textColor, icon };
}

// Function to load and display the static room status bar
async function loadRoomStatusBar() {
  clearTimeout(statusBarUpdateTimeout);
  statusBarUpdateTimeout = setTimeout(async () => {
    const statusBar = document.getElementById("room-status-bar");
    if (!statusBar) return;

    const previous = Array.from(statusBar.querySelectorAll('.room-status'))
    .reduce((acc, el) => { acc[el.textContent.split(':')[0].trim()] = el.textContent; return acc; }, {});

    // Create a temporary DocumentFragment to build the new content
    const newStatusBarContent = document.createDocumentFragment();

    const title = document.createElement('h3');
    title.textContent = "CURRENT ROOM STATUS:";
    title.style.marginBottom = '10px';
    title.style.textAlign = 'center';
    title.style.color = '#333';
    title.style.width = '100%';
    newStatusBarContent.appendChild(title); // Append to temp container

    const site = resolveSiteForRoomsFromDevice();
    if (!site) { statusBar.innerHTML = 'No device list set.'; return; }
    const timeSlot = ['Kids Play','Club Knights','Non-School Day'].includes(site) ? currentTimeSlotLabel() : null;

    const [rooms, counts] = await Promise.all([
      fetchEligibleRooms(site, timeSlot),
      fetchRoomCounts(site)
    ]);
    console.log('[rooms styles]', rooms.map(r => ({ name: r.room_name, color_hex: r.color_hex, icon_emoji: r.icon_emoji, time_slot: r.time_slot })));

    const sortedRooms = rooms.slice().sort((a, b) => a.room_name.localeCompare(b.room_name));

    for (const room of sortedRooms) {
      const roomDiv = document.createElement('div');
      roomDiv.className = 'room-status';

      const { bgColor, textColor, icon } = resolveRoomStyle(room);
      roomDiv.style.backgroundColor = bgColor;
      roomDiv.style.color = textColor;

      const assignedCount = counts.get(room.room_name) || 0;
      roomDiv.textContent = `${icon ? icon + ' ' : ''}${room.room_name}: ${assignedCount}/${room.capacity}`;
      const prevText = previous[room.room_name];
      if (prevText && prevText !== roomDiv.textContent) {
        roomDiv.classList.add('pulse');
        setTimeout(() => roomDiv.classList.remove('pulse'), 500);
      }
      newStatusBarContent.appendChild(roomDiv);
    }

    // Replace the entire content of the actual status bar element in one go
    statusBar.innerHTML = ''; // Clear the *actual* displayed element just once
    statusBar.appendChild(newStatusBarContent); // Append all new content at once
  }, STATUS_BAR_DEBOUNCE_DELAY);
}

// --- Assignment cache (from master_roster) and real-time subscription ---
let assignmentsCache = [];

async function fetchAssignments(siteFilterValue) {
  // Optionally scope by site for quicker counts; if not provided, load all
  let q = supabase.from('master_roster').select('id, assigned_room, site');
  if (siteFilterValue) q = q.eq('site', siteFilterValue);
  const { data, error } = await q;
  if (!error && data) {
    assignmentsCache = data;
  }
}

// Initial cache population (no site until device filter is known)
fetchAssignments();

// Realtime: listen to master_roster & rooms
supabase
  .channel('public:student_ui')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'master_roster' }, () => {
    // Refresh status bar; overlay (if open) will re-pull live availability elsewhere
    loadRoomStatusBar();
  })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, () => {
    loadRoomStatusBar();
  })
  .subscribe();
// Load and display students (sorted by grade K,1..7 then Unknown; and by Firstname, Lastname within grade)
async function loadStudents() {
  let students = [];
  try {
    students = await fetchFilteredStudents();
  } catch (err) {
    console.error("Error fetching students:", err);
    const container = document.getElementById('student-list');
    container.innerHTML = `<p>Error loading students. Please try again later.</p>`;
    return;
  }

  const container = document.getElementById('student-list');
  container.innerHTML = '';

  const gradeTabsContainer = document.getElementById('grade-tabs');
  if (gradeTabsContainer) gradeTabsContainer.innerHTML = '';

  if (!students || students.length === 0) {
    container.innerHTML = `<p>${currentDevice?.column ? 'No students found for the selected device roster.' : 'This device is not assigned to a roster yet.'}</p>`;
    return;
  }

  // Create normalized grade keys for grouping & ordering
  const gradeKeyFor = (s) => normalizeGrade(s.grade);
  const uniqueGradeKeys = Array.from(new Set(students.map(gradeKeyFor)));
  // Sort grade keys by our custom precedence (K, 1..7, Unknown)
  uniqueGradeKeys.sort((a, b) => gradeWeightKey(a) - gradeWeightKey(b));

  // Build tabs in the sorted order
  if (gradeTabsContainer) {
    uniqueGradeKeys.forEach((gradeKey, index) => {
      const tabBtn = document.createElement('button');
      const displayGrade = gradeKey; // 'K', '1'..'7', or 'Unknown'
      tabBtn.textContent = displayGrade;
      tabBtn.classList.add('grade-tab');
      if (index === 0) tabBtn.classList.add('active');
      tabBtn.dataset.grade = gradeKey; // normalized key
      gradeTabsContainer.appendChild(tabBtn);
    });
  }

  const isAlbertvillePrimary = (currentDevice?.column === 'site' && currentDevice?.value === 'Albertville Primary School');

  // Build grade sections in the same sorted order
  uniqueGradeKeys.forEach((gradeKey, index) => {
    const section = document.createElement('div');
    section.classList.add('grade-section');
    section.dataset.grade = gradeKey; // normalized key
    section.style.display = index === 0 ? 'block' : 'none';

    const studentGrid = document.createElement('div');
    studentGrid.style.display = 'flex';
    studentGrid.style.flexWrap = 'wrap';
    studentGrid.style.rowGap = '2px';
    studentGrid.style.columnGap = '16px';
    studentGrid.style.marginBottom = '1rem';

    // Students in this grade, sorted by Firstname then Lastname
    const inThisGrade = students
      .filter(s => gradeKeyFor(s) === gradeKey)
      .sort(compareFirstLast);

    if (isAlbertvillePrimary && gradeKey === 'K') {
      // 1) Build K-group chips (tabs) - as a horizontal pill row, styled like grade tabs, with animal color
      const groupTabs = document.createElement('div');
      groupTabs.style.display = 'flex';
      groupTabs.style.flexWrap = 'wrap';
      groupTabs.style.gap = '12px';
      groupTabs.style.margin = '8px 0 12px';

      // Partition K students by group value
      const groupOf = (s) => s.kgroups ?? s.k_groups ?? s.kgroup ?? 'Group';
      const groups = new Map();
      inThisGrade.forEach(s => {
        const g = groupOf(s) || 'Group';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(s);
      });

      // Create a container per group (hidden by default)
      const groupContainers = {};
      Array.from(groups.keys()).sort((a,b)=>String(a).localeCompare(String(b))).forEach((gName, idx) => {
        const { emoji, color } = styleForKAnimal(gName);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.textContent = `${emoji} ${gName}`;
        chip.classList.add('grade-tab', 'kg-chip'); // reuse pill styling but allow custom overrides
        chip.dataset.group = gName;
        // override background to animal color
        chip.style.background = color;
        chip.style.color = '#fff';
        // first chip active by default
        if (idx === 0) chip.classList.add('active');
        groupTabs.appendChild(chip);

        const grid = document.createElement('div');
        grid.style.display = idx === 0 ? 'flex' : 'none';
        grid.style.flexWrap = 'wrap';
        grid.style.rowGap = '2px';
        grid.style.columnGap = '16px';
        grid.style.margin = '8px 0 16px';

        groups.get(gName).forEach(student => {
          const btn = document.createElement('button');
          btn.textContent = `${student.firstname} ${student.lastname}`;
          btn.classList.add('student-name');
          btn.dataset.id = student.id;
          btn.dataset.name = `${student.firstname} ${student.lastname}`;
          btn.style.cursor = 'pointer';
          btn.style.padding = '10px 15px';
          btn.style.fontSize = '1.2rem';
          btn.style.borderRadius = '8px';
          btn.style.border = '1px solid #ccc';
          btn.style.flex = '1 1 calc(50% - 10px)';
          btn.style.color = '#000';
          btn.addEventListener('click', () => openRoomOverlayForStudent(student));
          grid.appendChild(btn);
        });

        groupContainers[gName] = grid;
        section.appendChild(grid);
      });

      // Wire chip clicks like tabs, toggle active state
      groupTabs.addEventListener('click', (e) => {
        const chip = e.target.closest('button[data-group]');
        if (!chip) return;
        const g = chip.dataset.group;
        // toggle active state like grade tabs
        groupTabs.querySelectorAll('button[data-group]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        // show matching grid
        Object.entries(groupContainers).forEach(([name, el]) => { el.style.display = (name === g) ? 'flex' : 'none'; });
      });

      section.insertBefore(groupTabs, section.firstChild);
    } else {
      inThisGrade.forEach(student => {
        const btn = document.createElement('button');
        btn.textContent = `${student.firstname} ${student.lastname}`;
        btn.classList.add('student-name');
        btn.dataset.id = student.id;
        btn.dataset.name = `${student.firstname} ${student.lastname}`;
        btn.style.cursor = 'pointer';
        btn.style.padding = '10px 15px';
        btn.style.fontSize = '1.2rem';
        btn.style.borderRadius = '8px';
        btn.style.border = '1px solid #ccc';
        btn.style.flex = '1 1 calc(50% - 10px)';
        btn.style.color = '#000';
        btn.addEventListener('click', () => openRoomOverlayForStudent(student));
        studentGrid.appendChild(btn);
      });
      section.appendChild(studentGrid);
    }
    container.appendChild(section);
  });

  // Tab switching behavior
  if (gradeTabsContainer) {
    gradeTabsContainer.querySelectorAll('.grade-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        gradeTabsContainer.querySelectorAll('.grade-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const selectedGrade = tab.dataset.grade; // normalized key
        document.querySelectorAll('.grade-section').forEach(sec => {
          sec.style.display = sec.dataset.grade === selectedGrade ? 'block' : 'none';
        });
      });
    });
  }
}

// New student-name click: open device-aware room chooser overlay
async function openRoomOverlayForStudent(student) {
  const site = resolveSiteForRoomsFromDevice();
  if (!site) { showMessage('This device is not assigned to a student list yet.', false); return; }
  const timeSlot = ['Kids Play','Club Knights','Non-School Day'].includes(site) ? currentTimeSlotLabel() : null;

  // Remember for RPC
  window.selectedStudentId = student.id;
  window.selectedStudentName = `${student.firstname} ${student.lastname}`;

  // Wire close
  const closeBtn = document.getElementById('room-overlay-close');
  if (closeBtn) closeBtn.onclick = () => {
    document.getElementById('room-overlay').classList.remove('show');
  };

  // Build list
  const listEl = document.getElementById('room-overlay-list');
  const emptyEl = document.getElementById('room-overlay-empty');
  const overlayEl = document.getElementById('room-overlay');
  const titleEl = document.getElementById('room-overlay-title');
  if (titleEl) titleEl.textContent = `Hi, ${student.firstname}! Where would you like to go?`;

  listEl.innerHTML = 'Loading…';
  overlayEl.classList.add('show');

  const [rooms, counts] = await Promise.all([
    fetchEligibleRooms(site, timeSlot),
    fetchRoomCounts(site)
  ]);

  const available = rooms.filter(r => (counts.get(r.room_name) || 0) < (r.capacity || 0));
  listEl.innerHTML = '';


  if (available.length === 0) {
    emptyEl.style.display = 'block';
  } else {
    emptyEl.style.display = 'none';
    available.forEach(r => {
      const inRoom = counts.get(r.room_name) || 0;
      const btn = document.createElement('button');
      btn.className = 'room-choice';

      const style = resolveRoomStyle(r);
      // Filled pill styling
      btn.style.backgroundColor = style.bgColor;
      btn.style.color = style.textColor || '#000';
      btn.style.display = 'block';
      btn.style.margin = '0.35rem auto';
      btn.style.boxSizing = 'border-box';
      btn.style.width = '100%';
      btn.style.padding = '1.5rem 1rem';
      btn.style.fontSize = '1.1rem';
      btn.style.border = 'none';
      btn.style.borderRadius = '9999px';
      btn.style.boxShadow = 'inset 0 -1px 0 rgba(0,0,0,0.06)';
      btn.style.transition = 'transform .06s ease';

      btn.onpointerdown = () => (btn.style.transform = 'scale(0.98)');
      btn.onpointerup   = () => (btn.style.transform = 'scale(1)');
      btn.onpointerleave= () => (btn.style.transform = 'scale(1)');

      btn.textContent = `${style.icon ? style.icon + ' ' : ''}${r.room_name} — ${inRoom}/${r.capacity}`;
      btn.addEventListener('click', () => chooseRoom(student.id, site, r.room_name, timeSlot));
      listEl.appendChild(btn);
    });

    // For Club Knights only: provide an "Activity in Building" choice
    if (site === 'Club Knights') {
      const activityBtn = document.createElement('button');
      activityBtn.className = 'room-choice';
      const activityStyle = resolveRoomStyle({ room_name: 'Activity in Building', color_hex: '#d9d9d9', icon_emoji: '🏛️' });
      activityBtn.style.backgroundColor = activityStyle.bgColor;
      activityBtn.style.color = activityStyle.textColor || '#000';
      activityBtn.style.display = 'block';
      activityBtn.style.margin = '0.35rem auto';
      activityBtn.style.boxSizing = 'border-box';
      activityBtn.style.width = '100%';
      activityBtn.style.padding = '0.9rem 1rem';
      activityBtn.style.fontSize = '1.1rem';
      activityBtn.style.border = 'none';
      activityBtn.style.borderRadius = '9999px';
      activityBtn.style.boxShadow = 'inset 0 -1px 0 rgba(0,0,0,0.06)';
      activityBtn.style.transition = 'transform .06s ease';

      activityBtn.onpointerdown = () => (activityBtn.style.transform = 'scale(0.98)');
      activityBtn.onpointerup   = () => (activityBtn.style.transform = 'scale(1)');
      activityBtn.onpointerleave= () => (activityBtn.style.transform = 'scale(1)');

      activityBtn.textContent = `${activityStyle.icon ? activityStyle.icon + ' ' : ''}Activity in Building`;
      activityBtn.addEventListener('click', () => markStudentActivityInBuilding(student.id));
      listEl.appendChild(activityBtn);
    }

    // Always provide an inline "Gone" choice styled like a room
    const goneBtn = document.createElement('button');
    goneBtn.className = 'room-choice';
    // style using the same resolver with a synthetic room object
    const goneStyle = resolveRoomStyle({ room_name: 'Gone', color_hex: '#d9d9d9', icon_emoji: '🚪' });
    // Filled pill styling for Gone
    goneBtn.style.backgroundColor = goneStyle.bgColor;
    goneBtn.style.color = goneStyle.textColor || '#000';
    goneBtn.style.display = 'block';
    goneBtn.style.margin = '0.35rem auto';
    goneBtn.style.boxSizing = 'border-box';
    goneBtn.style.width = '100%';
    goneBtn.style.padding = '0.9rem 1rem';
    goneBtn.style.fontSize = '1.1rem';
    goneBtn.style.border = 'none';
    goneBtn.style.borderRadius = '9999px';
    goneBtn.style.boxShadow = 'inset 0 -1px 0 rgba(0,0,0,0.06)';
    goneBtn.style.transition = 'transform .06s ease';

    goneBtn.onpointerdown = () => (goneBtn.style.transform = 'scale(0.98)');
    goneBtn.onpointerup   = () => (goneBtn.style.transform = 'scale(1)');
    goneBtn.onpointerleave= () => (goneBtn.style.transform = 'scale(1)');

    goneBtn.textContent = `${goneStyle.icon ? goneStyle.icon + ' ' : ''}Gone`;
    goneBtn.addEventListener('click', () => markStudentGone(student.id));
    listEl.appendChild(goneBtn);
  }
}

// Server-authoritative room assignment using RPC (Option A)
async function chooseRoom(studentId, site, roomName, timeSlot) {
  // 0) Prevent double taps across all room-choice buttons in the overlay
  const overlay = document.getElementById('room-overlay');
  const buttons = overlay ? overlay.querySelectorAll('.room-choice') : [];
  buttons.forEach(b => { b.disabled = true; b.style.opacity = '0.85'; });

  try {
    // 1) Call the safe, race-proof RPC on the server
    const { data, error } = await supabase.rpc('assign_student_to_room_v2', {
      p_student_id: Number(studentId),
      p_site: site,
      p_room_name: roomName,
      p_time_slot: timeSlot // pass null for standard sites
    });

    // 2) Small UI delay for consistent feedback
    await new Promise(res => setTimeout(res, 300));

    if (error) {
      // If the function is missing (e.g., not deployed), gracefully fallback to legacy client-side path
      // PostgREST missing function error code can vary; check message text as a safety net
      const msg = (error.message || '').toLowerCase();
      const missing = error.code === '42883' || msg.includes('function') && msg.includes('does not exist');
      if (missing) {
        console.warn('[assign RPC] missing, falling back to client-side update');
        await legacyChooseRoomClientSide(studentId, site, roomName, timeSlot);
        return;
      }
      console.error('RPC error:', error);
      showMessage('Failed to assign room. Please try again.', false);
      return;
    }

    if (data === 'room_full') {
      showMessage(`Sorry, ${roomName} is now full. Please choose another room.`, false);
    } else if (data === 'room_not_found') {
      showMessage('That room is unavailable right now.', false);
    } else if (data === 'student_not_found') {
      showMessage('Could not find that student record.', false);
    } else if (data === 'success') {
      showMessage(`Thanks, ${window.selectedStudentName}! You got a spot in ${roomName}.`, true);
      if (overlay) overlay.classList.remove('show');
    } else {
      // Unknown payload; be conservative
      showMessage('Unable to assign right now. Please try again.', false);
    }
  } catch (e) {
    console.error('chooseRoom exception', e);
    showMessage('Something went wrong. Please try again.', false);
  } finally {
    // 3) Refresh UI regardless of outcome
    await loadStudents();
    await loadRoomStatusBar();
    // Re-enable buttons if overlay is still open
    buttons.forEach(b => { b.disabled = false; b.style.opacity = ''; });
  }
}

// Legacy client-side fallback used only when the RPC is not available
async function legacyChooseRoomClientSide(studentId, site, roomName, timeSlot) {
  const [rooms, counts] = await Promise.all([
    fetchEligibleRooms(site, timeSlot),
    fetchRoomCounts(site)
  ]);

  const room = rooms.find(r => r.room_name === roomName);
  const currentCount = counts.get(roomName) || 0;

  if (room && currentCount < room.capacity) {
    const { error } = await supabase
      .from('master_roster')
      .update({ assigned_room: roomName, is_gone: false, gone_at: null })
      .eq('id', Number(studentId));

    await new Promise(res => setTimeout(res, 300));

    if (!error) {
      showMessage(`Thanks, ${window.selectedStudentName}! You got a spot in ${roomName}.`, true);
      const overlay = document.getElementById('room-overlay');
      if (overlay) overlay.classList.remove('show');
    } else {
      console.error('Legacy update error:', error);
      showMessage('Failed to assign room. Please try again.', false);
    }
  } else {
    await new Promise(res => setTimeout(res, 300));
    showMessage(`Sorry, ${roomName} is now full. Please choose another room.`, false);
  }

  await loadStudents();
  await loadRoomStatusBar();
}


// Mark a student as gone (checked out)
async function markStudentGone(studentId) {
  try {
    const { error } = await supabase
      .from('master_roster')
      .update({ is_gone: true, gone_at: new Date().toISOString(), assigned_room: null })
      .eq('id', Number(studentId));
    if (error) throw error;

    showMessage(`Thanks, ${window.selectedStudentName || 'student'}! You are checked out.`, true);
    const overlay = document.getElementById('room-overlay');
    if (overlay) overlay.classList.remove('show');
    await loadStudents();
    await loadRoomStatusBar();
  } catch (e) {
    console.error(e);
    showMessage('Failed to check out. Please try again.', false);
  }
}

// Mark a student as "Activity in Building" (Club Knights only)
async function markStudentActivityInBuilding(studentId) {
  try {
    const { error } = await supabase
      .from('master_roster')
      .update({ assigned_room: 'Activity in Building', is_gone: false, gone_at: null })
      .eq('id', Number(studentId));
    if (error) throw error;

    showMessage(`${window.selectedStudentName || 'Student'} is marked as Activity in Building.`, true);
    const overlay = document.getElementById('room-overlay');
    if (overlay) overlay.classList.remove('show');
    await loadStudents();
    await loadRoomStatusBar();
  } catch (e) {
    console.error(e);
    showMessage('Failed to set Activity in Building. Please try again.', false);
  }
}

function showMessage(text, isSuccess = true) {
  const msg = document.createElement('div');
  msg.textContent = text;
  msg.style.position = 'fixed';
  msg.style.top = '50%';
  msg.style.left = '50%';
  msg.style.transform = 'translate(-50%, -50%)';
  msg.style.backgroundColor = isSuccess ? '#d4edda' : '#f8d7da';
  msg.style.color = isSuccess ? '#155724' : '#721c24';
  msg.style.padding = '1rem 2rem';
  msg.style.borderRadius = '8px';
  msg.style.boxShadow = '0 2px 6px rgba(0,0,0,0.15)';
  msg.style.textAlign = 'center';
  msg.style.zIndex = '9999';
  msg.style.fontSize = '1.2rem';
  msg.style.opacity = '0';
  msg.style.transition = 'opacity 0.3s ease';
  document.body.appendChild(msg);
  setTimeout(() => { msg.style.opacity = '1'; }, 10);
  setTimeout(() => {
    msg.style.opacity = '0';
    setTimeout(() => { document.body.removeChild(msg); }, 300);
  }, 3000);
}

function renderDeviceInfoPanel() {
  const dialog = document.getElementById('device-info-dialog');
  if (!dialog) return;
  const n = document.getElementById('info-device-name');
  const k = document.getElementById('info-device-key');
  const fc = document.getElementById('info-filter-col');
  const fv = document.getElementById('info-filter-val');
  const ua = document.getElementById('info-updated-at');

  if (n) n.textContent = currentDevice?.name || 'Device';
  if (k) k.textContent = currentDevice?.key || '—';
  if (fc) fc.textContent = currentDevice?.column || '—';
  if (fv) fv.textContent = currentDevice?.value || '—';
  if (ua) ua.textContent = currentDevice?.updated_at ? new Date(currentDevice.updated_at).toLocaleString() : '—';
}

// Initialize in correct order: wait for device row first, then session times, then students, then status bar
(async () => {
  await ensureDeviceRow();
  updateSiteTitleFromDevice();
  await loadSessionTimes();
  bindSessionTimesRealtime();
  await loadStudents();
  await loadRoomStatusBar();
})();
// Enable polling for room status updates (e.g., every 5 seconds)
// This is a fallback because real-time replication for room tables is 'Coming Soon'
setInterval(loadRoomStatusBar, 5000); // Polls every 5 seconds (5000 milliseconds)

// Device info dialog wiring
(function setupDeviceInfoDialog(){
  const btn = document.getElementById('device-info-btn');
  const dlg = document.getElementById('device-info-dialog');
  const closeBtn = document.getElementById('device-info-close');
  const copyBtn = document.getElementById('copy-device-key');
  if (!btn || !dlg) return;
  btn.addEventListener('click', () => { renderDeviceInfoPanel(); dlg.classList.add('show'); });
  if (closeBtn) closeBtn.addEventListener('click', () => { dlg.classList.remove('show'); });
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(currentDevice?.key || ''); showMessage('Device key copied', true); }
    catch { showMessage('Copy failed', false); }
  });
  // click outside to close
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.classList.remove('show'); });
})();
