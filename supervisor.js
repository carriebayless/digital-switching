// supervisor.js

// Add this code at the very top of your file
import { useEffect } from 'react';
import { useRouter } from 'next/router';

const SupervisorPage = () => {
    const router = useRouter();

    useEffect(() => {
        // Check for the security flag in local storage
        const isSupervisor = localStorage.getItem('isSupervisor');
        if (!isSupervisor) {
            // If the flag is not set, redirect to the login form
            router.push('/login'); // Replace '/login' with the path to your magic number form page
        }
    }, [router]);

    // The rest of your existing supervisor page code goes here...
};

export default SupervisorPage;

// ... Your existing JavaScript code for the supervisor page continues below

//push trigger 8/5 5:30 AM

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10?bundle&target=es2020";

const supabaseUrl = "https://bhfgcmknhrilmevclmye.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJoZmdjbWtuaHJpbG1ldmNsbXllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTMyNzM2ODMsImV4cCI6MjA2ODg0OTY4M30.1jWsjTGwhrcHeQrLritZODyaEl98vWRmNq0_slSMEzk";
const supabase = createClient(supabaseUrl, supabaseKey);
const myToken = supabaseKey; // fallback for legacy REST calls that expected a bearer token
window.supabase = supabase;


const rowCache = new Map();

// --- Normalize site value (supports legacy stored values like "site|Fieldstone Elementary")
function normalizeSite(raw) {
  if (!raw) return '';
  const val = String(raw);
  const sep = val.indexOf('|');
  if (sep === -1) return val; // already plain
  const column = val.slice(0, sep);
  const value = val.slice(sep + 1);
  if (column === 'site') return value;
  if (column === 'summer_site') return value;           // Kids Play / Club Knights
  if (column === 'non_school_day') return 'Non-School Day';
  return value || '';
}

function getSelectedSite() {
  const raw = localStorage.getItem('studentListFilter') || '';
  return normalizeSite(raw);
}

function setSelectedSite(site) {
  localStorage.setItem('studentListFilter', normalizeSite(site || ''));
}

// Persist editable start time per STANDARD site (no sessions)
function getStandardSiteTime(site) {
  site = normalizeSite(site);
  if (!site) return '13:45';
  const k = `stdSiteTime:${site}`;
  return localStorage.getItem(k) || '13:45';
}
function setStandardSiteTime(site, timeHHMM) {
  site = normalizeSite(site);
  if (!site) return;
  const k = `stdSiteTime:${site}`;
  localStorage.setItem(k, (timeHHMM || '13:45'));
}

// Simple in-memory cache for rooms/students (15s TTL) and render token
const roomsCache = new Map();
const studentsCache = new Map();
const CACHE_TTL = 15000; // ms
let loadRoomsToken = 0;

function makeKey(site, slot, showInactive) {
  return `${site}||${slot || 'NULL'}||${showInactive ? 'all' : 'active'}`;
}

function getCached(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL) { map.delete(key); return null; }
  return hit.v;
}

function setCached(map, key, value) {
  map.set(key, { v: value, t: Date.now() });
}

// --- Debounce for Realtime Burst Updates ---

const MANAGE_ROOMS_KEY = 'manageRoomsOn';
let __rtUpdateTimer;
function rtRefreshSoon(fn) {
  clearTimeout(__rtUpdateTimer);
  __rtUpdateTimer = setTimeout(fn, 0);
}

// Ensure the Actions column visibility matches the "Manage rooms" toggle
function ensureManageVisibilityClass() {
  const tbl = document.getElementById('room-table');
  const cb = document.getElementById('manage-rooms');
  const saved = localStorage.getItem(MANAGE_ROOMS_KEY);
  const on = cb ? !!cb.checked : (saved === 'true');
  if (tbl) tbl.classList.toggle('show-actions', on);
}

// --- Summary counts updater + in-place room counts updater ---
function updateSummaryCounts(totalStudents, totalCapacity) {
  const sEl = document.getElementById('total-students-count');
  const cEl = document.getElementById('total-capacity-count');
  if (sEl) sEl.textContent = String(totalStudents ?? '0');
  if (cEl) cEl.textContent = String(totalCapacity ?? '0');
}

async function updateRoomCountsInPlace() {
  try {
    const site = getSelectedSite();
    if (!site) return;

    // Avoid flicker before rows exist
    if (rowCache.size === 0) return;

    // Session-agnostic: scope only by site/summer_site/NSD; exclude gone
    const scope = getSiteScope();
    let studentsQ = supabase
      .from('master_roster')
      .select('assigned_room, is_gone');

    if (scope.column === 'non_school_day') {
      studentsQ = studentsQ.eq('non_school_day', true);
    } else {
      studentsQ = studentsQ.eq(scope.column, scope.value);
    }
    studentsQ = studentsQ.or('is_gone.is.null,is_gone.eq.false');

    const { data: students, error } = await studentsQ;
    if (error) { console.error('[updateRoomCountsInPlace] student fetch error', error); return; }

    // Count per room (case/trim insensitive), ignoring special rooms
    const countsLC = new Map();
    let totalAssigned = 0;
    (students || []).forEach(s => {
      const rn = (s.assigned_room || '').trim().toLowerCase();
      if (!rn || rn === 'gone' || rn === 'activity in building') return;
      countsLC.set(rn, (countsLC.get(rn) || 0) + 1);
      totalAssigned += 1;
    });

    const tbody = document.querySelector('#room-table tbody');
    if (!tbody) return;

    let totalCapacity = 0;

    rowCache.forEach((row, keyLC) => {
      if (!row || !row.isConnected) return;
      const countCell = row.children[1];
      const input = row.querySelector('input[type="number"]');
      const cap = input ? (parseInt(input.value, 10) || 0) : 0;
      totalCapacity += cap;

      // Use the canonical cache key (lowercased room name) to read counts
      const assigned = countsLC.get(keyLC) || 0;

      if (countCell) {
        const prev = countCell.textContent;
        const next = String(assigned);
        if (prev !== next) {
          countCell.textContent = next;
          countCell.classList.add('pulse');
          setTimeout(() => countCell.classList.remove('pulse'), 500);
        }
      }

      row.classList.remove('full-room', 'near-full-room', 'closed-room');
      if (cap === 0) row.classList.add('closed-room');
      else if (assigned >= cap) row.classList.add('full-room');
      else if (cap > 1 && assigned >= cap - 1) row.classList.add('near-full-room');
    });

    updateSummaryCounts(totalAssigned, totalCapacity);
  } catch (e) {
    console.error('[updateRoomCountsInPlace] failed', e);
  }
}


// --- Instant in-place counter update based on a single roster change ---
function applyRosterDelta(payload) {
  const site = getSelectedSite();
  if (!site) return;

  const oldRow = payload.old || {};
  const newRow = payload.new || {};

  // Only react to changes for the current scope (site / summer_site / non_school_day)
  const scope = getSiteScope();
  const inScope = (row) => {
    if (!row) return false;
    if (scope.column === 'non_school_day') return !!row.non_school_day;
    return (row[scope.column] === scope.value);
  };
  if (!inScope(oldRow) && !inScope(newRow)) return;

  const norm = (v) => (v || '').toString().trim().toLowerCase();
  const cleanRoom = (r) => {
    const lc = norm(r);
    if (!lc) return null;
    if (lc === 'gone' || lc === 'activity in building') return null;
    return lc;
  };

  const oldRoomLC = cleanRoom(oldRow.assigned_room);
  const newRoomLC = cleanRoom(newRow.assigned_room);

  // If nothing visible changed for this view, bail
  if (!oldRoomLC && !newRoomLC) return;

  const tbody = document.querySelector('#room-table tbody');
  if (!tbody) return;

  const bump = (roomKeyLC, delta) => {
    if (!roomKeyLC) return false;
    const rowEl = rowCache.get(roomKeyLC);
    if (!rowEl || !rowEl.isConnected) return false;
    const td = rowEl.children[1];
    if (!td) return false;
    const curr = parseInt(td.textContent || '0', 10) || 0;
    const next = Math.max(0, curr + delta);
    if (curr === next) return true;
    td.textContent = String(next);
    td.classList.add('pulse');
    setTimeout(() => td.classList.remove('pulse'), 400);

    const capInput = rowEl.querySelector('input[type="number"]');
    const cap = capInput ? (parseInt(capInput.value, 10) || 0) : 0;
    rowEl.classList.remove('full-room', 'near-full-room', 'closed-room');
    if (cap === 0) rowEl.classList.add('closed-room');
    else if (next >= cap) rowEl.classList.add('full-room');
    else if (cap > 1 && next >= cap - 1) rowEl.classList.add('near-full-room');
    return true;
  };

  // Apply deltas (session-agnostic)
  if (oldRoomLC) bump(oldRoomLC, -1);
  if (newRoomLC) bump(newRoomLC, +1);

  // Update summary total for students-in-rooms (ignores Gone/Activity)
  let deltaTotal = 0;
  if (oldRoomLC && !newRoomLC) deltaTotal = -1; // left any counted room
  else if (!oldRoomLC && newRoomLC) deltaTotal = +1; // entered any counted room

  const sEl = document.getElementById('total-students-count');
  if (sEl && deltaTotal !== 0) {
    const curr = parseInt(sEl.textContent || '0', 10) || 0;
    sEl.textContent = String(Math.max(0, curr + deltaTotal));
  }
}

// --- Floating Add Room Logic ---
const addRoomFAB = document.getElementById("add-room-fab");
const addRoomOverlay = document.getElementById("add-room-overlay");
const addRoomForm = document.getElementById("add-room-form");
const cancelAddRoomBtn = document.getElementById("cancel-add-room");

function showAddRoomOverlay() {
  if (!addRoomOverlay) return;
  addRoomOverlay.classList.add('show');
}

function hideAddRoomOverlay() {
  if (!addRoomOverlay) return;
  addRoomOverlay.classList.remove('show');
  if (addRoomForm) addRoomForm.reset();
}

if (addRoomFAB) {
  addRoomFAB.addEventListener("click", showAddRoomOverlay);
}

if (cancelAddRoomBtn) {
  cancelAddRoomBtn.addEventListener("click", hideAddRoomOverlay);
}

