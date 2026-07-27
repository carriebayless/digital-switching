const DEBUG = false; // set true to re-enable console logs
if (DEBUG) console.log("find-students.js loaded at all!");
//push trigger 8/5 5:30 PM

// Initialize Supabase client (do NOT change your actual URL or key)
const supabaseUrl = "https://bhfgcmknhrilmevclmye.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJoZmdjbWtuaHJpbG1ldmNsbXllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTMyNzM2ODMsImV4cCI6MjA2ODg0OTY4M30.1jWsjTGwhrcHeQrLritZODyaEl98vWRmNq0_slSMEzk";

const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);

// --- Debounce and channel handle for realtime ---
let __fsRealtimeChannel = null;
let __fsDebounceTimer = null;
let __fsRenderSeq = 0; // prevents out-of-order render flashes

window.addEventListener('beforeunload', () => {
  try { if (__fsRealtimeChannel) supabaseClient.removeChannel(__fsRealtimeChannel); } catch {}
  try { if (window.__fsRealtimeChannel2) supabaseClient.removeChannel(window.__fsRealtimeChannel2); } catch {}
});
function fsDebounce(fn, wait = 150) {
  clearTimeout(__fsDebounceTimer);
  __fsDebounceTimer = setTimeout(fn, wait);
}
// --- Filter normalization helpers ---
function fsNormalizeColumnName(col) {
  if (!col) return null;
  const c = String(col).trim().toLowerCase();
  // Accept common variants/labels
  if (c === 'site') return 'site';
  if (c === 'summer_site' || c === 'summersite' || c === 'summer site') return 'summer_site';
  if (c === 'non_school_day' || c === 'nonschoolday' || c === 'non school day' || c === 'nsd') return 'non_school_day';
  return c; // fall through to whatever was provided
}
function fsNormalizeFilter(input) {
  // Input can be: {column, value} or a plain site string
  if (!input) return {};
  if (typeof input === 'string') {
    const s = input.replace(/^"|"$/g, '').trim();
    if (!s) return {};
    if (s.toLowerCase() === 'non-school day' || s.toLowerCase() === 'non school day') {
      return { column: 'non_school_day', value: true };
    }
    return { column: 'site', value: s };
  }
  if (typeof input === 'object' && input.column) {
    const col = fsNormalizeColumnName(input.column);
    let val = input.value;
    if (col === 'non_school_day') {
      val = (val === true || val === 'true' || String(val).toLowerCase() === '1');
    }
    return { column: col, value: val };
  }
  return {};
}
// --- End filter normalization helpers ---

// --- Roster realtime (scoped to current filter) ---
function fsCurrentFilter() {
  try {
    const raw = localStorage.getItem('studentListFilter');
    if (raw != null) {
      try {
        const obj = JSON.parse(raw);
        // Correctly handle the object if it's already in the right format
        if (obj && obj.column) {
          const norm = fsNormalizeFilter(obj);
          if (norm.column) return norm;
        }
      } catch {}
      // If it's a plain string, check for summer site and other values
      const s = raw.replace(/^"|"$/g, '').trim();
      if (!s) return {};
      if (s.toLowerCase() === 'non-school day' || s.toLowerCase() === 'non school day') {
        return { column: 'non_school_day', value: true };
      }
      // Check if the site is one of your known summer sites
      if (s === 'Kids Play' || s === 'Club Knights') {
        return { column: 'summer_site', value: s };
      }
      // Fallback to site if it's a normal site name
      return { column: 'site', value: s };
    }
    // Fallback keys used elsewhere
    const sitePlain = (localStorage.getItem('selectedSiteName') || localStorage.getItem('site') || '').trim();
    if (sitePlain) {
        if (sitePlain === 'Kids Play' || sitePlain === 'Club Knights') {
            return { column: 'summer_site', value: sitePlain };
        }
        return fsNormalizeFilter(sitePlain);
    }
  } catch {}
  return {};
}

function buildRosterFilterString(filterObj) {
  if (!filterObj || !filterObj.column) return null;
  const col = fsNormalizeColumnName(filterObj.column);
  let val = filterObj.value;
  if (col === 'non_school_day') {
    val = (val === true || val === 'true' || String(val).toLowerCase() === '1');
    return `${col}=eq.${val ? 'true' : 'false'}`;
  }
  // Escape commas in values (Realtime treats comma as OR separator)
  const safeVal = String(val).replace(/,/g, '\\,');
  return `${col}=eq.${safeVal}`;
}

