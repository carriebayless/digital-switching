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
     .select('id, firstname, lastname, grade, assigned_room, assigned_at')
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
       assigned_room: newRow.assigned_room,
       assigned_at: newRow.assigned_at
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
    const sortFn = roomSortMode === "fifo" ? compareByAssignedAt : compareFirstLast;
    const studentsInRoom = (roomMap.get(roomName) || []).slice().sort(sortFn);
    if (studentsInRoom.length > 0) {
      // Build room block (same code as before, but using roomName and studentsInRoom)
      const roomBlock = document.createElement("div");
      roomBlock.className = "room-block";

      const displayRoomName = roomDisplayNameMap[roomName] || roomName;
      const st = styleForRoom(roomName);

      const banner = document.createElement('div');
      banner.className = 'room-block__banner';
      banner.style.backgroundColor = st.bg;
      banner.style.color = st.color;

      const iconSpan = document.createElement('span');
      iconSpan.textContent = st.icon || '';
      iconSpan.style.fontSize = '1.15rem';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${displayRoomName}: ${studentsInRoom.length}`;

      banner.appendChild(iconSpan);
      banner.appendChild(nameSpan);
      roomBlock.appendChild(banner);

      const body = document.createElement('div');
      body.className = 'room-block__body';

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
      body.appendChild(ul);
      roomBlock.appendChild(body);

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
let roomSortMode = "alpha"; // "alpha" or "fifo" — toggled by the sort button

// FIFO comparator: earliest assigned_at first. Students with no assigned_at
// (assigned before this column existed, and never moved since) are treated
// as the oldest and sort to the top.
function compareByAssignedAt(a, b) {
  const at = a.assigned_at ? new Date(a.assigned_at).getTime() : -Infinity;
  const bt = b.assigned_at ? new Date(b.assigned_at).getTime() : -Infinity;
  return at - bt;
}

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
      const activeSite = fsGetActiveSite();
      const { data, error } = await supabaseClient.rpc('assign_students_to_room_batch', {
        p_student_ids: ids,
        p_site: activeSite,
        p_room_name: roomName
      });
      if (error) {
        alert('Error assigning room: ' + error.message);
      } else if (data === 'room_not_found') {
        alert('That room is unavailable right now.');
      } else if (data !== 'success') {
        alert('Unable to assign right now. Please try again.');
      } else {
        selectedStudentIds.clear(); // must clear before fetchData() re-renders, or boxes reload checked
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
    const activeSite = fsGetActiveSite();
    const { data, error } = await supabaseClient.rpc('mark_students_gone_batch', {
      p_student_ids: ids,
      p_site: activeSite
    });
    if (error) {
      alert('Error marking gone: ' + error.message);
    } else if (data !== 'success') {
      alert('Unable to mark students gone right now. Please try again.');
    } else {
      selectedStudentIds.clear(); // must clear before fetchData() re-renders, or boxes reload checked
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

// ===================== Restrictions =====================
let restrictionEntries = [];
let restrictionsRealtimeChannel = null;
let editingRestrictionId = null; // null = creating new; set = editing that row

function toTimeInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatExpiredAgo(expiresAt) {
  const diffMs = Date.now() - new Date(expiresAt).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'expired just now';
  if (mins < 60) return `expired ${mins} min ago`;
  return `expired ${Math.floor(mins / 60)}h ago`;
}

function getAllKnownStudents() {
  return [...assignments, ...unassignedList];
}

function computeRestrictionExpiry(durationValue) {
  const now = new Date();
  if (durationValue === '15min') return new Date(now.getTime() + 15 * 60000);
  if (durationValue === '30min') return new Date(now.getTime() + 30 * 60000);
  if (durationValue === 'rest_of_day') {
    const d = new Date(now);
    d.setHours(23, 59, 59, 999);
    return d;
  }
  if (durationValue === 'rest_of_week') {
    const d = new Date(now);
    const day = d.getDay(); // 0=Sun..6=Sat
    const daysUntilFriday = (5 - day + 7) % 7;
    d.setDate(d.getDate() + daysUntilFriday);
    d.setHours(23, 59, 59, 999);
    return d;
  }
  if (durationValue === 'specific_time') {
    const raw = document.getElementById('restriction-specific-time')?.value; // "HH:MM"
    if (raw) {
      const [hh, mm] = raw.split(':').map(Number);
      const d = new Date(now);
      d.setHours(hh, mm, 0, 0);
      return d; // always today — no date to pick, matches how it's requested
    }
  }
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d;
}

function formatRestrictionExpiry(expiresAt) {
  const d = new Date(expiresAt);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `until ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return `until ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function buildRestrictionRoomPill(roomName) {
  const st = styleForRoom(roomName);
  const pill = document.createElement('span');
  pill.className = 'room-pill';
  pill.style.backgroundColor = st.bg;
  pill.style.color = st.color;
  pill.style.margin = '0 0.25em';
  pill.textContent = st.icon ? `${st.icon} ${roomName}` : roomName;
  return pill;
}

function populateStudentSelect(selectEl, excludeId) {
  const students = getAllKnownStudents()
    .filter(s => excludeId == null || s.id !== excludeId)
    .slice()
    .sort(compareFirstLast);
  selectEl.innerHTML = '<option value="">— Select —</option>';
  students.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.student_name || `${s.firstname} ${s.lastname}`;
    selectEl.appendChild(opt);
  });
}

function populateRoomCheckboxes() {
  const container = document.getElementById('restriction-room-checkboxes');
  if (!container) return;
  container.innerHTML = '';
  const roomNames = Array.from(__fsRoomStyles.keys()).sort((a, b) => a.localeCompare(b));
  roomNames.forEach(name => {
    const label = document.createElement('label');
    label.style.display = 'inline-flex';
    label.style.alignItems = 'center';
    label.style.gap = '0.3em';
    label.style.border = '1px solid var(--border)';
    label.style.borderRadius = '8px';
    label.style.padding = '0.3rem 0.6rem';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = name;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(name));
    container.appendChild(label);
  });
}

function populateEditRoomSelect(selectedRoomName) {
  const select = document.getElementById('restriction-edit-room-select');
  if (!select) return;
  const roomNames = Array.from(__fsRoomStyles.keys()).sort((a, b) => a.localeCompare(b));
  select.innerHTML = '';
  roomNames.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
  if (selectedRoomName) select.value = selectedRoomName;
}

async function openRestrictionOverlay(editEntry) {
  const activeSite = fsGetActiveSite();
  await fsLoadRoomStylesForSite(activeSite);

  editingRestrictionId = editEntry ? editEntry.id : null;

  const titleEl = document.getElementById('restriction-modal-title');
  const saveBtn = document.getElementById('restriction-save-btn');
  if (titleEl) titleEl.textContent = editEntry ? 'Edit Restriction' : 'Add Restriction';
  if (saveBtn) saveBtn.textContent = editEntry ? 'Save Changes' : 'Save Restriction';

  const studentSelect = document.getElementById('restriction-student-select');
  populateStudentSelect(studentSelect, null);
  if (editEntry) studentSelect.value = editEntry.student_id;

  const isRoomTarget = !editEntry || !!editEntry.restricted_room;
  document.querySelector(`input[name="restriction-target-type"][value="${isRoomTarget ? 'rooms' : 'student'}"]`).checked = true;
  document.getElementById('restriction-rooms-picker').style.display = isRoomTarget ? 'block' : 'none';
  document.getElementById('restriction-student-picker').style.display = isRoomTarget ? 'none' : 'block';

  const checkboxGrid = document.getElementById('restriction-room-checkboxes');
  const editRoomSelect = document.getElementById('restriction-edit-room-select');
  if (editEntry) {
    // Editing always targets a single row — swap the multi-select checkboxes
    // for a single dropdown instead
    populateRoomCheckboxes();
    checkboxGrid.style.display = 'none';
    populateEditRoomSelect(editEntry.restricted_room);
    editRoomSelect.style.display = isRoomTarget ? 'block' : 'none';
  } else {
    populateRoomCheckboxes();
    checkboxGrid.style.display = 'flex';
    editRoomSelect.style.display = 'none';
  }

  const otherSelect = document.getElementById('restriction-other-student-select');
  populateStudentSelect(otherSelect, parseInt(studentSelect.value, 10) || null);
  if (editEntry && editEntry.restricted_student_id) otherSelect.value = editEntry.restricted_student_id;

  const durationSelect = document.getElementById('restriction-duration-select');
  const timePicker = document.getElementById('restriction-time-picker');
  if (editEntry) {
    // Edit mode always shows the exact expiry as an editable time — assumed
    // to be later today, same as how new restrictions are set
    durationSelect.value = 'specific_time';
    timePicker.style.display = 'block';
    document.getElementById('restriction-specific-time').value = toTimeInputValue(new Date(editEntry.expires_at));
  } else {
    durationSelect.value = '15min';
    timePicker.style.display = 'none';
  }

  const overlay = document.getElementById('restriction-overlay');
  overlay.style.display = 'flex';
  overlay.style.opacity = '0';
  setTimeout(() => overlay.style.opacity = '1', 10);
}

function hideRestrictionOverlay() {
  const overlay = document.getElementById('restriction-overlay');
  overlay.style.opacity = '0';
  setTimeout(() => overlay.style.display = 'none', 200);
}

async function saveRestriction() {
  const activeSite = fsGetActiveSite();
  if (!activeSite) { alert('Please choose a Student List (site) first.'); return; }

  const studentSelect = document.getElementById('restriction-student-select');
  const studentId = parseInt(studentSelect.value, 10);
  if (!studentId) { alert('Please choose a student.'); return; }
  const studentName = studentSelect.options[studentSelect.selectedIndex]?.textContent || 'Unknown';

  const targetType = document.querySelector('input[name="restriction-target-type"]:checked')?.value;
  const durationSelect = document.getElementById('restriction-duration-select');
  const expiresAt = computeRestrictionExpiry(durationSelect.value).toISOString();

  if (editingRestrictionId) {
    // Editing always updates a single existing row
    let updatePayload = { student_id: studentId, student_name: studentName, expires_at: expiresAt };
    if (targetType === 'rooms') {
      const roomName = document.getElementById('restriction-edit-room-select')?.value;
      if (!roomName) { alert('Please choose a room.'); return; }
      updatePayload.restricted_room = roomName;
      updatePayload.restricted_student_id = null;
      updatePayload.restricted_student_name = null;
    } else {
      const otherSelect = document.getElementById('restriction-other-student-select');
      const otherId = parseInt(otherSelect.value, 10);
      if (!otherId) { alert('Please choose the other student.'); return; }
      if (otherId === studentId) { alert("A student can't be restricted from themselves."); return; }
      updatePayload.restricted_room = null;
      updatePayload.restricted_student_id = otherId;
      updatePayload.restricted_student_name = otherSelect.options[otherSelect.selectedIndex]?.textContent || 'Unknown';
    }

    const { error } = await supabaseClient
      .from('student_restrictions')
      .update(updatePayload)
      .eq('id', editingRestrictionId);
    if (error) {
      alert('Error updating restriction: ' + error.message);
      return;
    }
    editingRestrictionId = null;
    hideRestrictionOverlay();
    await loadRestrictions();
    return;
  }

  let rows = [];

  if (targetType === 'rooms') {
    const checked = Array.from(document.querySelectorAll('#restriction-room-checkboxes input:checked')).map(cb => cb.value);
    if (checked.length === 0) { alert('Please select at least one room.'); return; }
    rows = checked.map(roomName => ({
      student_id: studentId,
      student_name: studentName,
      restricted_room: roomName,
      restricted_student_id: null,
      restricted_student_name: null,
      site: activeSite,
      expires_at: expiresAt
    }));
  } else {
    const otherSelect = document.getElementById('restriction-other-student-select');
    const otherId = parseInt(otherSelect.value, 10);
    if (!otherId) { alert('Please choose the other student.'); return; }
    if (otherId === studentId) { alert("A student can't be restricted from themselves."); return; }
    const otherName = otherSelect.options[otherSelect.selectedIndex]?.textContent || 'Unknown';
    rows = [{
      student_id: studentId,
      student_name: studentName,
      restricted_room: null,
      restricted_student_id: otherId,
      restricted_student_name: otherName,
      site: activeSite,
      expires_at: expiresAt
    }];
  }

  const { error } = await supabaseClient.from('student_restrictions').insert(rows);
  if (error) {
    alert('Error saving restriction: ' + error.message);
    return;
  }
  hideRestrictionOverlay();
  await loadRestrictions();
}

async function loadRestrictions() {
  const site = fsGetActiveSite();
  if (!site) { restrictionEntries = []; renderRestrictions(); return; }

  // Pull anything still active OR expired within the last 24h, so recently
  // expired restrictions can show a warning instead of vanishing instantly
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseClient
    .from('student_restrictions')
    .select('id, student_id, student_name, restricted_room, restricted_student_id, restricted_student_name, expires_at')
    .eq('site', site)
    .gt('expires_at', cutoff)
    .order('expires_at', { ascending: true });

  if (error) {
    console.error('Error loading restrictions:', error.message);
    return;
  }
  restrictionEntries = data || [];
  renderRestrictions();
}

function renderRestrictions() {
  const list = document.getElementById('restrictions-list');
  const emptyMsg = document.getElementById('restrictions-empty-message');
  if (!list) return;
  list.innerHTML = '';

  const now = Date.now();
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  // Show anything still active, plus anything expired less than 24h ago
  // (as a warning row) — anything older than that drops out of view.
  const visible = restrictionEntries.filter(r => (now - new Date(r.expires_at).getTime()) < TWENTY_FOUR_HOURS_MS);

  if (visible.length === 0) {
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  visible.forEach(r => {
    const isExpired = new Date(r.expires_at).getTime() <= now;

    const li = document.createElement('li');
    li.style.padding = '0.6rem 0.5rem';
    li.style.borderBottom = '1px solid #eee';
    li.style.fontSize = '1.05rem';
    li.style.display = 'flex';
    li.style.flexWrap = 'wrap';
    li.style.alignItems = 'center';
    li.style.gap = '0.3em';
    if (isExpired) {
      li.style.background = '#fff4f4';
      li.style.borderRadius = '8px';
    }

    if (isExpired) {
      const badge = document.createElement('span');
      badge.textContent = 'EXPIRED';
      badge.style.background = '#e53935';
      badge.style.color = '#fff';
      badge.style.fontSize = '0.7rem';
      badge.style.fontWeight = '700';
      badge.style.padding = '0.15rem 0.5rem';
      badge.style.borderRadius = '999px';
      badge.style.letterSpacing = '0.03em';
      li.appendChild(badge);
    }

    const nameEl = document.createElement('strong');
    nameEl.textContent = r.student_name;
    li.appendChild(nameEl);

    if (r.restricted_room) {
      li.appendChild(document.createTextNode(" can't go to "));
      li.appendChild(buildRestrictionRoomPill(r.restricted_room));
    } else {
      li.appendChild(document.createTextNode(` can't be with ${r.restricted_student_name}`));
    }

    const expiryEl = document.createElement('span');
    expiryEl.style.color = isExpired ? '#c62828' : '#888';
    expiryEl.style.fontSize = '0.9rem';
    expiryEl.style.marginLeft = 'auto';
    expiryEl.textContent = isExpired ? formatExpiredAgo(r.expires_at) : formatRestrictionExpiry(r.expires_at);
    li.appendChild(expiryEl);

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.className = 'btn btn-secondary';
    editBtn.style.fontSize = '0.85rem';
    editBtn.style.padding = '0.3rem 0.7rem';
    editBtn.style.marginLeft = '0.5rem';
    editBtn.addEventListener('click', () => openRestrictionOverlay(r));
    li.appendChild(editBtn);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'btn btn-danger-subtle';
    removeBtn.style.fontSize = '0.85rem';
    removeBtn.style.padding = '0.3rem 0.7rem';
    removeBtn.style.marginLeft = '0.5rem';
    removeBtn.addEventListener('click', () => deleteRestriction(r.id));
    li.appendChild(removeBtn);

    list.appendChild(li);
  });
}