if (addRoomForm) {
  addRoomForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const roomNameInput = document.getElementById('new-room-name');
    const roomName = roomNameInput.value.trim();
    if (!roomName) { alert('Please enter a room name.'); return; }

    // Prefer site chosen in the modal; fall back to saved dropdown selection
    const siteSelect = document.getElementById('add-room-site');
    let site = siteSelect && siteSelect.value ? siteSelect.value : '';
    if (!site) {
      site = getSelectedSite() || '';
    }
    if (!site) { alert('Please choose a site.'); return; }

    // Optional style fields (free-form emoji supported)
    let colorHex = document.getElementById('add-room-color')?.value || null;
    let iconEmoji = document.getElementById('add-room-icon')?.value || '';
    if (iconEmoji) iconEmoji = iconEmoji.trim();
    if (iconEmoji === '') iconEmoji = null;

    const timeBasedSites = ['Club Knights', 'Kids Play', 'Non-School Day'];
    const isTimeBased = timeBasedSites.includes(site);
    // NOTE: We no longer "probe" for color/icon columns here. The insert below
    // already retries without these fields if the DB doesn't have them yet.

try {
  const targets = isTimeBased ? ['6:00', '9:00', '1:00', '3:00'] : [null];
  let revived = 0;
  let duplicates = 0;

  // Build payloads — include style fields only when provided
  const buildPayload = (ts) => {
    const base = {
      room_name: roomName,
      site,
      capacity: 0,
      active: true,
      time_slot: ts
    };
    if (colorHex) base.color_hex = colorHex;
    if (iconEmoji) base.icon_emoji = iconEmoji; // free-form emoji
    return base;
  };

  const toInsert = [];

  for (const ts of targets) {
    // Check for existing room (active or inactive)
    let q = supabase.from('rooms')
      .select('id, active')
      .eq('site', site)
      .eq('room_name', roomName)
      .limit(1);
    q = ts ? q.eq('time_slot', ts) : q.is('time_slot', null);
    const { data: existing, error: selErr } = await q;
    if (selErr) throw selErr;

    if (existing && existing.length) {
      const row = existing[0];
      if (row.active) {
        duplicates += 1; // already exists and active
      } else {
        const up = supabase.from('rooms')
          .update({ active: true, capacity: 0 })
          .eq('id', row.id);
        const { error: reviveErr } = await up;
        if (reviveErr) throw reviveErr;
        revived += 1;
      }
    } else {
      toInsert.push(buildPayload(ts));
    }
  }

  if (toInsert.length) {
    // Try with style fields first; if PostgREST rejects unknown columns, retry without them
    let insErr = null;
    let resp = await supabase.from('rooms').insert(toInsert);
    insErr = resp.error || null;
    if (insErr && (insErr.code === '42703' || String(insErr.message || '').includes('color_hex') || String(insErr.message || '').includes('icon_emoji') || String(insErr.code || '').startsWith('PGRST'))) {
      // Remove styling keys and retry
      const stripped = toInsert.map(({ color_hex, icon_emoji, ...rest }) => rest);
      const retry = await supabase.from('rooms').insert(stripped);
      insErr = retry.error || null;
      if (!insErr && (colorHex || iconEmoji)) {
        console.warn('[rooms] Inserted without style fields — add columns color_hex text, icon_emoji text to enable styling.');
        showToast('Added room without style fields (enable color/icon in DB to use).', 'info');
      }
    }
    if (insErr) throw insErr;
  }

  if (revived || toInsert.length) showToast(`Room(s) added${revived ? `, ${revived} restored` : ''}.`, 'success');
  if (duplicates && !toInsert.length) showToast('Room already exists.', 'info');

  if (roomNameInput) roomNameInput.value = '';
  hideAddRoomOverlay();
  await loadRoomsForSite(site);
} catch (err) {
  console.error('Error adding room:', err?.message || err, err?.code || '', err?.details || '', err?.hint || '');
  const msg = err?.message && typeof err.message === 'string' ? err.message : 'Failed to add room.';
  showToast(msg.includes('duplicate') ? 'Room already exists.' : 'Failed to add room.', 'error');
}
  });
}

// --- GLOBAL VARIABLES FOR SESSION SWITCHING ---
let activeSessionKey = "session1";
let userManuallySelected = false;
let sessionData = {}; // Object to store fetched session times

// --- Helpers ---
const timeBasedSites = ['Club Knights', 'Kids Play', 'Non-School Day'];
const isTimeBasedSiteFor = (site) => timeBasedSites.includes(site);

function sessionKeyToTimeSlot(key) {
  switch (key) {
    case 'session1': return '6:00';
    case 'session2': return '9:00';
    case 'session3': return '1:00';
    case 'session4': return '3:00';
    default: return null;
  }
}

// Determine how to scope queries for the currently selected site
function getSiteScope() {
  const site = getSelectedSite();
  const isTimeBased = ["Club Knights", "Kids Play", "Non-School Day"].includes(site);
  if (!site) return { site, isTimeBased, column: 'site', value: null };
  if (site === 'Non-School Day') return { site, isTimeBased, column: 'non_school_day', value: true };
  if (isTimeBased) return { site, isTimeBased, column: 'summer_site', value: site };
  return { site, isTimeBased, column: 'site', value: site };
}

// --- Room style defaults (used when DB color/icon are null) ---
const DEFAULT_ROOM_STYLES = {
  'art room':      { color_hex: '#e53935', icon_emoji: '🎨' },
  'cafeteria':     { color_hex: '#8d6e63', icon_emoji: '🍽️' },
  'gym':           { color_hex: '#2e7d32', icon_emoji: '🏀' },
  'outside':       { color_hex: '#1565c0', icon_emoji: '🌳' },
  'creative corner': { color_hex: '#6a1b9a', icon_emoji: '🧩' },
  'discovery den': { color_hex: '#00897b', icon_emoji: '🔎' },
  'imagination station': { color_hex: '#5e35b1', icon_emoji: '💡' },
};

function getDefaultStyleForRoomName(name) {
  if (!name) return { color_hex: null, icon_emoji: null };
  const hit = DEFAULT_ROOM_STYLES[name.trim().toLowerCase()];
  return hit ? { ...hit } : { color_hex: null, icon_emoji: null };
}

function computeRoomStyle(room) {
  const def = getDefaultStyleForRoomName(room?.room_name || '');
  return {
    color_hex: room?.color_hex ?? def.color_hex,
    icon_emoji: room?.icon_emoji ?? def.icon_emoji,
  };
}

function normalizeToHex6(hex) {
  if (!hex) return null;
  let v = String(hex).trim();
  if (!v.startsWith('#')) v = `#${v}`;
  const m3 = /^#([0-9a-fA-F]{3})$/.exec(v);
  if (m3) {
    const r = m3[1][0], g = m3[1][1], b = m3[1][2];
    v = `#${r}${r}${g}${g}${b}${b}`;
  }
  return /^#([0-9a-fA-F]{6})$/.test(v) ? v : null;
}

// Helper to reliably show/hide the time toggle buttons based on site,
// but always show the wrapper so the Clear button is always visible.
function setSessionTabsVisibilityFor(site) {
  const isTimeBased = ["Club Knights", "Kids Play", "Non-School Day"].includes(site);
  const sessionTabsWrapper = document.querySelector('.session-tab')?.parentElement;
  const tabs = document.querySelectorAll('.session-tab');
  if (sessionTabsWrapper) {
    // Always keep wrapper visible so Clear button remains visible
    sessionTabsWrapper.style.display = 'flex';
  }
  tabs.forEach(btn => {
    btn.style.display = isTimeBased ? 'inline-block' : 'none';
  });
}

// Helper to reliably place the site dropdown inside the summary chip
function placeSiteDropdownInChip() {
  const sessionContainer = document.getElementById('session-container');
  const card = sessionContainer ? sessionContainer.firstElementChild : null;
  if (!card) return; // chip not rendered yet

  const siteSelect = document.getElementById('student-list-dropdown');
  if (!siteSelect) return; // HTML missing

  // Prefer moving the existing label wrapper for consistent spacing
  const wrap = siteSelect.closest('label') || siteSelect;

  // If the wrapper is already in the chip as the first child, do nothing
  if (wrap.parentElement === card) return;

  // Use classes instead of inline styles; CSS will control spacing/appearance
  wrap.classList.add('site-inline');
  siteSelect.classList.add('ds-select');

  // Prepend into the chip
  card.prepend(wrap);
}

// Helper to temporarily move the site dropdown out of the chip before re-rendering
function detachSiteDropdownFromChip() {
  const siteSelect = document.getElementById('student-list-dropdown');
  if (!siteSelect) return;
  const wrap = siteSelect.closest('label') || siteSelect;
  // Create (or reuse) a hidden parking container to hold the live node
  let park = document.getElementById('site-parking');
  if (!park) {
    park = document.createElement('div');
    park.id = 'site-parking';
    park.style.display = 'none';
    document.body.appendChild(park);
  }
  if (wrap.parentElement !== park) park.appendChild(wrap);
}

function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) { console.log(`[toast:${type}]`, msg); return; }
  const div = document.createElement('div');
  div.textContent = msg;
  div.style.background = type === 'error' ? '#f8d7da' : type === 'success' ? '#d4edda' : '#e2e3e5';
  div.style.border = '1px solid ' + (type === 'error' ? '#f5c2c7' : type === 'success' ? '#c3e6cb' : '#d6d8db');
  div.style.color = '#000';
  div.style.padding = '10px 14px';
  div.style.marginTop = '8px';
  div.style.borderRadius = '8px';
  div.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
  el.appendChild(div);
  setTimeout(() => div.remove(), 2200);
}

// Case/locale-safe room name compare
function compareRoomNames(a, b) {
  const an = (a.room_name || '').toLowerCase();
  const bn = (b.room_name || '').toLowerCase();
  return an.localeCompare(bn);
}

// ---- Device panel helpers/state ----
let _allDevices = [];
let _devicesShowInactive = false;
let _devicesSearch = '';

function updateDevicesCount(n) {
  const el = document.getElementById('devices-count');
  if (el) el.textContent = n ? `(${n})` : '';
}