function startRosterRealtime() {
  const filterObj = fsCurrentFilter();
  const normCol = fsNormalizeColumnName(filterObj.column);
  const filterStr = buildRosterFilterString(filterObj);
  if (DEBUG) console.log('[find-students] realtime filter:', filterObj, '->', filterStr);

  // Tear down old channels
  if (__fsRealtimeChannel) {
    try { supabaseClient.removeChannel(__fsRealtimeChannel); } catch {}
    __fsRealtimeChannel = null;
  }
  if (window.__fsRealtimeChannel2) {
    try { supabaseClient.removeChannel(window.__fsRealtimeChannel2); } catch {}
    window.__fsRealtimeChannel2 = null;
  }

  const base = { event: '*', schema: 'public', table: 'master_roster' };

  // Helper to create and subscribe a channel with given cfg
  const makeChannel = (cfg) => {
    const ch = supabaseClient.channel('find_students_roster_' + Math.random().toString(36).slice(2));
    return ch
     .on('postgres_changes', cfg, (payload) => {
       if (!applyStudentChange(payload)) {
         fsDebounce(() => { fetchData(); }, 120); // unexpected shape; fall back just this once
       }
     })
      .subscribe();
  };

  // If using a plain site label, subscribe to both site and summer_site filters
  if (normCol === 'site' && filterObj.value) {
    const safeVal = String(filterObj.value).replace(/,/g, '\\,');
    const cfgSite = { ...base, filter: `site=eq.${safeVal}` };
    const cfgSummer = { ...base, filter: `summer_site=eq.${safeVal}` };
    __fsRealtimeChannel = makeChannel(cfgSite);
    window.__fsRealtimeChannel2 = makeChannel(cfgSummer);
    return;
  }

  // Default: single filtered or unfiltered channel
  const cfg = filterStr ? { ...base, filter: filterStr } : base;
  __fsRealtimeChannel = makeChannel(cfg);
}

// --- FILTERED STUDENT LIST SUPPORT ---
async function fetchFilteredStudents() {
  const rawFilter = fsCurrentFilter();
  const filter = fsNormalizeFilter(rawFilter);

   let query = supabaseClient.from('master_roster')
     .select('id, firstname, lastname, grade, assigned_room')
     .order('grade', { ascending: true });
  if (filter.column && filter.value !== undefined && filter.value !== null && filter.value !== '') {
    const col = fsNormalizeColumnName(filter.column);
    if (col === 'non_school_day') {
      const boolVal = (filter.value === true || filter.value === 'true' || String(filter.value).toLowerCase() === '1');
      if (DEBUG) console.log('Applying filter:', col, boolVal);
      query = query.eq(col, boolVal);
    } else if (col === 'site') {
      // Allow site lists to also pull from summer_site when the label matches (e.g., "Kids Play")
      const safeVal = String(filter.value).replace(/,/g, '\\,');
      if (DEBUG) console.log('Applying filter (site OR summer_site):', safeVal);
      query = query.or(`site.eq.${safeVal},summer_site.eq.${safeVal}`);
    } else {
      if (DEBUG) console.log('Applying filter:', col, filter.value);
      query = query.eq(col, filter.value);
    }
  }
  // If no filter, return all students
  const { data: students, error } = await query;
  if (error) {
    console.error("Error fetching students:", error.message);
    return [];
  }
  if (DEBUG) console.log("Filtered students returned:", students);
  return students || [];
}
// --- END FILTERED STUDENT LIST SUPPORT ---

// Mapping for displaying simplified room names (Added in previous discussion)
const roomDisplayNameMap = {
  "Activity in Building": "Activity",
  "Hallway (Atrium)": "Hallway",
  "Gone": "Gone"
};