async function deleteRestriction(id) {
  const { error } = await supabaseClient.from('student_restrictions').delete().eq('id', id);
  if (error) { alert('Error removing restriction: ' + error.message); return; }
  await loadRestrictions();
}

function startRestrictionsRealtime() {
  if (restrictionsRealtimeChannel) {
    try { supabaseClient.removeChannel(restrictionsRealtimeChannel); } catch {}
    restrictionsRealtimeChannel = null;
  }
  const site = fsGetActiveSite();
  if (!site) return;
  const safeVal = site.replace(/,/g, '\\,');
  restrictionsRealtimeChannel = supabaseClient
    .channel('restrictions_' + safeVal)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'student_restrictions', filter: `site=eq.${safeVal}` }, () => {
      loadRestrictions();
    })
    .subscribe();
}
// =================== End Restrictions ===================

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
// --- Start of existing code for search and rooms container ---
  const searchInput = document.getElementById("search-input");
  const roomsContainer = document.getElementById("rooms-container");
  const sortToggleBtn = document.getElementById("sort-toggle-button");

  // Sort toggle: alphabetical (default) vs. first-in-first-out, per room
  if (sortToggleBtn) {
    sortToggleBtn.addEventListener("click", () => {
      roomSortMode = roomSortMode === "alpha" ? "fifo" : "alpha";
      sortToggleBtn.textContent = roomSortMode === "fifo" ? "Sort: First In" : "Sort: A–Z";
      renderRooms(assignments, currentRoomOrder);
    });
  }

  // Highlight on search input, then scroll the first match into view
  searchInput.addEventListener("input", e => {
    currentSearchTerm = e.target.value.trim().toLowerCase();
    renderRooms(assignments, currentRoomOrder);       // highlight in assigned rooms
    renderUnassigned(unassignedList); // highlight in unassigned list
    if (currentSearchTerm) {
      requestAnimationFrame(() => {
        const firstMatch = document.querySelector(".highlight");
        if (firstMatch) firstMatch.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
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

  // Restrictions: load + realtime, plus a 30s repaint so expired entries
  // silently drop off the list even between fetches
  await loadRestrictions();
  startRestrictionsRealtime();
  setInterval(renderRestrictions, 30000);

  const addRestrictionBtn = document.getElementById('add-restriction-button');
  if (addRestrictionBtn) addRestrictionBtn.addEventListener('click', openRestrictionOverlay);

  const restrictionCancelBtn = document.getElementById('restriction-cancel-btn');
  if (restrictionCancelBtn) restrictionCancelBtn.addEventListener('click', hideRestrictionOverlay);

  const restrictionSaveBtn = document.getElementById('restriction-save-btn');
  if (restrictionSaveBtn) restrictionSaveBtn.addEventListener('click', saveRestriction);

  document.querySelectorAll('input[name="restriction-target-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const isRooms = e.target.value === 'rooms';
      document.getElementById('restriction-rooms-picker').style.display = isRooms ? 'block' : 'none';
      document.getElementById('restriction-student-picker').style.display = isRooms ? 'none' : 'block';
      if (isRooms) {
        document.getElementById('restriction-room-checkboxes').style.display = editingRestrictionId ? 'none' : 'flex';
        document.getElementById('restriction-edit-room-select').style.display = editingRestrictionId ? 'block' : 'none';
        if (editingRestrictionId) populateEditRoomSelect();
      } else {
        const studentSelect = document.getElementById('restriction-student-select');
        populateStudentSelect(document.getElementById('restriction-other-student-select'), parseInt(studentSelect.value, 10) || null);
      }
    });
  });

  const restrictionDurationSelect = document.getElementById('restriction-duration-select');
  if (restrictionDurationSelect) {
    restrictionDurationSelect.addEventListener('change', (e) => {
      document.getElementById('restriction-time-picker').style.display = e.target.value === 'specific_time' ? 'block' : 'none';
    });
  }

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
  assignOverlay.style.backgroundColor = 'rgba(40, 40, 40, 0.95)';
  assignOverlay.style.alignItems = 'center';
  assignOverlay.style.justifyContent = 'center';
  assignOverlay.style.flexDirection = 'column';
  assignOverlay.style.zIndex = '1000';
  assignOverlay.style.transition = 'opacity 0.3s ease';

  // Modal styling
  const assignModal = document.getElementById('assign-room-selection');
  assignModal.style.background = '#fff';
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
        selectedStudentIds.clear(); // must clear before fetchData() re-renders, or boxes reload checked
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
    loadRestrictions();
    startRestrictionsRealtime();
  }
});