function formatWhen(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

function parseFilterPair(pair) {
  // pair like "site|Fieldstone Elementary" or "non_school_day|true"
  if (!pair) return { column: null, value: null };
  const idx = pair.indexOf('|');
  if (idx === -1) return { column: null, value: null };
  const column = pair.slice(0, idx);
  let value = pair.slice(idx + 1);
  if (column === 'non_school_day') {
    // we persist booleans as 'true'/'false' text
    value = String(value === true || value === 'true');
  }
  return { column, value };
}

function makeFilterPair(column, value) {
  if (!column || value === undefined || value === null) return '';
  if (column === 'non_school_day') return `${column}|${String(value)}`; // 'true'/'false'
  return `${column}|${value}`;
}

async function loadDevicesPanel() {
  const tbody = document.querySelector('#devices-table tbody');
  if (!tbody) return; // HTML not present
  tbody.innerHTML = '<tr><td colspan="6" style="padding:8px; color:#666; font-style:italic;">Loading devices…</td></tr>';

  const showInactiveCb = document.getElementById('devices-show-inactive');
  _devicesShowInactive = !!showInactiveCb?.checked;

  // Try selecting with `id`; fall back if column doesn't exist
  let sel = supabase
    .from('device_roster_filters')
    .select('id, device_key, device_name, filter_column, filter_value, updated_at, active')
    .order('device_name', { ascending: true })
    .order('device_key', { ascending: true });
  if (!_devicesShowInactive) sel = sel.eq('active', true);

  let { data, error } = await sel;

  if (error && (error.code === '42703' || /column\s+"?id"?\s+does not exist/i.test(error.message || ''))) {
    // Fallback: table doesn't have an `id` column; re-run without it
    let sel2 = supabase
      .from('device_roster_filters')
      .select('device_key, device_name, filter_column, filter_value, updated_at, active')
      .order('device_name', { ascending: true })
      .order('device_key', { ascending: true });
    if (!_devicesShowInactive) sel2 = sel2.eq('active', true);
    const res2 = await sel2;
    data = res2.data || [];
    error = res2.error || null;
    // Normalize: attach null id so downstream code can accept either id or key
    if (Array.isArray(data)) data = data.map(d => ({ id: null, ...d }));
  }

  if (error) {
    console.error('Error loading devices:', { code: error.code, message: error.message, details: error.details, hint: error.hint });
    tbody.innerHTML = '<tr><td colspan="6" style="padding:8px; color:#900;">Failed to load devices.</td></tr>';
    updateDevicesCount(0);
    return;
  }

  _allDevices = data || [];

  const q = (_devicesSearch || '').toLowerCase();
  const filtered = q
    ? _allDevices.filter(d => (d.device_name || '').toLowerCase().includes(q) || (d.device_key || '').toLowerCase().includes(q))
    : _allDevices;

  updateDevicesCount(filtered.length);
  renderDevicesTable(filtered);
}

function renderDevicesTable(list) {
  const tbody = document.querySelector('#devices-table tbody');
  const tmpl = document.getElementById('device-row-template');
  if (!tbody || !tmpl) return;
  tbody.innerHTML = '';

  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="padding:8px; color:#666; font-style:italic;">No devices yet. Open the student UI on an iPad to register it.</td></tr>';
    return;
  }

  list.forEach(dev => {
    const frag = tmpl.content.cloneNode(true);
    const nameInput = frag.querySelector('.dev-name');
    const select = frag.querySelector('.dev-filter');
    const keyCell = frag.querySelector('.dev-key');
    const updatedCell = frag.querySelector('.dev-updated');
    const statusPill = frag.querySelector('.dev-status .status-pill') || frag.querySelector('.dev-status');
    const saveBtn = frag.querySelector('.dev-save');
    const infoBtn = frag.querySelector('.dev-info');
    const removeBtn = frag.querySelector('.dev-remove');
    const restoreBtn = frag.querySelector('.dev-restore');

    // Legacy inline permanent-delete button is deprecated; hide if present
    const legacyDeleteBtn = frag.querySelector('.dev-delete');
    if (legacyDeleteBtn) legacyDeleteBtn.style.display = 'none';

    nameInput.value = dev.device_name || '';
    keyCell.textContent = dev.device_key;
    updatedCell.textContent = formatWhen(dev.updated_at);

    const isActive = dev.active !== false; // default to true
    if (statusPill) {
      statusPill.textContent = isActive ? 'Active' : 'Inactive';
      statusPill.style.background = isActive ? '#e6f4ea' : '#f3f4f6';
      statusPill.style.color = isActive ? '#1e7e34' : '#555';
    }

    const pair = makeFilterPair(dev.filter_column, dev.filter_value);
    if (pair) {
      const opt = Array.from(select.options).find(o => o.value === pair);
      select.value = opt ? opt.value : '';
    } else {
      select.value = '';
    }

    removeBtn.style.display = isActive ? '' : 'none';
    restoreBtn.style.display = !isActive ? '' : 'none';

    saveBtn.addEventListener('click', async () => {
      const newName = nameInput.value.trim();
      const pf = parseFilterPair(select.value);
      try {
        const { error } = await supabase
          .from('device_roster_filters')
          .upsert({
            device_key: dev.device_key,
            device_name: newName || null,
            filter_column: pf.column,
            filter_value: pf.value,
            active: isActive,
            updated_at: new Date().toISOString(),
          });
        if (error) throw error;
        showToast('Device saved', 'success');
        loadDevicesPanel();
      } catch (e) {
        console.error('Device save failed:', e);
        showToast('Failed to save device', 'error');
      }
    });

    if (infoBtn) infoBtn.addEventListener('click', () => openDeviceInfo(dev));

    if (removeBtn) removeBtn.addEventListener('click', () => openDeviceRemoveDialog(dev));

    if (restoreBtn) restoreBtn.addEventListener('click', async () => {
      await restoreDevice(dev.device_key);
    });

    tbody.appendChild(frag);
  });
}

async function softDeleteDevice(id, deviceKey) {
  try {
    let q = supabase.from('device_roster_filters').update({ active: false, updated_at: new Date().toISOString() });
    q = id ? q.eq('id', id) : q.eq('device_key', deviceKey);
    const { error } = await q;
    if (error) throw error;
    showToast('Device hidden (can restore).', 'success');
    loadDevicesPanel();
  } catch (e) {
    console.error('Soft delete failed:', e);
    showToast('Failed to hide device.', 'error');
  }
}

async function restoreDevice(deviceKey) {
  try {
    const { error } = await supabase
      .from('device_roster_filters')
      .update({ active: true, updated_at: new Date().toISOString() })
      .eq('device_key', deviceKey);
    if (error) throw error;
    showToast('Device restored', 'success');
    loadDevicesPanel();
  } catch (e) {
    console.error('Restore failed:', e);
    showToast('Failed to restore device', 'error');
  }
}

async function hardDeleteDevice(id, deviceKey) {
  try {
    let q = supabase.from('device_roster_filters').delete();
    q = id ? q.eq('id', id) : q.eq('device_key', deviceKey);
    const { data, error } = await q.select('device_key');
    if (error) throw error;

    const affected = Array.isArray(data) ? data.length : 0;
    if (affected > 0) {
      showToast('Device permanently deleted.', 'success');
    } else {
      // Some PostgREST/RLS configs return no rows even when delete succeeds, or may block delete.
      // As a resilient fallback, mark inactive so it disappears when not showing inactive.
      let uq = supabase.from('device_roster_filters').update({ active: false, updated_at: new Date().toISOString() });
      uq = id ? uq.eq('id', id) : uq.eq('device_key', deviceKey);
      const { error: upErr } = await uq;
      if (upErr) throw upErr;
      showToast('No matching device to hard-delete; hid the device instead.', 'info');
    }

    // Optimistic UI: drop from current list immediately
    if (Array.isArray(_allDevices) && (_allDevices.length > 0)) {
      _allDevices = _allDevices.filter(d => (id ? d.id !== id : d.device_key !== deviceKey));
      const q = (_devicesSearch || '').toLowerCase();
      const filtered = q
        ? _allDevices.filter(d => (d.device_name || '').toLowerCase().includes(q) || (d.device_key || '').toLowerCase().includes(q))
        : _allDevices;
      updateDevicesCount(filtered.length);
      renderDevicesTable(filtered);
    }

    await loadDevicesPanel();
  } catch (e) {
    console.error('Hard delete failed:', e);
    const msg = e?.message || 'Failed to permanently delete device.';
    showToast(msg, 'error');
    // Attempt to refresh so UI stays in sync
    loadDevicesPanel();
  }
}

// --- Remove/Delete chooser modal wiring ---
let _removeDlgEl = null;
let _removeHideBtn = null;
let _removeDeleteBtn = null;
let _removeCancelBtn = null;
let _removeLabelEl = null;
let _removeDeviceKey = null;
let _removeDeviceId = null;

function openDeviceRemoveDialog(dev){
  _removeDeviceKey = dev?.device_key || null;
  _removeDeviceId = dev?.id || null;
  if (!_removeDlgEl) {
    _removeDlgEl = document.getElementById('device-remove-dialog');
    _removeHideBtn = document.getElementById('device-remove-hide');
    _removeDeleteBtn = document.getElementById('device-remove-delete');
    _removeCancelBtn = document.getElementById('device-remove-cancel');
    _removeLabelEl = document.getElementById('device-remove-label');
    // Attach one-time handlers
    if (_removeCancelBtn) _removeCancelBtn.addEventListener('click', () => { if (_removeDlgEl) _removeDlgEl.style.display = 'none'; });
    if (_removeHideBtn) _removeHideBtn.addEventListener('click', async () => {
      if (!_removeDeviceKey && !_removeDeviceId) return;
      await softDeleteDevice(_removeDeviceId, _removeDeviceKey);
      if (_removeDlgEl) _removeDlgEl.style.display = 'none';
    });
    if (_removeDeleteBtn) _removeDeleteBtn.addEventListener('click', async () => {
      if (!_removeDeviceKey && !_removeDeviceId) return;
      await hardDeleteDevice(_removeDeviceId, _removeDeviceKey);
      if (_removeDlgEl) _removeDlgEl.style.display = 'none';
    });
    if (_removeDlgEl) _removeDlgEl.addEventListener('click', (e) => { if (e.target === _removeDlgEl) _removeDlgEl.style.display = 'none'; });
  }
  if (_removeLabelEl) {
    const label = (dev?.device_name && dev.device_name.trim()) ? `${dev.device_name} (${dev.device_key})` : (dev?.device_key || '—');
    _removeLabelEl.textContent = label;
  }
  if (_removeDlgEl) _removeDlgEl.style.display = 'flex';
}