// ---- Sorting helpers (K first; then 1..7; then Unknown) ----
function normalizeGrade(g) {
  if (g === null || g === undefined) return 'Unknown';
  const s = String(g).trim();
  if (!s) return 'Unknown';
  if (s.toUpperCase() === 'K') return 'K';
  return s; // '1'..'7' or any other label
}
function gradeWeightKey(gradeKey) {
  if (gradeKey === 'K') return 0; // K first
  const n = parseInt(gradeKey, 10);
  if (!Number.isNaN(n)) return n; // 1..7 naturally
  return 999; // Unknown or other labels last
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

// ===== Room style cache (per site) =====
let __fsRoomStyles = new Map(); // room_name -> { bg, color, icon }
let __fsRoomSite = null;
let __fsRoomsRealtime = null; // for rooms realtime subscription

function fsGetActiveSite() {
  try {
    const raw = localStorage.getItem('studentListFilter');
    if (raw != null) {
      try {
        const f = fsNormalizeFilter(JSON.parse(raw));
        if (f && f.column) {
          if (f.column === 'site' && f.value) return f.value;
          if (f.column === 'summer_site' && f.value) return f.value;
          if (f.column === 'non_school_day') return 'Non-School Day';
        }
      } catch {}
      const s = fsNormalizeFilter(raw);
      if (s && s.column) {
        if (s.column === 'site' || s.column === 'summer_site') return s.value;
        if (s.column === 'non_school_day') return 'Non-School Day';
      }
    }
    const sitePlain = (localStorage.getItem('selectedSiteName') || localStorage.getItem('site') || '').trim();
    if (sitePlain) return sitePlain;
  } catch {}
  return null;
}
function normalizeHex(hex) {
  if (!hex) return '';
  let h = String(hex).trim();
  if (h && h[0] !== '#') h = '#' + h;
  if (/^#[0-9a-fA-F]{3}$/.test(h)) h = '#' + h.slice(1).split('').map(c => c + c).join('');
  return /^#[0-9a-fA-F]{6}$/.test(h) ? h.toLowerCase() : '';
}
function textFor(bg) {
  try {
    const c = bg.replace('#','');
    const r = parseInt(c.slice(0,2),16), g = parseInt(c.slice(2,4),16), b = parseInt(c.slice(4,6),16);
    const lum = 0.299*r + 0.587*g + 0.114*b;
    return lum < 140 ? '#fff' : '#000';
  } catch { return '#000'; }
}
function styleForRoom(name) {
  const s = __fsRoomStyles.get(name);
  if (s) return s;
  return { bg: '#f0f0f0', color: '#000', icon: '' }; // fallback
}
async function fsLoadRoomStylesForSite(site) {
  if (!site) {
    __fsRoomStyles.clear();
    __fsRoomSite = null;
    return;
  }
  if (__fsRoomSite === site && __fsRoomStyles.size > 0) return; // already loaded

  const { data: rows, error } = await supabaseClient
    .from('rooms')
    .select('room_name, color_hex, icon_emoji')
    .eq('site', site);

  __fsRoomStyles.clear();
  __fsRoomSite = site;

  if (!error && Array.isArray(rows)) {
    rows.forEach(r => {
      const bg = normalizeHex(r.color_hex) || '#f0f0f0';
      const color = bg === '#f0f0f0' ? '#000' : textFor(bg);
      const icon = (r.icon_emoji || '').trim();
      __fsRoomStyles.set(r.room_name, { bg, color, icon });
    });
  }
}

// --- Rooms realtime subscription ---
function fsStartRoomsRealtime() {
  const site = fsGetActiveSite();
  // Tear down any existing channel
  if (__fsRoomsRealtime) {
    try { supabaseClient.removeChannel(__fsRoomsRealtime); } catch {}
    __fsRoomsRealtime = null;
  }
  if (!site) return;

  const ch = supabaseClient.channel('find_students_rooms');
  __fsRoomsRealtime = ch
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `site=eq.${site}` }, async () => {
      // Reload style cache and re-render when room color/icon changes
      await fsLoadRoomStylesForSite(site);
      selectedStudentIds.clear(); // selections from the previous list no longer apply
      renderRooms(assignments, currentRoomOrder);
      // If the assign overlay is open, rebuild its buttons to reflect new styles
      const overlay = document.getElementById('assign-overlay');
      if (overlay && overlay.style.display !== 'none') {
        const container = document.getElementById('assign-room-buttons');
        if (container) {
          await buildAssignButtons(container);
        }
      }
    })
    .subscribe();
}