function openDeviceInfo(dev) {
  const dlg = document.getElementById('device-admin-dialog');
  if (!dlg) return;
  const n = document.getElementById('admin-info-device-name');
  const k = document.getElementById('admin-info-device-key');
  const f = document.getElementById('admin-info-filter');
  const u = document.getElementById('admin-info-updated');
  const s = document.getElementById('admin-info-status');
  if (n) n.textContent = dev.device_name || '—';
  if (k) k.textContent = dev.device_key || '—';
  if (f) {
    let label = '(Show All Students)';
    if (dev.filter_column === 'site') label = dev.filter_value;
    else if (dev.filter_column === 'summer_site') label = `Summer: ${dev.filter_value}`;
    else if (dev.filter_column === 'non_school_day' && String(dev.filter_value) === 'true') label = 'Non-School Day';
    f.textContent = label;
  }
  if (u) u.textContent = formatWhen(dev.updated_at);
  if (s) s.textContent = (dev.active !== false) ? 'Active' : 'Inactive';
  dlg.style.display = 'flex';
}

// --- Add Clear All Room Max Counts button ---
const clearCapacitiesBtn = document.createElement("button");
clearCapacitiesBtn.textContent = "Clear All Room Max Counts";
clearCapacitiesBtn.className = "clear-max-chip";

// Get references to the new overlay elements
const clearMaxCountsOverlay = document.getElementById('clear-max-counts-overlay');
const clearSessionButtonsContainer = document.getElementById('clear-session-buttons');
const clearMaxCountsCancelBtn = document.getElementById('clear-max-counts-cancel');

// Function to show the clear capacities overlay
function showClearCapacitiesOverlay() {
  if (clearMaxCountsOverlay) clearMaxCountsOverlay.classList.add('show');
}

function hideClearCapacitiesOverlay() {
  if (clearMaxCountsOverlay) clearMaxCountsOverlay.classList.remove('show');
}

// Site-aware clear of student room assignments (respects time slots for time-based sites)
async function clearStudentAssignmentsFor(site, timeSlot /* can be null */) {
  if (!site) { showToast('No site selected.', 'error'); return; }
  const isTimeBased = ["Club Knights", "Kids Play", "Non-School Day"].includes(site);
  const ts = isTimeBased ? (timeSlot || sessionKeyToTimeSlot(activeSessionKey)) : null;

  try {
    let upd = supabase
      .from('master_roster')
      .update({ assigned_room: null })
      .not('assigned_room', 'is', null) // IS NOT NULL
      .neq('assigned_room', 'Gone')
      .neq('assigned_room', 'Activity in Building');

    // Scope by site type
    if (site === 'Non-School Day') {
      upd = upd.eq('non_school_day', true);
    } else if (isTimeBased) {
      // Summer programming lives under summer_site
      upd = upd.eq('summer_site', site);
    } else {
      upd = upd.eq('site', site);
    }

    // If a time-based site and a slot is chosen, also scope by assigned_session
    if (isTimeBased) {
      if (ts) upd = upd.eq('assigned_session', ts);
      else upd = upd.or('assigned_session.is.null,assigned_session.eq.'); // safety for missing values
    }

    // Optional: one-time debug log for filter
    if (window.DEBUG_CLEAR_BTN) {
      // These variables are not defined in this scope, but the request was to add a debug log.
      // We'll log the update object and site/ts for context.
      console.log('[clear-rooms] clearStudentAssignmentsFor filter:', {
        site, timeSlot: ts, isTimeBased, upd
      });
    }

    const { error } = await upd;
    if (error) throw error;

    showToast('Cleared student room selections.', 'success');
    // Snap the counts/table back in sync
    await loadRoomsForSite(site);
    updateRoomCountsInPlace();
  } catch (e) {
    console.error('Clear student assignments failed:', e);
    showToast('Failed to clear room selections.', 'error');
  }
}

// Site-aware capacity clear helper
async function clearCapacitiesFor(site, timeSlot /* can be null */) {
  if (!site) { showToast('No site selected.', 'error'); return; }
  const isTimeBased = ["Club Knights", "Kids Play", "Non-School Day"].includes(site);
  const ts = isTimeBased ? (timeSlot || sessionKeyToTimeSlot(activeSessionKey)) : null;

  // Fetch valid room names for this scope (skip special rooms)
  let rq = supabase.from('rooms')
    .select('room_name')
    .eq('site', site)
    .eq('active', true);
  if (isTimeBased) rq = rq.eq('time_slot', ts); else rq = rq.is('time_slot', null);
  const { data: rooms, error: roomsError } = await rq;
  if (roomsError) { console.error('Error fetching rooms to clear:', roomsError); showToast('Error fetching rooms.', 'error'); return; }

  const validRoomNames = (rooms || [])
    .map(r => r.room_name)
    .filter(name => name && name.toLowerCase() !== 'gone' && name.toLowerCase() !== 'activity in building');
  if (!validRoomNames.length) { showToast('No rooms to clear for this selection.', 'info'); return; }

  // Update capacities to 0 for this scope
  let uq = supabase.from('rooms').update({ capacity: 0 }).eq('site', site).in('room_name', validRoomNames);
  if (isTimeBased) uq = uq.eq('time_slot', ts); else uq = uq.is('time_slot', null);
  const { error: updateError } = await uq;
  if (updateError) { console.error('Clear capacities failed:', updateError); showToast('Failed to clear capacities.', 'error'); return; }

  // --- Instant UI update: zero out visible capacity inputs for affected rooms ---
  try {
    let totalCap = 0;
    let totalAssigned = 0;

    validRoomNames.forEach((name) => {
      const keyLC = (name || '').toString().trim().toLowerCase();
      const rowEl = rowCache.get(keyLC);
      if (!rowEl || !rowEl.isConnected) return;
      // Set capacity input to 0
      const capInput = rowEl.querySelector('input[type="number"]');
      if (capInput) capInput.value = 0;
      // Update row classes
      rowEl.classList.remove('full-room', 'near-full-room');
      rowEl.classList.add('closed-room');
    });

    // Recalculate summary totals from the DOM
    const rows = Array.from(document.querySelectorAll('#room-table tbody tr'));
    rows.forEach((tr) => {
      const countCell = tr.children[1];
      const capInput = tr.querySelector('input[type="number"]');
      const assigned = parseInt(countCell?.textContent || '0', 10) || 0;
      const cap = parseInt(capInput?.value || '0', 10) || 0;
      totalAssigned += assigned;
      totalCap += cap;
      // Ensure visual closed state when cap is 0
      tr.classList.remove('full-room', 'near-full-room', 'closed-room');
      if (cap === 0) tr.classList.add('closed-room');
      else if (assigned >= cap) tr.classList.add('full-room');
      else if (cap > 1 && assigned >= cap - 1) tr.classList.add('near-full-room');
    });
    updateSummaryCounts(totalAssigned, totalCap);
  } catch (e) {
    console.warn('[clearCapacitiesFor] instant UI update failed (non-fatal):', e);
  }

  showToast('Room capacities cleared.', 'success');

  // Close overlay if open, then do a safe refresh to reconcile any drift
  hideClearCapacitiesOverlay();
  await loadRoomsForSite(site);
  updateRoomCountsInPlace();
}

// Attach the new click handler to the main clear button
clearCapacitiesBtn.onclick = async () => {
  // Determine current site from the filter (plain string)
  const site = getSelectedSite();
  if (!site) { showToast('Please choose a site first.', 'error'); return; }

  const isTimeBased = ["Club Knights", "Kids Play", "Non-School Day"].includes(site);

  if (!isTimeBased) {
    // Simple confirm, then clear immediately for non–time-based sites
    const ok = confirm(`Clear ALL room max counts for ${site}?`);
    if (!ok) return;
    await clearCapacitiesFor(site, null);
    return;
  }

  // Time-based sites → build and show chooser overlay
  if (clearSessionButtonsContainer) clearSessionButtonsContainer.innerHTML = '';
  const sessions = [
    { key: 'session1', label: '6:00' },
    { key: 'session2', label: '9:00' },
    { key: 'session3', label: '1:00' },
    { key: 'session4', label: '3:00' },
  ];
  sessions.forEach(({ key, label }) => {
    const b = document.createElement('button');
    b.textContent = `Clear ${label} Counts`;
    b.addEventListener('click', async () => {
      const ok = confirm(`Clear ALL room max counts for ${site} — ${label}?`);
      if (!ok) return;
      await clearCapacitiesFor(site, label);
      hideClearCapacitiesOverlay();
    });
    if (clearSessionButtonsContainer) clearSessionButtonsContainer.appendChild(b);
  });

  if (clearMaxCountsCancelBtn) clearMaxCountsCancelBtn.onclick = hideClearCapacitiesOverlay;
  showClearCapacitiesOverlay();
};

// Optional: Clear all student room selections (time-aware)
(function attachClearAssignmentsButton(){
  const btn = document.getElementById('clear-assignments-btn') || document.getElementById('clear-rooms-btn');
  if (!btn) return; // no button on this page

  btn.addEventListener('click', async () => {
    const site = getSelectedSite();
    if (!site) { showToast('Please choose a site first.', 'error'); return; }
    const isTimeBased = ["Club Knights", "Kids Play", "Non-School Day"].includes(site);

    if (!isTimeBased) {
      if (!confirm(`Clear ALL student room selections for ${site}?`)) return;
      await clearStudentAssignmentsFor(site, null);
      return;
    }

    // Time-based: offer per-session clears
    if (clearSessionButtonsContainer) clearSessionButtonsContainer.innerHTML = '';
    const sessions = [
      { key: 'session1', label: '6:00' },
      { key: 'session2', label: '9:00' },
      { key: 'session3', label: '1:00' },
      { key: 'session4', label: '3:00' },
    ];
    sessions.forEach(({ key, label }) => {
      const b = document.createElement('button');
      b.textContent = `Clear ${label} Assignments`;
      b.addEventListener('click', async () => {
        const ok = confirm(`Clear ALL student room selections for ${site} — ${label}?`);
        if (!ok) return;
        await clearStudentAssignmentsFor(site, label);
        hideClearCapacitiesOverlay();
      });
      if (clearSessionButtonsContainer) clearSessionButtonsContainer.appendChild(b);
    });
    if (clearMaxCountsCancelBtn) clearMaxCountsCancelBtn.onclick = hideClearCapacitiesOverlay;
    showClearCapacitiesOverlay();
  });
})();

// --- Room styling helpers (color dot + emoji) ---
function renderRoomNameCell(td, room, { showDot = true } = {}) {
  td.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'room-name-wrap';

  // Color dot only when Manage is ON
  let dot = null;
  if (showDot) {
    dot = document.createElement('span');
    dot.className = 'room-color-dot';
    if (room.color_hex) {
      const hex = String(room.color_hex).trim();
      dot.style.background = hex.startsWith('#') ? hex : `#${hex}`;
    }
    wrap.appendChild(dot);
  }

  // Emoji (always if present)
  if (room.icon_emoji) {
    // Use innerHTML to include a non-breaking space entity after the emoji
    const emojiSpan = document.createElement('span');
    emojiSpan.className = 'room-emoji';
    emojiSpan.innerHTML = `${room.icon_emoji}&nbsp;&nbsp;`;
    wrap.appendChild(emojiSpan);
    td.__emoji = emojiSpan;
  } else {
    // If no emoji, still create the span for consistent structure
    const emojiSpan = document.createElement('span');
    emojiSpan.className = 'room-emoji';
    emojiSpan.innerHTML = '';
    wrap.appendChild(emojiSpan);
    td.__emoji = emojiSpan;
  }

  const text = document.createElement('span');
  text.textContent = room.room_name || '';
  wrap.appendChild(text);

  td.appendChild(wrap);

  // refs for realtime/inline updates
  td.__colorDot = dot; // may be null when showDot === false
  // td.__emoji is set above
}

function attachInlineStyleEditor(cell, rowEl, room, site, isTimeBasedSite, timeSlot) {
  // remove prior editor if present
  const existing = cell.querySelector('.room-inline-editor');
  if (existing) existing.remove();

  const editor = document.createElement('div');
  editor.className = 'room-inline-editor';

  // Color input
  const colorLabel = document.createElement('label');
  colorLabel.style.display = 'flex';
  colorLabel.style.alignItems = 'center';
  colorLabel.style.gap = '6px';
  const colorSpan = document.createElement('span');
  colorSpan.textContent = 'Color';
  colorSpan.style.minWidth = '44px';
  colorSpan.style.color = '#555';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'room-color-picker';
  // Prefill using DB value or default mapping (e.g., Art Room → red)
  const stylePrefill = computeRoomStyle(room);
  const normalized = normalizeToHex6(stylePrefill.color_hex) || '#ffffff';
  colorInput.value = normalized;
  colorLabel.appendChild(colorSpan);
  colorLabel.appendChild(colorInput);

  // Emoji input
  const emojiLabel = document.createElement('label');
  emojiLabel.style.display = 'flex';
  emojiLabel.style.alignItems = 'center';
  emojiLabel.style.gap = '6px';
  const emojiSpan = document.createElement('span');
  emojiSpan.textContent = 'Icon';
  emojiSpan.style.minWidth = '44px';
  emojiSpan.style.color = '#555';
  const emojiInput = document.createElement('input');
  emojiInput.type = 'text';
  emojiInput.className = 'room-icon-select';
  emojiInput.placeholder = 'Emoji (e.g., 🏀)';
  emojiInput.value = (computeRoomStyle(room).icon_emoji) || '';
  emojiLabel.appendChild(emojiSpan);
  emojiLabel.appendChild(emojiInput);

  const spacer = document.createElement('span');
  spacer.style.flex = '1';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.className = 'nav-button save-room-style';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.className = 'nav-button cancel-room-style';

  editor.appendChild(colorLabel);
  editor.appendChild(emojiLabel);
  editor.appendChild(spacer);
  editor.appendChild(saveBtn);
  editor.appendChild(cancelBtn);
  cell.appendChild(editor);

  cancelBtn.addEventListener('click', () => editor.remove());

  saveBtn.addEventListener('click', async () => {
    // normalize color
    let color_hex = colorInput.value && colorInput.value.trim();
    if (color_hex && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color_hex)) {
      showToast('Invalid color. Use hex like #FFAA00.', 'error');
      return;
    }
    if (color_hex && /^#([0-9a-f]{3})$/i.test(color_hex)) {
      const r = color_hex[1], g = color_hex[2], b = color_hex[3];
      color_hex = `#${r}${r}${g}${g}${b}${b}`;
    }
    let icon_emoji = (emojiInput.value || '').trim();
    if (icon_emoji === '') icon_emoji = null;
    if (color_hex === '' || color_hex === '#ffffff') color_hex = null; // treat white as unset
    if (color_hex && color_hex.startsWith('#')) color_hex = color_hex.slice(1);

    try {
      let up = supabase
        .from('rooms')
        .update({ color_hex, icon_emoji })
        .eq('room_name', room.room_name)
        .eq('site', site);
      if (isTimeBasedSite) up = up.eq('time_slot', timeSlot); else up = up.is('time_slot', null);
      const { error } = await up;
      if (error) throw error;

      // Update UI without reloading whole table
      const nameCell = rowEl.children[0];
      if (nameCell) {
        const applied = computeRoomStyle({ room_name: room.room_name, color_hex, icon_emoji });
        if (nameCell.__colorDot) {
          const hex = applied.color_hex ? String(applied.color_hex).trim() : '';
          nameCell.__colorDot.style.background = hex ? (hex.startsWith('#') ? hex : `#${hex}`) : '';
        }
        if (nameCell.__emoji) nameCell.__emoji.textContent = applied.icon_emoji || '';
      }

      showToast('Room style saved', 'success');
      roomsCache.clear(); // ensure future loads reflect new color/icon immediately
      editor.remove();
    } catch (e) {
      console.error('Style save failed:', e);
      showToast('Failed to save style', 'error');
    }
  });
}

// --- UPDATED: loadDashboard now takes an optional sessionKey ---
async function loadDashboard(sessionKey = activeSessionKey) {
  const roomTableName = "rooms";

  const roomTableBody = document.querySelector("#room-table tbody");

  // Get the selected site from localStorage filter
  // Get the selected site from localStorage (plain string)
  let site = getSelectedSite();
  site = normalizeSite(site); 

  setSessionTabsVisibilityFor(site);

  const isTimeBasedSite = ["Club Knights", "Kids Play", "Non-School Day"].includes(site);
  const timeSlot = sessionKeyToTimeSlot(sessionKey);

let roomQuery = supabase
  .from("rooms")
  .select("*")
  .eq("site", site)
  .eq("active", true);

if (isTimeBasedSite) {
  roomQuery = roomQuery.eq("time_slot", timeSlot);
} else {
  roomQuery = roomQuery.is("time_slot", null);
  // keep actions column visibility in sync
  const manageToggleEl2 = document.getElementById('manage-rooms');
  const roomTableEl2 = document.getElementById('room-table');
  if (roomTableEl2) roomTableEl2.classList.toggle('show-actions', !!manageToggleEl2?.checked);
}

const { data: rooms } = await roomQuery.order("room_name", { ascending: true });

  // Fetch students from master_roster for dashboard
  let students = [];
  let studentFetchError = null;
  try {
    let studentsQuery = supabase
      .from("master_roster")
      .select("assigned_room, assigned_session")
      .eq("site", site);
    if (isTimeBasedSite) {
      studentsQuery = studentsQuery.eq('assigned_session', timeSlot);
    } else {
      studentsQuery = studentsQuery.is('assigned_session', null);
    }
    const res = await studentsQuery;
    students = res.data || [];
    studentFetchError = res.error || null;

    if (studentFetchError && studentFetchError.code === "42703") {
      const res2 = await supabase
        .from("master_roster")
        .select("assigned_room")
        .eq("site", site);
      students = res2.data || [];
      studentFetchError = res2.error || null;
      console.warn("[loadDashboard] assigned_session missing; fell back to site-only counts.");
    }
  } catch (err) {
    studentFetchError = err;
  }

    if (studentFetchError) {
    console.error("Error fetching students from Supabase:", studentFetchError);
    return;
    }
    if (!Array.isArray(students)) {
      console.error("Students fetch returned null or unexpected format");
      return;
    }


    // Single source of truth for the table:
    await loadRoomsForSite(site);
    // Then refresh the summary/counts smoothly without redrawing rows
    updateRoomCountsInPlace();
    return;

    if (room.capacity === 0) row.classList.add("closed-room");

    const capacityInput = document.createElement("input");
    capacityInput.type = "number";
    capacityInput.style.width = "60px";
    capacityInput.style.padding = "6px";
    capacityInput.style.borderRadius = "6px";
    capacityInput.style.border = "1px solid #ccc";
    capacityInput.style.fontSize = "14px";
    capacityInput.style.boxShadow = "inset 0 1px 3px rgba(0, 0, 0, 0.1)";
    capacityInput.addEventListener("change", async () => {
      const newCapacity = parseInt(capacityInput.value);
      if (!isNaN(newCapacity) && newCapacity >= 0) {
        console.log(`Updating capacity for ${room.room_name} to ${newCapacity}`);
        const currentRoomTableName = "rooms"; // Use the global variable
        let upd = supabase
          .from(currentRoomTableName)
          .update({ capacity: newCapacity })
          .eq('room_name', room.room_name)
          .eq('site', site);
        if (isTimeBasedSite) {
          upd = upd.eq('time_slot', timeSlot);
        } else {
          upd = upd.is('time_slot', null);
        }
        const { error } = await upd;
        if (error) {
          alert("Failed to update capacity.");
          console.error(error);
        } else {
          capacityInput.value = newCapacity;
          capacityInput.style.backgroundColor = "#d4edda";
          setTimeout(() => {
            capacityInput.style.backgroundColor = "";
          }, 1000);
          // Realtime subscription will handle the UI update now
        }
      } else {
        alert("Please enter a valid non-negative number.");
        capacityInput.value = room.capacity != null ? room.capacity : 0;
      }
    });

    row.innerHTML = `
      <td>${room.room_name}</td>
      <td></td>
      <td></td>
    `;
    row.children[2].appendChild(capacityInput);
    document.querySelector("#room-table tbody").appendChild(row);

    if (room.capacity === 0) row.classList.add("closed-room");
    else row.classList.remove("closed-room");

    const capacityValue = room.capacity != null ? room.capacity : 0;
    row.children[0].textContent = room.room_name;
    row.children[1].textContent = assignedCount;
    capacityInput.value = capacityValue;

    row.classList.remove("full-room", "near-full-room");
    if (capacityValue > 0 && assignedCount >= capacityValue) {
      row.classList.add("full-room");
    } else if (capacityValue > 1 && assignedCount >= capacityValue - 1) {
      row.classList.add("near-full-room");
    }
  };


// --- Auto-reset student room assignments at 11:59 PM ---
function scheduleDailyReset() {
  const now = new Date();
  const resetTime = new Date();
  resetTime.setHours(23, 59, 0, 0); // 11:59 PM today

  if (now > resetTime) {
    resetTime.setDate(resetTime.getDate() + 1);
  }

  const timeoutDuration = resetTime - now;
  setTimeout(async () => {
    // Reset the user's manual selection flag at midnight
    userManuallySelected = false;
    scheduleDailyReset();
  }, timeoutDuration);
}