// Compute a stable room order from current assignments (alpha by name)
function computeRoomOrderFrom(assignments) {
  const names = Array.from(new Set(assignments.map(a => a.assigned_room).filter(Boolean)));
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

 // Same classification rules fetchData already used — pulled out so the
 // delta-update path below can reuse them exactly instead of duplicating them.
 function isAssignedRoomValue(room) {
   return room !== null && room !== "" && room !== "None";
 }
 function isUnassignedRoomValue(room) {
   const r = (room || "").toString().trim().toLowerCase();
   return r === "" || r === "none" || r === "-" || r === "null";
 }
 function sortUnassigned(list) {
   return list.slice().sort((a, b) => {
     const gradeA = a.grade ? a.grade.toString() : '';
     const gradeB = b.grade ? b.grade.toString() : '';
     const cmpGrade = gradeA.localeCompare(gradeB, undefined, { numeric: true });
     if (cmpGrade !== 0) return cmpGrade;
     const nameA = (a.student_name || [a.firstname, a.lastname].filter(Boolean).join(" ")).toLowerCase();
     const nameB = (b.student_name || [b.firstname, b.lastname].filter(Boolean).join(" ")).toLowerCase();
     return nameA.localeCompare(nameB);
   });
 }


async function fetchData() {
  const mySeq = ++__fsRenderSeq;
  const students = await fetchFilteredStudents();
  if (DEBUG) console.log("DEBUG: assigned_room values:");
  students.forEach((s, i) => {
    if (DEBUG) console.log(`Student ${i}:`, s.id, "-", s.student_name || `${s.firstname} ${s.lastname}`, "| assigned_room:", JSON.stringify(s.assigned_room));
  });
  if (DEBUG) console.log("DEBUG: Total students fetched in fetchData:", students.length);

  if (mySeq !== __fsRenderSeq) return; // a realtime update already moved things forward; don't overwrite it with a stale fetch
   assignments = students.filter(s => isAssignedRoomValue(s.assigned_room));
   const roomOrder = computeRoomOrderFrom(assignments);
   currentRoomOrder = roomOrder;
   unassignedList = sortUnassigned(students.filter(s => isUnassignedRoomValue(s.assigned_room)));


  if (DEBUG) console.log("DEBUG: assignments array:", assignments);
  if (DEBUG) console.log("DEBUG: unassignedList array:", unassignedList);

  renderRooms(assignments, roomOrder);
  renderUnassigned(unassignedList);
}

 // Applies one master_roster change directly to the in-memory lists — no
 // new database call for routine room/gone changes. Returns false only if
 // the payload shape is unexpected, so the caller can fall back safely.
 function applyStudentChange(payload) {
   const oldRow = payload.old || {};
   const newRow = payload.new || {};
   const id = newRow.id ?? oldRow.id;
   if (id == null) return false;

   __fsRenderSeq++; // mark that state has moved forward, so any in-flight fetchData() knows to stand down

   // Remove any existing copy of this student from both lists first
   assignments = assignments.filter(s => s.id !== id);
   unassignedList = unassignedList.filter(s => s.id !== id);

   if (payload.eventType !== 'DELETE') {
     const student = {
       id: newRow.id,
       firstname: newRow.firstname,
       lastname: newRow.lastname,
       grade: newRow.grade,
       assigned_room: newRow.assigned_room
     };
     if (isAssignedRoomValue(student.assigned_room)) {
       assignments.push(student);
     } else if (isUnassignedRoomValue(student.assigned_room)) {
       unassignedList.push(student);
     }
   }

   unassignedList = sortUnassigned(unassignedList);
   currentRoomOrder = computeRoomOrderFrom(assignments);
   renderRooms(assignments, currentRoomOrder);
   renderUnassigned(unassignedList);
   return true;
 }


// Render room blocks with student lists
function renderRooms(assignments, roomOrder = []) {
  if (DEBUG) console.log("DEBUG: renderRooms input:", assignments);
  const roomsContainer = document.getElementById("rooms-container");
  if (roomsContainer) roomsContainer.innerHTML = ""; // always clear old DOM first
  if (!assignments || assignments.length === 0) {
    if (DEBUG) console.log("No assigned students to render.");
    return; // nothing to render (container has been cleared)
  }
  // Group by room
  const roomMap = new Map();
  // Always use all assignments for grouping
  assignments.forEach(s => {
    const room = s.assigned_room;
    if (!roomMap.has(room)) roomMap.set(room, []);
    roomMap.get(room).push(s);
  });
  // Determine room order from provided order or alpha
    const effectiveOrder = (roomOrder && roomOrder.length)
      ? roomOrder
      : Array.from(roomMap.keys()).sort();

    effectiveOrder.forEach(roomName => {
    const studentsInRoom = (roomMap.get(roomName) || []).slice().sort(compareFirstLast);
    if (studentsInRoom.length > 0) {
      // Build room block (same code as before, but using roomName and studentsInRoom)
      const roomBlock = document.createElement("div");
      roomBlock.className = "room-block";

      const displayRoomName = roomDisplayNameMap[roomName] || roomName;
      const st = styleForRoom(roomName);

      const pill = document.createElement('div');
      pill.className = 'room-pill';
      pill.style.backgroundColor = st.bg;
      pill.style.color = st.color;

      const iconSpan = document.createElement('span');
      iconSpan.textContent = st.icon || '';
      iconSpan.style.fontSize = '1.05rem';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${displayRoomName}: ${studentsInRoom.length}`;

      pill.appendChild(iconSpan);
      pill.appendChild(nameSpan);

      const header = document.createElement('h3');
      header.style.margin = '0 0 0.5rem';
      header.style.fontSize = '1.1rem';
      header.appendChild(pill);

      roomBlock.appendChild(header);

      const ul = document.createElement("ul");
      ul.style.listStyle = "none";
      ul.style.padding = "0";
      ul.style.margin = "0";
      studentsInRoom.forEach(s => {
        const li = document.createElement("li");
        li.style.margin = "0.25rem 0";
        li.style.fontSize = "1.1rem"; // Adjusted font size for assigned student names

        // Checkbox (if in selection mode)
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "student-checkbox";
        checkbox.dataset.id = s.id;
        checkbox.checked = selectedStudentIds.has(s.id);
        if (!selectionMode) checkbox.classList.add('hidden'); else checkbox.classList.remove('hidden');
        checkbox.style.marginRight = "0.5rem";
        li.appendChild(checkbox);
        // Modern checkbox sizing and accent color
        checkbox.style.width = "20px";
        checkbox.style.height = "20px";
        checkbox.style.accentColor = "#2196F3";
        checkbox.style.cursor = "pointer";

        // Highlight entire student name if it matches the search term
        let name = s.student_name || [s.firstname, s.lastname].filter(Boolean).join(" ");
        if (!name || !name.trim()) name = "(No Name)";
        let displayName = name;
        if (currentSearchTerm && name.toLowerCase().includes(currentSearchTerm)) {
          displayName = `<span class="highlight">${name}</span>`;
        }
        li.insertAdjacentHTML("beforeend", displayName);
        ul.appendChild(li);
      });
      roomBlock.appendChild(ul);

      roomsContainer.appendChild(roomBlock);
    }
  });
}

// Assignment overlay helpers
function showAssignOverlay() {
 const overlay = document.getElementById('assign-overlay');
 overlay.style.display = 'flex';
 overlay.style.opacity = '0';
 setTimeout(() => overlay.style.opacity = '1', 10);
}
function hideAssignOverlay() {
 const overlay = document.getElementById('assign-overlay');
 overlay.style.opacity = '0';
 setTimeout(() => overlay.style.display = 'none', 200);
}

let selectionMode = false;
 // Tracks which student IDs are checked, independent of the checkboxes
 // themselves — so a re-render (from anyone else's change) doesn't wipe
 // out a coordinator's in-progress selection.
 let selectedStudentIds = new Set();
let assignments = [];
let unassignedList = [];
let currentSearchTerm = "";
let currentRoomOrder = [];

function escapeRegex(str) {
 return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

async function buildAssignButtons(assignButtonsContainer) {
  const activeSite = fsGetActiveSite();
  await fsLoadRoomStylesForSite(activeSite); // ensure cache is warm
  assignButtonsContainer.innerHTML = '';

  const allNames = Array.from(__fsRoomStyles.keys()).sort((a,b)=>a.localeCompare(b));
  // Fallback: if no styles loaded for this filter/site, derive list from the rooms visible on the page
  let roomNames = allNames;
  if (!roomNames.length) {
    // Use the rooms present in the current render (from currentRoomOrder / assignments)
    if (Array.isArray(currentRoomOrder) && currentRoomOrder.length) {
      roomNames = currentRoomOrder.slice();
    } else if (Array.isArray(assignments) && assignments.length) {
      roomNames = computeRoomOrderFrom(assignments);
    } else {
      roomNames = [];
    }
  }
  roomNames.forEach(roomName => {
    const st = styleForRoom(roomName);
    const btn = document.createElement('button');
    btn.classList.remove('nav-button');
    btn.classList.add('room-choice-btn');
    btn.style.backgroundColor = st.bg;
    btn.style.color = st.color;

    const displayRoomNameBtn = roomDisplayNameMap[roomName] || roomName;
    btn.textContent = st.icon ? `${st.icon} ${displayRoomNameBtn}` : displayRoomNameBtn;

    btn.addEventListener('click', async () => {
      const selectedCheckboxes = Array.from(document.querySelectorAll('.student-checkbox:checked'));
      const ids = selectedCheckboxes.map(cb => parseInt(cb.dataset.id));
      const { error } = await supabaseClient
        .from('master_roster')
        .update({ assigned_room: roomName, is_gone: false, gone_at: null })
        .in('id', ids);
      if (error) {
        alert('Error assigning room: ' + error.message);
      } else {
        await fetchData();
        selectedCheckboxes.forEach(cb => cb.checked = false);
        hideAssignOverlay();
        selectionMode = false;
        const toggleSelectBtn = document.getElementById('toggle-select-button');
        if (toggleSelectBtn) toggleSelectBtn.textContent = 'Select Students';
        document.querySelectorAll('.student-checkbox').forEach(cb => {
          cb.classList.add('hidden');
          cb.checked = false;
        });
        const assignRoomBtn = document.getElementById('assign-room-button');
        if (assignRoomBtn) assignRoomBtn.style.display = 'none';
      }
    });

    assignButtonsContainer.appendChild(btn);
  });

  // Append a consistent "Gone" option at the end
  const goneBtn = document.createElement('button');
  goneBtn.classList.add('room-choice-btn');
  goneBtn.style.backgroundColor = '#d9d9d9';
  goneBtn.style.color = '#000';
  goneBtn.textContent = '🚪 Gone';

  goneBtn.addEventListener('click', async () => {
    const selectedCheckboxes = Array.from(document.querySelectorAll('.student-checkbox:checked'));
    const ids = selectedCheckboxes.map(cb => parseInt(cb.dataset.id));
    const { error } = await supabaseClient
      .from('master_roster')
      .update({ is_gone: true, gone_at: new Date().toISOString(), assigned_room: null })
      .in('id', ids);
    if (error) {
      alert('Error marking gone: ' + error.message);
    } else {
      await fetchData();
      selectedCheckboxes.forEach(cb => cb.checked = false);
      hideAssignOverlay();
      selectionMode = false;
      const toggleSelectBtn = document.getElementById('toggle-select-button');
      if (toggleSelectBtn) toggleSelectBtn.textContent = 'Select Students';
      document.querySelectorAll('.student-checkbox').forEach(cb => {
        cb.classList.add('hidden');
        cb.checked = false;
      });
      const assignRoomBtn = document.getElementById('assign-room-button');
      if (assignRoomBtn) assignRoomBtn.style.display = 'none';
    }
  });

  assignButtonsContainer.appendChild(goneBtn);
}

document.addEventListener("DOMContentLoaded", async () => {
  if (DEBUG) console.log('[find-students] initial normalized filter:', fsCurrentFilter());
  // Correctly get all button elements here
  const toggleSelectBtn = document.getElementById("toggle-select-button");
  const assignRoomBtn = document.getElementById("assign-room-button");
  const clearAllBtn = document.getElementById("clear-assignments-button");
 

  // Apply specific colors as before (Clear All and Assign Room)
  if (assignRoomBtn) {
    assignRoomBtn.style.backgroundColor = '#4CAF50';
    assignRoomBtn.style.color = '#fff';
  }
  if (clearAllBtn) {
    clearAllBtn.style.backgroundColor = '#e53935';
    clearAllBtn.style.color = '#fff';
  }

  // --- Start of existing code for search and rooms container ---
  const searchInput = document.getElementById("search-input");
  const roomsContainer = document.getElementById("rooms-container");


  // Highlight on search input
  searchInput.addEventListener("input", e => {
    currentSearchTerm = e.target.value.trim().toLowerCase();
    renderRooms(assignments);       // highlight in assigned rooms
    renderUnassigned(unassignedList); // highlight in unassigned list
  });

  const activeSiteForStyles = fsGetActiveSite();
  await fsLoadRoomStylesForSite(activeSiteForStyles);

  // Initial load: fetch rooms first, then students
  await fetchData(); // This calls renderRooms and renderUnassigned
  // Create/refresh the current filter badge (styled via CSS)
  function ensureFilterBadge() {
    let badge = document.getElementById('fs-filter-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'fs-filter-badge';
      badge.className = 'filter-badge';
      document.body.appendChild(badge);
    }
    const f = fsCurrentFilter();
    let label = '';
    if (f.column === 'non_school_day') label = 'Non-School Day';
    else if (f.column === 'summer_site') label = `Summer: ${f.value}`;
    else if (f.column === 'site') label = `Site: ${f.value}`;
    else label = 'All Students';
    badge.textContent = label;
  }
  ensureFilterBadge();
  // Start realtime for master_roster, scoped to the active filter
  startRosterRealtime();
  // Start realtime for rooms table (styles/icons)
  fsStartRoomsRealtime();
  // Refresh the badge after realtime is bound (covers fast filter changes)
  ensureFilterBadge();

  // Responsive controls container
  const controlsContainer = document.getElementById("toggle-select-button").parentElement;
  controlsContainer.style.display = "flex";
  controlsContainer.style.justifyContent = "center";
  controlsContainer.style.flexWrap = "wrap";
  controlsContainer.style.gap = "0.5rem";

  function syncSelectionFromCheckbox(cb) {
    const id = parseInt(cb.dataset.id, 10);
    if (cb.checked) selectedStudentIds.add(id); else selectedStudentIds.delete(id);
  }


  // Click-to-toggle selection on list items (no select-all button)
  const unassignedContainer = document.getElementById('unassigned-list');
  if (unassignedContainer) {
    unassignedContainer.addEventListener('click', (e) => {
      if (!selectionMode) return;
      const li = e.target.closest('.student-item');
      if (!li) return;
      const cb = li.querySelector('.student-checkbox');
      if (!cb) return;
      if (e.target !== cb) cb.checked = !cb.checked;
      syncSelectionFromCheckbox(cb);
    });
  }
  const roomsListContainer = document.getElementById('rooms-container');
  if (roomsListContainer) {
    roomsListContainer.addEventListener('click', (e) => {
      if (!selectionMode) return;
      const li = e.target.closest('li');
      if (!li) return;
      const cb = li.querySelector('.student-checkbox');
      if (!cb) return;
      if (e.target !== cb) cb.checked = !cb.checked;
      syncSelectionFromCheckbox(cb);
    });
  }


  // Overlay setup for full-screen responsive display
  const assignOverlay = document.getElementById('assign-overlay');
  assignOverlay.style.display = 'none';
  assignOverlay.style.position = 'fixed';
  assignOverlay.style.top = '0';
  assignOverlay.style.left = '0';
  assignOverlay.style.width = '100vw';
  assignOverlay.style.height = '100vh';
  assignOverlay.style.backgroundColor = 'rgba(255,255,255,0.95)';
  assignOverlay.style.alignItems = 'center';
  assignOverlay.style.justifyContent = 'center';
  assignOverlay.style.flexDirection = 'column';
  assignOverlay.style.zIndex = '1000';
  assignOverlay.style.transition = 'opacity 0.3s ease';

  // Modal styling
  const assignModal = document.getElementById('assign-room-selection');
  assignModal.style.background = '#fff';
  assignModal.style.border = '3px solid #ffb300';
  assignModal.style.borderRadius = '12px';
  assignModal.style.padding = '1rem';
  assignModal.style.maxWidth = '500px';
  assignModal.style.width = '90%';
  assignModal.style.boxSizing = 'border-box';
  assignModal.style.boxShadow = '0 4px 8px rgba(0,0,0,0.2)';
  assignModal.style.textAlign = 'center';

  // Container for room buttons (responsive grid)
  const assignButtonsContainer = document.getElementById('assign-room-buttons');
  assignButtonsContainer.style.display = 'grid';
  assignButtonsContainer.style.gridTemplateColumns = 'repeat(auto-fit, minmax(140px, 1fr))';
  assignButtonsContainer.style.gridAutoRows = 'auto';
  assignButtonsContainer.style.width = '100%';
  assignButtonsContainer.style.boxSizing = 'border-box';
  assignButtonsContainer.style.gap = '0.5rem';

  // Cancel button styling
  const cancelOverlayBtn = document.getElementById('assign-overlay-cancel');
  cancelOverlayBtn.style.display = 'block';
  cancelOverlayBtn.style.width = '100%';
  cancelOverlayBtn.style.boxSizing = 'border-box';
  cancelOverlayBtn.style.marginTop = '1rem';
  cancelOverlayBtn.style.border = '2px solid #b71c1c';
  cancelOverlayBtn.style.backgroundColor = '#ffe6e6';
  cancelOverlayBtn.style.color = '#b71c1c';
  cancelOverlayBtn.style.borderRadius = '12px';
  cancelOverlayBtn.style.fontWeight = 'bold';
  cancelOverlayBtn.style.cursor = 'pointer';

  
  // Hide assign-room-button until selection mode is active
  if (assignRoomBtn) {
    assignRoomBtn.style.display = "none";
  }


  // Toggle selection mode for checkboxes
if (toggleSelectBtn) {
  toggleSelectBtn.addEventListener("click", () => {
    selectionMode = !selectionMode;
    if (!selectionMode) selectedStudentIds.clear();
    document.querySelectorAll('.student-checkbox').forEach(cb => {
      cb.classList.toggle('hidden', !selectionMode);
      if (!selectionMode) cb.checked = false;
    });
    toggleSelectBtn.textContent = selectionMode ? 'Cancel Selection' : 'Select Students';
    if (assignRoomBtn) assignRoomBtn.style.display = selectionMode ? 'inline-block' : 'none';
  });
}

  // Add event listener for overlay cancel button
  const assignOverlayCancelBtn = document.getElementById('assign-overlay-cancel');
  if (assignOverlayCancelBtn) {
    assignOverlayCancelBtn.addEventListener('click', hideAssignOverlay);
  }

  // Show room-selection overlay on Assign Room click
  if (assignRoomBtn) {
    assignRoomBtn.addEventListener('click', async () => {
      if (!selectionMode) {
        alert('Please click "Select Students" first.');
        return;
      }
      const selectedCheckboxes = Array.from(document.querySelectorAll('.student-checkbox:checked'));
      if (selectedCheckboxes.length === 0) {
        alert('Please select at least one student.');
        return;
      }
      await buildAssignButtons(assignButtonsContainer);

      showAssignOverlay();
    });
  }

  // Clear all assignments button handler (scoped to current site selection)
  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", async () => {
      if (!confirm("Clear room assignments for the CURRENT list only?")) return;

      // Determine current filter (site / summer_site / non_school_day)
      const filterObj = fsCurrentFilter();
      if (!filterObj || !filterObj.column) {
        alert("Please choose a Student List (site) first.");
        return;
      }
      let filterValue = filterObj.value;
      if (filterObj.column === 'non_school_day') {
        filterValue = (filterValue === true || filterValue === 'true');
      }

      // Pause realtime to avoid a stale interleaved render
      if (__fsRealtimeChannel) {
        try { supabaseClient.removeChannel(__fsRealtimeChannel); } catch {}
        __fsRealtimeChannel = null;
      }

      // Build scoped update (IS NOT NULL + site OR summer_site support)
      const baseUpd = supabaseClient
        .from('master_roster')
        .update({ assigned_room: null })
        .not('assigned_room', 'is', null)   // assigned_room IS NOT NULL
        .neq('assigned_room', 'Gone')
        .neq('assigned_room', 'Activity in Building');

      const normCol = fsNormalizeColumnName(filterObj.column);
      let upd;
      if (normCol === 'site') {
        upd = baseUpd.eq('site', filterValue);
      } else if (normCol === 'non_school_day') {
        const boolVal = (filterValue === true || filterValue === 'true' || String(filterValue).toLowerCase() === '1');
        upd = baseUpd.eq('non_school_day', boolVal);
      } else {
        upd = baseUpd.eq(normCol, filterValue);
      }

      const { data, error } = await upd.select('id');

      if (error) {
        alert("Error clearing assignments: " + error.message);
      } else {
        await fetchData(); // single authoritative render
        alert(`Cleared assignments for ${Array.isArray(data) ? data.length : 0} student(s) in this list.`);
      }

      // Re-subscribe after mutation completes
      startRosterRealtime();
    });
  }

}); // End of DOMContentLoaded listener

// ---- Friendly grade titles ----
function fsOrdinalNum(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  const v = num % 100;
  const suf = (v >= 11 && v <= 13) ? 'th' : (num % 10 === 1 ? 'st' : num % 10 === 2 ? 'nd' : num % 10 === 3 ? 'rd' : 'th');
  return `${num}${suf}`;
}
function fsGradeTitle(gradeKey, count) {
  if (gradeKey === 'K') return count === 1 ? 'Kindergartner' : 'Kindergartners';
  if (gradeKey === 'Unknown') return count === 1 ? 'Unknown Grade' : 'Unknown Grades';
  const num = parseInt(gradeKey, 10);
  if (!Number.isNaN(num)) {
    const ord = fsOrdinalNum(num); // e.g., 4 -> "4th"
    const suffix = count === 1 ? 'Grader' : 'Graders';
    return `${ord} ${suffix}`;
  }
  // fallback
  return gradeKey;
}

// Render unassigned students, grouped by grade (clean version)
function renderUnassigned(list) {
  const container = document.getElementById('unassigned-list');
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(list) || list.length === 0) return;

  // Compute grade order K,1..7,Unknown
  const grades = Array.from(new Set(list.map(s => normalizeGrade(s.grade))))
    .sort((a, b) => gradeWeightKey(a) - gradeWeightKey(b));

  grades.forEach(grade => {
    const section = document.createElement('section');
    section.className = 'grade-section';

    // Build the group for this grade first so we can pluralize
    const group = list
      .filter(s => normalizeGrade(s.grade) === grade)
      .sort(compareFirstLast);

    const title = fsGradeTitle(grade, group.length);
    const h = document.createElement('h3');
    h.className = 'grade-title';
    h.textContent = title;
    section.appendChild(h);

    const ul = document.createElement('ul');
    ul.className = 'name-grid';

    group.forEach(s => {
      const li = document.createElement('li');
      li.className = 'student-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'student-checkbox';
      cb.dataset.id = s.id;
      cb.checked = selectedStudentIds.has(s.id);
      if (!selectionMode) cb.classList.add('hidden'); // only visible in selection mode
      li.appendChild(cb);

      let name = s.student_name || [s.firstname, s.lastname].filter(Boolean).join(' ');
      if (!name || !name.trim()) name = '(No Name)';
      const match = currentSearchTerm && name.toLowerCase().includes(currentSearchTerm);
      li.insertAdjacentHTML('beforeend', match ? `<span class="highlight">${name}</span>` : name);

      ul.appendChild(li);
    });

    section.appendChild(ul);
    container.appendChild(section);
  });
}

window.addEventListener('storage', async function(e) {
  if (e.key === 'studentListFilter' || e.key === 'selectedSiteName' || e.key === 'site') {
    await fsLoadRoomStylesForSite(fsGetActiveSite());
    fetchData();
    startRosterRealtime();
    fsStartRoomsRealtime();
    ensureFilterBadge();
  }
});