scheduleDailyReset();

// --- Session tabbed controls setup ---
window.addEventListener("DOMContentLoaded", async () => {
  let navBar = document.getElementById("nav-bar");
  if (!navBar) {
    navBar = document.createElement("div");
    navBar.id = "nav-bar";
    document.body.insertBefore(navBar, document.body.firstChild);
  }
  navBar.classList.add('top-nav');

  const sessionTabs = document.querySelectorAll(".session-tab");
  const sessionWrapper = sessionTabs[0]?.parentElement;
  if (sessionWrapper) {
    sessionWrapper.classList.add('session-bar');
    sessionWrapper.appendChild(clearCapacitiesBtn);
  }
  const sessionContainer = document.getElementById("session-container");

  // Devices panel controls
  const deviceSearch = document.getElementById('device-search');
  const refreshDevicesBtn = document.getElementById('refresh-devices');

  if (deviceSearch) {
    deviceSearch.addEventListener('input', () => {
      _devicesSearch = deviceSearch.value.trim();
      loadDevicesPanel();
    });
  }

  if (refreshDevicesBtn) {
    refreshDevicesBtn.addEventListener('click', () => loadDevicesPanel());
  }

  // Initial load of devices list
  loadDevicesPanel();

  // Ensure session tab visibility matches filter on boot
  // Get the selected site from localStorage (plain string)
  // Ensure session tab visibility matches filter on boot
  const siteOnBoot = getSelectedSite();
  if (siteOnBoot) setSessionTabsVisibilityFor(siteOnBoot);

  const devicesShowInactive = document.getElementById('devices-show-inactive');
  if (devicesShowInactive) {
    devicesShowInactive.addEventListener('change', () => loadDevicesPanel());
  }

  const devicesDetails = document.getElementById('devices-details');
  if (devicesDetails) {
    const k = 'devicesDetailsOpen';
    const saved = localStorage.getItem(k);
    if (saved !== null) devicesDetails.open = saved === 'true';
    devicesDetails.addEventListener('toggle', () => localStorage.setItem(k, String(devicesDetails.open)));
  }

  // Collapsed icon next to "Devices (iPads)" header (shows when closed)
  const collapseIcon = document.getElementById('devices-collapse-icon');
  function syncDevicesIcon() {
    if (!collapseIcon || !devicesDetails) return;
    collapseIcon.style.display = devicesDetails.open ? 'none' : 'inline';
  }
  syncDevicesIcon();
  if (devicesDetails) {
    devicesDetails.addEventListener('toggle', syncDevicesIcon);
  }


  // --- Resolve and show current device key next to the Devices header ---
  function getCookie(name){
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\\[\\]\\\\\\\\+^)/g,'\\$1') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function resolveDeviceKey() {
    try {
      const sp = new URLSearchParams(location.search);
      const fromUrl = sp.get('deviceKey') || sp.get('key');
      if (fromUrl) return fromUrl;
    } catch {}
    try {
      const ls = localStorage || null;
      const ss = sessionStorage || null;
      const candidates = [
        ls && ls.getItem('deviceKey'),
        ls && ls.getItem('device_key'),
        ls && ls.getItem('currentDeviceKey'),
        ls && ls.getItem('studentDeviceKey'),
        ss && ss.getItem('deviceKey'),
        ss && ss.getItem('device_key'),
        window.currentDeviceKey,
        window.deviceKey,
        getCookie('device_key')
      ].filter(Boolean);
      return candidates[0] || null;
    } catch {
      return window.currentDeviceKey || null;
    }
  }

  const resolvedKey = resolveDeviceKey();
  const keyEl = document.getElementById('current-device-key');
  if (keyEl) {
    keyEl.textContent = resolvedKey ? `Key: ${resolvedKey}` : 'Key: —';
    keyEl.title = resolvedKey ? 'Current device key detected from this browser' : 'No device key found in this browser';
  }

  const adminDlg = document.getElementById('device-admin-dialog');
  const adminClose = document.getElementById('device-admin-close');
  const adminCopy = document.getElementById('admin-copy-device-key');
  if (adminDlg && adminClose) {
    adminClose.addEventListener('click', () => adminDlg.style.display = 'none');
    adminDlg.addEventListener('click', (e) => { if (e.target === adminDlg) adminDlg.style.display = 'none'; });
  }
  if (adminCopy) {
    adminCopy.addEventListener('click', async () => {
      const v = document.getElementById('admin-info-device-key')?.textContent || '';
      try { await navigator.clipboard.writeText(v); showToast('Device key copied', 'success'); }
      catch { showToast('Copy failed', 'error'); }
    });
  }

  // Manage toggle: hide/show actions column via a class on the table (CSS handles visibility)
  const manageToggle = document.getElementById('manage-rooms');
  if (manageToggle) {
    const savedOn = localStorage.getItem(MANAGE_ROOMS_KEY);
    if (savedOn !== null) manageToggle.checked = savedOn === 'true';
  }
  const roomTableEl = document.getElementById('room-table');
  async function updateManageVisibility() {
    if (!roomTableEl) return;
    const on = !!manageToggle?.checked;
    localStorage.setItem(MANAGE_ROOMS_KEY, String(on));
    roomTableEl.classList.toggle('show-actions', on);

    // Rebuild rows so the Actions column gets inline editors when toggled ON
    const site = getSelectedSite();
    if (site) {
      roomsCache.clear(); // force a fresh fetch so color_hex/icon_emoji are present
      await loadRoomsForSite(site);
    }
    // After reload, ensure name cells re-render with/without color dot
    const rows = document.querySelectorAll('#room-table tbody tr');
    rows.forEach(tr => {
      const nameTd = tr.children[0];
      if (!nameTd) return;
      const roomName = nameTd.textContent?.trim() || '';
      const roomObj = Array.from(rows).map(r => r.children[0]?.textContent?.trim()).includes(roomName) ? null : null; // no-op placeholder
    });
  }
  if (manageToggle) {
    manageToggle.addEventListener('change', () => {
      // debounce to avoid double-renders on rapid clicks
      clearTimeout(window.__manageDebounce);
      window.__manageDebounce = setTimeout(() => {
        updateManageVisibility();
        ensureManageVisibilityClass();
      }, 50);
    });
    updateManageVisibility();
  }

  const { data: timesData, error: timesError } = await supabase
    .from('session_start_times')
    .select('session_key, start_time');

  if (timesError) {
    console.error("Error fetching session start times:", timesError);
    Object.assign(sessionData, {
      session1: { start: "05:55" },
      session2: { start: "08:55" },
      session3: { start: "12:55" },
      session4: { start: "14:55" },
    });
  } else if (timesData) {
    ['session1', 'session2', 'session3', 'session4'].forEach(key => sessionData[key] = {}); // reset cache
    timesData.forEach(item => {
      if (sessionData[item.session_key]) {
        sessionData[item.session_key].start = item.start_time.substring(0, 5);
      }
    });
  }
  // Ensure a default start time for standard (non–time-based) sites
  // We will display 13:45 (1:45 PM) in the chip whenever a standard site is active.
  if (!sessionData.session3) sessionData.session3 = {};
  if (!sessionData.session3.start) sessionData.session3.start = '13:45';

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  
  // Replace the entire renderSession function with this new version
  async function renderSession(sessionKey) {
    window.renderSession = renderSession;
    const session = sessionData[sessionKey] || {};

    // Get the selected site from localStorage filter
    // Get the selected site from localStorage (plain string)
    const site = getSelectedSite();
    if (site) setSessionTabsVisibilityFor(site);

    // Fetch students and rooms from master_roster and rooms table for the given site
    const isTimeBasedSiteRS = ["Club Knights", "Kids Play", "Non-School Day"].includes(site);
    const timeSlotRS = sessionKeyToTimeSlot(sessionKey);
    // For standard sites, use editable per-site time stored in localStorage (default 13:45)
    const displayStart = isTimeBasedSiteRS ? (session.start || '00:00') : getStandardSiteTime(site);

    let currentStudents = [];
    let studentsError = null;

    // Session-agnostic student load: scope only by site/summer_site/NSD; exclude Gone/Activity
    try {
      const scope = getSiteScope();
      let studentsQ = supabase
        .from('master_roster')
        .select('assigned_room, is_gone');
      if (scope.column === 'non_school_day') {
        studentsQ = studentsQ.eq('non_school_day', true);
      } else {
        studentsQ = studentsQ.eq(scope.column, scope.value);
      }
      // exclude gone students
      studentsQ = studentsQ.or('is_gone.is.null,is_gone.eq.false');

      const res = await studentsQ;
      currentStudents = res.data || [];
      studentsError = res.error || null;
    } catch (err) {
      studentsError = err;
    }

    // Time-slot aware rooms query
    const isTimeBasedSite = ["Club Knights", "Kids Play", "Non-School Day"].includes(site);
    const timeSlot = sessionKeyToTimeSlot(sessionKey);
    let roomQ = supabase.from('rooms')
      .select('room_name, capacity')
      .eq('site', site)
      .eq('active', true);
    if (isTimeBasedSite) {
      roomQ = roomQ.eq('time_slot', timeSlot);
    } else {
      roomQ = roomQ.is('time_slot', null);
    }
    const { data: roomData, error: roomDataError } = await roomQ.order('room_name');

    if (studentsError) {
      console.error("Error fetching students for session render:", studentsError);
      sessionContainer.innerHTML = `<div style="padding: 10px; font-size: 16px; color: #cc0000;">Error loading student data.</div>`;
      return;
    }
    if (roomDataError || !roomData) {
      console.error("Error fetching room data for session render:", roomDataError);
      sessionContainer.innerHTML = `<div style="padding: 10px; font-size: 16px; color: #cc0000;">Error loading room data.</div>`;
      return;
    }

    const filteredRooms = roomData.filter(r => {
      const name = r.room_name.trim().toLowerCase();
      return name !== "gone" && name !== "activity in building";
    });

    // Defensive alpha sort for display
    filteredRooms.sort((a, b) => (a.room_name || '').localeCompare(b.room_name || ''));

    const totalCapacity = filteredRooms.reduce((sum, r) => sum + (r.capacity || 0), 0);

    const totalStudentsAssigned = (currentStudents || []).filter(s => {
      const ar = (s.assigned_room || '').toLowerCase();
      return ar && ar !== 'gone' && ar !== 'activity in building';
    }).length;

    // Preserve the live site dropdown before rewriting the chip
    detachSiteDropdownFromChip();
    const html = `
      <div class="summary-card">
        <div class="summary-row">
          <label class="summary-item summary-pill time-edit">
            <span class="summary-label">Start Time:</span>
            <input type="time" value="${escapeHtml(displayStart)}" id="session-start-time-${sessionKey}" class="summary-time-input" />
          </label>
          <div class="summary-item summary-pill">
            <span class="summary-title">Total Students (current):</span>
            <span id="total-students-count" class="summary-value">${totalStudentsAssigned}</span>
          </div>
          <div class="summary-item summary-pill">
            <span class="summary-title">Total Max Count:</span>
            <span id="total-capacity-count" class="summary-value">${totalCapacity}</span>
          </div>
        </div>
      </div>
    `;
    sessionContainer.innerHTML = html;
    // Move the existing "Site" dropdown into the summary card so it sits with the start time + counts
    placeSiteDropdownInChip();

    const timeInput = document.getElementById(`session-start-time-${sessionKey}`);
    if (timeInput) {
      timeInput.addEventListener('change', async (event) => {
        const newTime = event.target.value;
        const confirmed = confirm(`⚠️ Are you sure you want to change the start time to ${newTime}?`);
        if (!confirmed) {
          // revert to current values
          event.target.value = isTimeBasedSiteRS ? (sessionData[sessionKey].start) : getStandardSiteTime(site);
          return;
        }

        if (isTimeBasedSiteRS) {
          // Time-controlled sites persist to session_start_times (global per session key)
          const { error } = await supabase
            .from('session_start_times')
            .update({ start_time: newTime })
            .eq('session_key', sessionKey);

          if (error) {
            console.error('Error updating session start time:', error);
            showToast('Failed to save start time.', 'error');
            event.target.value = sessionData[sessionKey].start;
          } else {
            sessionData[sessionKey].start = newTime;
            showToast('Start time updated.', 'success');
            checkAndSwitchSession();
          }
        } else {
          // STANDARD sites persist locally per site (no sessions)
          setStandardSiteTime(site, newTime);
          showToast('Start time saved for this site.', 'success');
        }
      });
    }
  }

  function highlightActiveSession(sessionKey) {
    const sessionTabs = document.querySelectorAll('.session-tab');
    sessionTabs.forEach(b => b.classList.remove('active'));
    const tab = document.querySelector(`.session-tab[data-session="${sessionKey}"]`);
    if (tab) tab.classList.add('active');
  }

  let tabClickTimer;
  sessionTabs.forEach(btn => {
    btn.addEventListener("click", async () => {
      if (tabClickTimer) clearTimeout(tabClickTimer);
      tabClickTimer = setTimeout(async () => {
        userManuallySelected = true;
        activeSessionKey = btn.dataset.session;

        highlightActiveSession(activeSessionKey);
        await renderSession(activeSessionKey);

        const currentSite = getSelectedSite();
          if (currentSite) {
            await loadRoomsForSite(currentSite);
            // Ensure actions col follows the toggle immediately after re-render
            updateManageVisibility();
          }
          loadDashboard();
      }, 75);
    });
  });

  async function checkAndSwitchSession() {
    // Only auto-switch if the user hasn't manually selected a session
    if (userManuallySelected) {
      return;
    }
    
    const now = new Date();
    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

    const getMinutes = time => {
      const [h, m] = time.split(':').map(Number);
      return h * 60 + m;
    };

    const currentMinutes = getMinutes(currentTime);

    const sessionStartTimes = {
      session1: getMinutes(sessionData.session1.start),
      session2: getMinutes(sessionData.session2.start),
      session3: getMinutes(sessionData.session3.start),
      session4: getMinutes(sessionData.session4.start),
    };

    let scheduledSession = "session4";
    if (currentMinutes >= sessionStartTimes.session1 && currentMinutes < sessionStartTimes.session2) {
      scheduledSession = "session1";
    } else if (currentMinutes >= sessionStartTimes.session2 && currentMinutes < sessionStartTimes.session3) {
      scheduledSession = "session2";
    } else if (currentMinutes >= sessionStartTimes.session3 && currentMinutes < sessionStartTimes.session4) {
      scheduledSession = "session3";
    } else if (currentMinutes >= sessionStartTimes.session4 || currentMinutes < sessionStartTimes.session1) {
      scheduledSession = "session4";
    }

    if (activeSessionKey !== scheduledSession) {
      activeSessionKey = scheduledSession;
      highlightActiveSession(activeSessionKey);
      await renderSession(activeSessionKey);
      loadDashboard();
      const currentSite = getSelectedSite();
      if (currentSite) await loadRoomsForSite(currentSite);
    }
  }

  // --- Supabase Realtime Subscription ---
  supabase
    .channel('dashboard_updates')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'master_roster' }, (payload) => {
      try {
        applyRosterDelta(payload);
      } catch (e) {
        console.warn('[roster delta] fallback refresh', e);
        rtRefreshSoon(() => updateRoomCountsInPlace());
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'session_start_times' }, (payload) => {
      console.log('Realtime update detected from session_start_times table. Checking for switch...');
      const newTime = payload.new.start_time.substring(0, 5);
      const sessionKey = payload.new.session_key;
      sessionData[sessionKey].start = newTime;
      checkAndSwitchSession();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_roster_filters' }, () => {
      // Live refresh when a device is renamed or filter is changed elsewhere
      loadDevicesPanel();
    })
    // Rooms realtime: keep table in sync without flashing
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, async (payload) => {
      const currentSite = getSelectedSite();
      if (!currentSite) return;

      const row = payload?.new || payload?.old;
      if (!row || row.site !== currentSite) return;

      const isTimeBased = ["Club Knights", "Kids Play", "Non-School Day"].includes(currentSite);
      const ts = sessionKeyToTimeSlot(activeSessionKey);
      const rowTS = row.time_slot || null;
      const matchesSlot = isTimeBased ? rowTS === ts : rowTS == null;
      if (!matchesSlot) return;

      const structural =
        payload.eventType === 'INSERT' ||
        payload.eventType === 'DELETE' ||
        (payload.eventType === 'UPDATE' && payload.old?.active !== payload.new?.active) ||
        (payload.eventType === 'UPDATE' && (payload.old?.room_name !== payload.new?.room_name));

      if (structural) {
        roomsCache.clear(); // structural change → invalidate cached room lists
        await loadRoomsForSite(currentSite); // rebuild rows for adds/removes/renames/active toggles
        ensureManageVisibilityClass();
        updateRoomCountsInPlace();           // refresh counts quickly after rebuild
        const mt = document.getElementById('manage-rooms');
        const rt = document.getElementById('room-table');
        if (rt) rt.classList.toggle('show-actions', !!mt?.checked);
        return;
      }

      // Capacity-only or style-only change for a visible row: update inline
      const rowEl = rowCache.get((row.room_name || '').toString().trim().toLowerCase());
      if (rowEl && rowEl.isConnected) {
        const capInput = rowEl.querySelector('input[type="number"]');
        if (typeof row.capacity !== 'undefined' && capInput) capInput.value = row.capacity ?? 0;

        const nameCell = rowEl.children[0];
        if (nameCell) {
          const applied = computeRoomStyle({
            room_name: row.room_name,
            color_hex: row.color_hex,
            icon_emoji: row.icon_emoji,
          });
          if (nameCell.__colorDot) {
            const hex = applied.color_hex ? String(applied.color_hex).trim() : '';
            nameCell.__colorDot.style.background = hex ? (hex.startsWith('#') ? hex : `#${hex}`) : '';
          }
          if (nameCell.__emoji) {
            nameCell.__emoji.textContent = applied.icon_emoji || '';
          }
        }

        const assigned = parseInt(rowEl.children[1]?.textContent || '0', 10) || 0;
        rowEl.classList.remove('full-room', 'near-full-room', 'closed-room');
        const cap = row.capacity || 0;
        if (cap === 0) rowEl.classList.add('closed-room');
        else if (assigned >= cap) rowEl.classList.add('full-room');
        else if (cap > 1 && assigned >= cap - 1) rowEl.classList.add('near-full-room');

        const inputs = document.querySelectorAll('#room-table tbody input[type="number"]');
        let totalCap = 0; inputs.forEach(i => totalCap += (parseInt(i.value, 10) || 0));
        const studentsSum = Array.from(document.querySelectorAll('#room-table tbody tr td:nth-child(2)'))
          .reduce((acc, td) => acc + (parseInt(td.textContent, 10) || 0), 0);
        updateSummaryCounts(studentsSum, totalCap);
      } else {
        await loadRoomsForSite(currentSite);
        document.getElementById('room-table')?.classList
          .toggle('show-actions', !!document.getElementById('manage-rooms')?.checked);
        updateRoomCountsInPlace();
      }
    })
    // --- Legacy: listen for changes to the old students table for dashboard updates ---
    .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, () => {
      // Legacy path: some UIs may still update the old students table
      rtRefreshSoon(() => {
        updateRoomCountsInPlace();
      });
    })
    .subscribe();

  // Fallback: periodic refresh of counts (every 1.5s, only when visible)
  if (!window.__dashboardRefreshInterval) {
    window.__dashboardRefreshInterval = setInterval(async () => {
      if (document.hidden) return;
      await updateRoomCountsInPlace();
    }, 1500);
    // Immediately refresh counts when tab regains focus
    window.addEventListener('focus', () => {
      updateRoomCountsInPlace();
    });
  }

  // --- Start the dashboard ---
  activeSessionKey = "session1";
  highlightActiveSession(activeSessionKey);
  await renderSession(activeSessionKey);
  loadDashboard();
  // Prime counts once the table exists
  updateRoomCountsInPlace();

  // Ensure manage visibility class applied after first paint
  const _mt = document.getElementById('manage-rooms');
  const _rt = document.getElementById('room-table');
  if (_rt) _rt.classList.toggle('show-actions', !!_mt?.checked);

  // Check for auto-switch every minute after the initial load
  setInterval(checkAndSwitchSession, 60000);
});

// --- Student List Filter Dropdown Logic (for index.html coordination) ---
const studentListDropdown = document.getElementById('student-list-dropdown');
if (studentListDropdown) {
  // On DOMContentLoaded, restore saved site from localStorage and trigger dashboard refresh if present
  document.addEventListener('DOMContentLoaded', () => {
    let siteValue = getSelectedSite();
    const dropdown = document.getElementById('student-list-dropdown');
    const dropdownEl = dropdown;
    if (!siteValue && dropdownEl && dropdownEl.value) {
      siteValue = normalizeSite(dropdownEl.value);
      setSelectedSite(siteValue);
    }
    if (!dropdown || !siteValue) return;

    // Try direct value match first
    let matched = Array.from(dropdown.options).some(o => (o.value === siteValue));
    if (!matched) {
      // Try matching by visible label text
      const byLabel = Array.from(dropdown.options).find(o => (o.textContent || '').trim() === siteValue);
      if (byLabel) {
        byLabel.selected = true;
        matched = true;
      }
    } else {
      dropdown.value = siteValue;
    }

    // Last resort: normalize each option value and compare
    if (!matched) {
      const nVal = normalizeSite(siteValue);
      const byNorm = Array.from(dropdown.options)
        .find(o => normalizeSite(o.value) === nVal || (o.textContent || '').trim() === nVal);
      if (byNorm) byNorm.selected = true;
    }

    const restoredSite = getSelectedSite();
    setSessionTabsVisibilityFor(restoredSite);
    if (typeof window.renderSession === 'function') window.renderSession(activeSessionKey);
    loadRoomsForSite(restoredSite);
    // Prime live counts immediately after loading rooms
    updateRoomCountsInPlace();
    placeSiteDropdownInChip();
    if (typeof updateSessionHeader === 'function') updateSessionHeader(restoredSite);
  });

  // On dropdown change, save to localStorage and refresh dashboard for new site
  studentListDropdown.addEventListener('change', function () {
    const selectedSite = normalizeSite(this.value);
    setSelectedSite(selectedSite);
    // Update session tabs visibility immediately based on new site
    setSessionTabsVisibilityFor(selectedSite);
    // Re-render session chip and rooms list for the new site
    if (typeof window.renderSession === 'function') window.renderSession(activeSessionKey);
    loadRoomsForSite(selectedSite);
    // Refresh counts right away after loading rooms for new site
    updateRoomCountsInPlace();
    if (typeof updateSessionHeader === 'function') updateSessionHeader(selectedSite);
  });
}

// Dynamically load rooms based on the selected site
async function loadRoomsForSite(site) {
  site = normalizeSite(site);
  const isTimeBasedSite = ["Club Knights", "Kids Play", "Non-School Day"].includes(site);
  const timeSlot = sessionKeyToTimeSlot(activeSessionKey);
  ensureManageVisibilityClass();

  const myToken = ++loadRoomsToken;

  // 1) Light loading state + read "show inactive" toggle
  const roomTableBody = document.querySelector("#room-table tbody");
  if (roomTableBody) {
    roomTableBody.innerHTML = '<tr class="loading-row"><td colspan="4">Loading rooms…</td></tr>';
  }
  const showInactive = !!document.getElementById('show-inactive')?.checked;
  const key = makeKey(site, isTimeBasedSite ? timeSlot : null, showInactive);

  let rooms = getCached(roomsCache, key);
  let students = getCached(studentsCache, site);

  if (!rooms || !students) {
    let rq = supabase
    .from('rooms')
    .select('room_name, capacity, active, time_slot, color_hex, icon_emoji, site')
    .eq('site', site);
    if (!showInactive) rq = rq.eq('active', true);
    if (isTimeBasedSite) rq = rq.eq('time_slot', timeSlot); else rq = rq.is('time_slot', null);

    const roomsPromise = rq.order('room_name');
    let studentsScopeQ = supabase.from('master_roster')
      .select('assigned_room, site, summer_site, non_school_day, is_gone');
    const scope = getSiteScope();
    if (scope.column === 'non_school_day') {
      studentsScopeQ = studentsScopeQ.eq('non_school_day', true);
    } else {
      studentsScopeQ = studentsScopeQ.eq(scope.column, scope.value);
    }
    // exclude gone students from counts
    studentsScopeQ = studentsScopeQ.or('is_gone.is.null,is_gone.eq.false');
    const studentsPromise = studentsScopeQ;

    const [roomsRes, studentsRes] = await Promise.all([roomsPromise, studentsPromise]);
    if (myToken !== loadRoomsToken) return; // stale render guard

    if (roomsRes.error) { console.error('Error loading rooms:', roomsRes.error); if (roomTableBody) roomTableBody.style.opacity = '1'; return; }
    if (studentsRes.error) { console.error('Error loading students:', studentsRes.error); if (roomTableBody) roomTableBody.style.opacity = '1'; return; }

    rooms = roomsRes.data || [];
    students = studentsRes.data || [];

    setCached(roomsCache, key, rooms);
    setCached(studentsCache, site, students);
  }

  // Ensure alpha order regardless of backend/order state
  if (Array.isArray(rooms)) {
    rooms.sort(compareRoomNames);
  }
  // Merge DB values with defaults for color/icon so UI shows styling even when DB is null
  const roomsStyled = (Array.isArray(rooms) ? rooms : []).map(r => {
    const styled = computeRoomStyle(r);
    return { ...r, ...styled };
  });

  // 4) Build rows in a fragment (smooth swap)
  const frag = document.createDocumentFragment();
  rowCache.clear();

  (roomsStyled || []).forEach((room) => {
    const rn = (room.room_name || '').toString().trim().toLowerCase();
    const assignedCount = (students || []).filter(s => (s.assigned_room || '').toString().trim().toLowerCase() === rn).length;

    const row = document.createElement('tr');
    rowCache.set((room.room_name || '').toString().trim().toLowerCase(), row);

    if (room.capacity === 0) row.classList.add('closed-room');

    // Prebuild cells so we can render custom content in name/actions
    const nameCell = document.createElement('td');
    const countCell = document.createElement('td');
    const capCell = document.createElement('td');
    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';

    // Name cell with color dot + emoji
    const manageOn = !!document.getElementById('manage-rooms')?.checked;
    renderRoomNameCell(nameCell, room, { showDot: manageOn });

    // Count cell
    countCell.textContent = String(assignedCount);

    // Capacity input
    const capacityInput = document.createElement('input');
    capacityInput.type = 'number';
    capacityInput.value = room.capacity ?? 0;
    capacityInput.style.width = '60px';
    capacityInput.style.padding = '6px';
    capacityInput.style.borderRadius = '6px';
    capacityInput.style.border = '1px solid #ccc';
    capacityInput.style.fontSize = '14px';
    capacityInput.style.boxShadow = 'inset 0 1px 3px rgba(0, 0, 0, 0.1)';

    capacityInput.addEventListener('change', async () => {
      const newCapacity = parseInt(capacityInput.value);
      if (!isNaN(newCapacity) && newCapacity >= 0) {
        let up = supabase
          .from('rooms')
          .update({ capacity: newCapacity })
          .eq('room_name', room.room_name)
          .eq('site', site);
        if (isTimeBasedSite) up = up.eq('time_slot', timeSlot); else up = up.is('time_slot', null);
        const { error } = await up;
        if (error) {
          showToast('Failed to update capacity.', 'error');
          console.error(error);
          capacityInput.value = room.capacity ?? 0;
        } else {
          capacityInput.style.backgroundColor = '#d4edda';
          setTimeout(() => { capacityInput.style.backgroundColor = ''; }, 1000);
        }
      } else {
        showToast('Please enter a valid non-negative number.', 'error');
        capacityInput.value = room.capacity ?? 0;
      }
    });

    capCell.appendChild(capacityInput);

    // Actions: inline style editor (Manage on) + Delete/Restore button
    const isInactive = room.active === false;
    const manageToggleEl = document.getElementById('manage-rooms');
    if (manageToggleEl?.checked) {
      attachInlineStyleEditor(actionsCell, row, room, site, isTimeBasedSite, timeSlot);
    }

    const actBtn = document.createElement('button');
    actBtn.textContent = isInactive ? 'Restore' : 'Delete';
    actBtn.className = isInactive ? 'rm-action-btn rm-restore' : 'rm-action-btn rm-delete';

    const protect = (room.room_name || '').toLowerCase();
    const protectedName = protect === 'gone' || protect === 'activity in building';
    if (protectedName && !isInactive) {
      actBtn.disabled = true;
      actBtn.title = 'This room cannot be deleted';
    }

    actBtn.addEventListener('click', async () => {
      try {
        let up = supabase.from('rooms')
          .update({ active: isInactive ? true : false })
          .eq('room_name', room.room_name)
          .eq('site', site);
        if (isTimeBasedSite) up = up.eq('time_slot', timeSlot); else up = up.is('time_slot', null);
        const { error: delErr } = await up;
        if (delErr) throw delErr;
        showToast(isInactive ? 'Room restored.' : 'Room deleted.', isInactive ? 'success' : 'info');
        await loadRoomsForSite(site);
      } catch (err) {
        console.error('Room toggle active failed:', err);
        showToast('Failed to update room.', 'error');
      }
    });

    actionsCell.appendChild(actBtn);

    // Assemble row
    row.appendChild(nameCell);
    row.appendChild(countCell);
    row.appendChild(capCell);
    row.appendChild(actionsCell);
    frag.appendChild(row);
  });

  // 5) Swap tbody in one shot (smoother), then end loading
  if (myToken !== loadRoomsToken) return; // another load started; abort stale
  if (roomTableBody) {
    // Defensive alpha sort for rooms (in case DB order changes)
    if (Array.isArray(rooms)) {
      rooms.sort(compareRoomNames);
    }
    roomTableBody.innerHTML = '';
    roomTableBody.appendChild(frag);
    // Re-sync manage visibility after DOM swap (covers first load & fast switches)
    ensureManageVisibilityClass();
    // Ensure name cells reflect Manage state (show color dot only when Manage is ON)
    const manageOnAfter = !!document.getElementById('manage-rooms')?.checked;
    const rows = document.querySelectorAll('#room-table tbody tr');
    rows.forEach(tr => {
      const nameTd = tr.children[0];
      if (!nameTd) return;
      const roomName = nameTd.textContent?.trim() || '';
      const roomObj = (Array.isArray(roomsStyled) ? roomsStyled : []).find(r => r.room_name === roomName) || { room_name: roomName, color_hex: null, icon_emoji: '' };
      renderRoomNameCell(nameTd, roomObj, { showDot: manageOnAfter });
    });
    // Important: do NOT call renderSession/loadDashboard here; callers handle that when needed.
  }
}
