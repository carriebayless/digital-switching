// Supabase client initialization
const supabaseUrl = "https://bhfgcmknhrilmevclmye.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJoZmdjbWtuaHJpbG1ldmNsbXllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTMyNzM2ODMsImV4cCI6MjA2ODg0OTY4M30.1jWsjTGwhrcHeQrLritZODyaEl98vWRmNq0_slSMEzk";
const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);

document.addEventListener('DOMContentLoaded', () => {
  const tableContainer = document.getElementById('roster-table-container');
  let isEditing = false;
  let currentFilteredStudents = [];
  let columnFilters = { site: '', summer_site: '', non_school_day: '' };
  let newStudentRow = null;
  let KGROUPS_COL = 'kgroups';

  /**
   * Render the roster table, including filtering, editing, adding, deleting, and buttons.
   */
  async function renderRosterTable() {
    // Show/hide edit controls based on isEditing state
    const editControls = document.getElementById('edit-controls');
    const addStudentBtn = document.getElementById('add-student-btn');
    const editStudentsBtn = document.getElementById('edit-students-btn');
    if (isEditing) {
      editControls.style.display = 'block';
      addStudentBtn.style.display = 'inline-block';
      editStudentsBtn.style.display = 'none';
    } else {
      editControls.style.display = 'none';
      addStudentBtn.style.display = 'none';
      editStudentsBtn.style.display = 'inline-block';
    }

    // Show loading message
    tableContainer.innerHTML = '<div class="loading-message">Loading student roster...</div>';

    // Build Supabase query and apply filters
    let query = supabaseClient.from('master_roster').select('*')
      .order('site', { ascending: true })
      .order('grade', { ascending: true })
      .order('firstname', { ascending: true })
      .order('lastname', { ascending: true });
    if (columnFilters.site && columnFilters.site !== 'all') query = query.eq('site', columnFilters.site);
    if (columnFilters.summer_site && columnFilters.summer_site !== 'all') query = query.eq('summer_site', columnFilters.summer_site);
    if (columnFilters.non_school_day && columnFilters.non_school_day !== 'all') query = query.eq('non_school_day', columnFilters.non_school_day === 'yes');

    const { data: students, error } = await query;
    if (error) {
      tableContainer.innerHTML = `<div style="color:red;">Error loading students: ${error.message}</div>`;
      return;
    }
    if (!students || students.length === 0) {
      tableContainer.innerHTML = '<div>No students found for selected filters.</div>';
      return;
    }
    currentFilteredStudents = students;
    if (students.length) {
      if (students[0].kgroups === undefined && students[0].k_groups !== undefined) {
        KGROUPS_COL = 'k_groups';
      } else if (students[0].kgroups === undefined && students[0].kgroup !== undefined) {
        KGROUPS_COL = 'kgroup';
      } else {
        KGROUPS_COL = 'kgroups';
      }
    }

    // Build unique options for dropdowns
    const siteOptions = [...new Set(students.map(s => s.site).filter(Boolean))];
    const summerSiteOptions = [...new Set(students.map(s => s.summer_site).filter(Boolean))];

    // Build HTML for table
    let html = `<table class="roster-table">
      <thead>
        <tr>
          <th data-field="name">Name</th>
          <th data-field="grade">Grade</th>
          <th data-field="kgroups">K Groups</th>
          <th data-field="site">Site <select id="filter-site" class="filter-select">
            <option value="all">All</option>
            ${siteOptions.map(s => `<option value="${s}" ${columnFilters.site === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select></th>
          <th data-field="summer_site">Summer Site <select id="filter-summer-site" class="filter-select">
            <option value="all">All</option>
            ${summerSiteOptions.map(s => `<option value="${s}" ${columnFilters.summer_site === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select></th>
          <th data-field="non_school_day">Non-School Day Care <select id="filter-nsd" class="filter-select">
            <option value="all">All</option>
            <option value="yes" ${columnFilters.non_school_day === 'yes' ? 'selected' : ''}>Yes</option>
            <option value="no" ${columnFilters.non_school_day === 'no' ? 'selected' : ''}>No</option>
          </select></th>
          ${isEditing ? '<th>Actions</th>' : ''}
        </tr>
      </thead>
      <tbody>`;

    // Render student rows
    // If adding a new student, render the new row at the top
    if (isEditing && newStudentRow) {
      html += renderEditRow(newStudentRow, siteOptions, true);
    }
    for (const student of students) {
      if (isEditing) {
        html += renderEditRow(student, siteOptions, false);
      } else {
        html += `<tr data-id="${student.id}">
          <td>${student.firstname} ${student.lastname}</td>
          <td>${student.grade ?? ''}</td>
          <td>${student[KGROUPS_COL] ?? ''}</td>
          <td>${student.site ?? ''}</td>
          <td>${student.summer_site ?? ''}</td>
          <td>${student.non_school_day ? 'Yes' : 'No'}</td>
        </tr>`;
      }
    }
    html += '</tbody></table>';
    tableContainer.innerHTML = html;

    // Attach filter listeners
    document.getElementById('filter-site').addEventListener('change', (e) => {
      columnFilters.site = e.target.value;
      renderRosterTable();
    });
    document.getElementById('filter-summer-site').addEventListener('change', (e) => {
      columnFilters.summer_site = e.target.value;
      renderRosterTable();
    });
    document.getElementById('filter-nsd').addEventListener('change', (e) => {
      columnFilters.non_school_day = e.target.value;
      renderRosterTable();
    });
        // Re-apply table preview if one exists
    if (bulkPreviewState) {
      applyBulkPreviewToTable(bulkPreviewState);
    }
  }

  /**
   * Render a row for editing/adding a student.
   * @param {Object} student Student row data (may be new or existing)
   * @param {Array} siteOptions List of site options
   * @param {Boolean} isNew Is this a new student row
   * @returns {string}
   */
  function renderEditRow(student, siteOptions, isNew) {
    const originalDataStr = btoa(unescape(encodeURIComponent(JSON.stringify(student))));
    return `<tr data-id="${isNew ? 'new' : student.id}" data-original="${originalDataStr}">
      <td>
        <input type="text" class="input-firstname input-name" value="${student.firstname ?? ''}" placeholder="First" required />
        <input type="text" class="input-lastname input-name" value="${student.lastname ?? ''}" placeholder="Last" required />
        <span class="error-message" style="color:red; font-size: 0.8em; display:none;">Required</span>
      </td>
      <td><select class="select-grade">
        <option value="">(none)</option>
        ${['K','1','2','3','4','5','6'].map(g => `<option value="${g}"${student.grade === g ? ' selected' : ''}>${g}</option>`).join('')}
      </select></td>
            </select></td>
      <td>
        <input type="text" class="input-kgroups" value="${student[KGROUPS_COL] ?? ''}" placeholder="e.g., Bears" />
      </td>
      <td><select class="select-site">
        <option value="">(none)</option>
        ${siteOptions.map(s => `<option value="${s}"${student.site === s ? ' selected' : ''}>${s}</option>`).join('')}
      </select></td>
      <td><select class="select-summer-site">
        <option value="">(none)</option>
        <option value="Kids Play"${student.summer_site === 'Kids Play' ? ' selected' : ''}>Kids Play</option>
        <option value="Club Knights"${student.summer_site === 'Club Knights' ? ' selected' : ''}>Club Knights</option>
      </select></td>
      <td><select class="select-nsd">
        <option value="">(none)</option>
        <option value="yes"${student.non_school_day ? ' selected' : ''}>Yes</option>
        <option value="no"${!student.non_school_day ? ' selected' : ''}>No</option>
      </select></td>
      <td>
        ${isNew ? `<button class="btn-cancel-new primary-action-btn" style="background-color:#dc3545;">Cancel</button>` : `<button class="btn-delete primary-action-btn" style="background-color:#dc3545;">Delete</button>`}
      </td>
    </tr>`;
  }

  /**
   * Validate the firstname and lastname inputs in the given row.
   * Shows or hides inline error messages accordingly.
   * @param {HTMLElement} row The table row element to validate
   * @returns {boolean} True if valid, false if invalid
   */
  function validateRowInputs(row) {
    let isValid = true;
    const inputs = row.querySelectorAll('input[required]');
    inputs.forEach(input => {
      const errorSpan = input.parentElement.querySelector('.error-message');
      if (!input.value.trim()) {
        errorSpan.style.display = 'inline';
        isValid = false;
      } else {
        errorSpan.style.display = 'none';
      }
    });
    return isValid;
  }

  /**
   * Save all changes (edits and additions) to Supabase.
   */
  async function saveChanges() {
    const rows = tableContainer.querySelectorAll('tbody tr');
    let allValid = true;
    rows.forEach(row => {
      if (!validateRowInputs(row)) {
        allValid = false;
      }
    });

    if (!allValid) {
      alert('Please fill in all required fields.');
      return;
    }

    const updates = [];
    const inserts = [];

    rows.forEach(row => {
      const id = row.getAttribute('data-id');

      if (id === 'new') {
        // For new students, EXCLUDE id from the insert object
        const insertObj = {
          firstname: row.querySelector('.input-firstname').value.trim(),
          lastname: row.querySelector('.input-lastname').value.trim(),
          grade: row.querySelector('.select-grade').value || null,
          [KGROUPS_COL]: row.querySelector('.input-kgroups')?.value?.trim() || null,
          site: row.querySelector('.select-site').value || null,
          summer_site: row.querySelector('.select-summer-site').value || null,
          non_school_day: row.querySelector('.select-nsd').value === 'yes'
        };
        inserts.push(insertObj);
      } else {
        // Use id for updates
        let originalData;
        try {
          originalData = JSON.parse(decodeURIComponent(escape(atob(row.getAttribute('data-original')))));
        } catch (err) {
          console.error('Error parsing data-original:', row.getAttribute('data-original'));
          alert('Error parsing original student data. Please reload the page and try again.');
          return;
        }
        const updatedStudentData = {
          id,
          firstname: row.querySelector('.input-firstname').value.trim(),
          lastname: row.querySelector('.input-lastname').value.trim(),
          grade: row.querySelector('.select-grade').value || null,
          [KGROUPS_COL]: row.querySelector('.input-kgroups')?.value?.trim() || null,
          site: row.querySelector('.select-site').value || null,
          summer_site: row.querySelector('.select-summer-site').value || null,
          non_school_day: row.querySelector('.select-nsd').value === 'yes',
        };
        // Only update if something has actually changed
        if (JSON.stringify(updatedStudentData) !== JSON.stringify({
          id,
          firstname: originalData.firstname ?? '',
          lastname: originalData.lastname ?? '',
          grade: originalData.grade ?? null,
          kgroups: originalData.kgroups ?? null,
          site: originalData.site ?? null,
          summer_site: originalData.summer_site ?? null,
          non_school_day: originalData.non_school_day ?? false
        })) {
          updates.push(updatedStudentData);
        }
      }
    });

    // Log the inserts before calling insert
    if (inserts.length > 0) {
      console.log('Inserting:', inserts);
    }

    try {
      if (inserts.length > 0) {
        const { error } = await supabaseClient.from('master_roster').insert(inserts);
        if (error) {
          alert('Error inserting new students: ' + error.message);
          return;
        }
      }
      if (updates.length > 0) {
        const { error } = await supabaseClient.from('master_roster').upsert(updates);
        if (error) {
          alert('Error updating students: ' + error.message);
          return;
        }
      }
      alert('Changes saved successfully!');
      isEditing = false;
      newStudentRow = null;
      renderRosterTable();
    } catch (error) {
      alert('Error saving changes: ' + error.message);
    }
  }

  // --- Event Listeners ---

  // Listener for buttons inside the table (delegated)
  tableContainer.addEventListener('click', async (event) => {
    const target = event.target;

    // Delete button
    if (target.matches('.btn-delete')) {
      const row = target.closest('tr');
      const id = row.getAttribute('data-id');
      if (confirm('Are you sure you want to delete this student?')) {
        const { error } = await supabaseClient.from('master_roster').delete().eq('id', id);
        if (error) {
          alert('Error deleting student: ' + error.message);
        } else {
          renderRosterTable(); // Refresh table on success
        }
      }
    }

    // Cancel New Student button
    if (target.matches('.btn-cancel-new')) {
      newStudentRow = null;
      renderRosterTable();
    }
  });

  // Listeners for controls outside the table
  document.getElementById('edit-students-btn').addEventListener('click', () => {
    isEditing = true;
    renderRosterTable();
  });

  document.getElementById('add-student-btn').addEventListener('click', () => {
    if (newStudentRow) {
      alert('Please finish the current new student entry first.');
      return;
    }
    newStudentRow = { id: 'new', firstname: '', lastname: '', grade: null, kgroups: null, site: null, summer_site: null, non_school_day: false };
    renderRosterTable();
    // Scroll the new row into view
    tableContainer.querySelector('tr[data-id="new"]')?.scrollIntoView({ behavior: 'smooth' });
  });

  document.getElementById('save-changes-btn').addEventListener('click', saveChanges);

  document.getElementById('discard-changes-btn').addEventListener('click', () => {
    if (confirm('Are you sure you want to discard all changes?')) {
      isEditing = false;
      newStudentRow = null;
      renderRosterTable();
    }
  });

  // --- Bulk Update ---
  const bulkUpdateBtn = document.getElementById('bulk-update-btn');
  const bulkUpdateModal = document.getElementById('bulk-update-modal');
  const bulkUpdateCancelBtn = document.getElementById('bulk-update-cancel-btn');
  const bulkUpdateSubmitBtn = document.getElementById('bulk-update-submit-btn');
  const bulkUpdateField = document.getElementById('bulk-update-field');
  const bulkUpdateValueContainer = document.getElementById('bulk-update-value-container');
  const bulkUpdateCsvUpload = document.getElementById('bulk-update-csv-upload');

  let siteOptionsForBulk = [];
  let summerSiteOptionsForBulk = [];

  // Bulk update preview state (null until a preview is built)
  let bulkPreviewState = null; // { fieldToUpdate, finalValue, updates: [...], inserts: [...] }

  // --- Bulk preview helpers (table-level preview) ---
  function ensureBulkPreviewStyles(){
    if (document.getElementById('bulk-preview-style')) return;
    const style = document.createElement('style');
    style.id = 'bulk-preview-style';
    style.textContent = `
      .preview-update { outline: 2px solid #ffe08a; outline-offset: -2px; }
      .preview-insert { outline: 2px solid #9bd1ff; outline-offset: -2px; }
      .cell-preview-change { background: #fff7d6; }
      .cell-preview-insert { background: #eaf6ff; }
      .cell-newvalue { display:block; font-size: 0.85em; color: #0a66c2; margin-top: 2px; }
    `;
    document.head.appendChild(style);
  }

  function clearBulkPreviewRows(){
    const tb = document.querySelector('.roster-table tbody');
    if (tb) tb.querySelectorAll('tr[data-preview="insert"]').forEach(tr => tr.remove());
    document.querySelectorAll('.preview-update, .cell-preview-change, .cell-preview-insert').forEach(el => {
      el.classList.remove('preview-update','cell-preview-change','cell-preview-insert');
    });
    document.querySelectorAll('.cell-newvalue').forEach(el => el.remove());
  }

  function cellIndexForField(field){
    // Table columns in view mode: Name(0), Grade(1), K Groups(2), Site(3), Summer Site(4), Non-School Day(5)
    switch (field){
      case 'kgroups': return 2;
      case 'grade': return 1;
      case 'site': return 3;
      case 'summer_site': return 4;
      case 'non_school_day': return 5;
      default: return null;
    }
  }

  function formatPreviewValue(field, value){
    if (field === 'non_school_day') return value ? 'Yes' : 'No';
    return (value ?? '').toString();
  }

    function getColumnIndexByField(field){
      const headerRow = document.querySelector('.roster-table thead tr');
      if (!headerRow) return null;
      const ths = Array.from(headerRow.children);
      // Prefer explicit data-field attribute if present
      const attrMatch = headerRow.querySelector(`th[data-field="${field}"]`);
      if (attrMatch) return ths.indexOf(attrMatch);
      // Fallback to text-based heuristics (older tables)
      const needle = String(field || '').toLowerCase();
      const matchers = {
        kgroups: (t) => t.includes('k groups'),
        grade: (t) => t.startsWith('grade'),
        site: (t) => t.startsWith('site'),
        summer_site: (t) => t.startsWith('summer site'),
        non_school_day: (t) => t.startsWith('non-school')
      };
      const matchFn = matchers[needle];
      if (!matchFn) return null;
      for (let i = 0; i < ths.length; i++) {
        const txt = ths[i].textContent.trim().toLowerCase();
        if (matchFn(txt)) return i;
      }
      return null;
    }

  function applyBulkPreviewToTable(preview){
    ensureBulkPreviewStyles();
    clearBulkPreviewRows();
    const { fieldToUpdate, finalValue, updates = [], inserts = [] } = preview || {};
    const tb = document.querySelector('.roster-table tbody');
    if (!tb) return;

    const idx = getColumnIndexByField(fieldToUpdate);

    // Highlight existing rows to be updated
    updates.forEach(up => {
      const tr = tb.querySelector(`tr[data-id="${up.id}"]`);
      if (!tr) return;
      tr.classList.add('preview-update');
      if (idx != null) {
        const td = tr.children[idx];
        if (td) {
          td.classList.add('cell-preview-change');
          const note = document.createElement('span');
          note.className = 'cell-newvalue';
          note.textContent = `→ New: ${formatPreviewValue(fieldToUpdate, finalValue)}`;
          td.appendChild(note);
        }
      }
    });

    // Insert preview rows for new students
    inserts.forEach(ins => {
      const tr = document.createElement('tr');
      tr.setAttribute('data-preview','insert');
      tr.className = 'preview-insert';
      const tdName = document.createElement('td');
      tdName.textContent = `${ins.firstname || ''} ${ins.lastname || ''}`.trim();
      const tdGrade = document.createElement('td');
      tdGrade.textContent = ins.grade || '';
      const tdK = document.createElement('td');
      tdK.textContent = ins.kgroups || '';
      const tdSite = document.createElement('td');
      tdSite.textContent = ins.site || '';
      const tdSummer = document.createElement('td');
      tdSummer.textContent = ins.summer_site || '';
      const tdNSD = document.createElement('td');
      tdNSD.textContent = formatPreviewValue('non_school_day', ins.non_school_day);
      tr.appendChild(tdName); tr.appendChild(tdGrade); tr.appendChild(tdK); tr.appendChild(tdSite); tr.appendChild(tdSummer); tr.appendChild(tdNSD);
            // Highlight correct column in the inserted preview row
      const insertIdx = getColumnIndexByField(fieldToUpdate);
      if (insertIdx != null) {
        const targetTd = tr.children[insertIdx];
        if (targetTd) {
          targetTd.classList.add('cell-preview-insert');
          const note = document.createElement('span');
          note.className = 'cell-newvalue';
          note.textContent = `→ New: ${formatPreviewValue(fieldToUpdate, finalValue)}`;
          targetTd.appendChild(note);
        }
      }
      const hasActions = document.querySelector('.roster-table thead th:last-child')?.textContent?.trim() === 'Actions';
      if (hasActions) tr.appendChild(document.createElement('td'));
      const firstRow = tb.querySelector('tr');
      tb.insertBefore(tr, firstRow || null);
    });
  }

  // --- Floating preview action bar ---
  function ensureBulkPreviewBar(){
    if (document.getElementById('bulk-preview-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'bulk-preview-bar';
    // Layout only; visual styling comes from CSS
    bar.style.position = 'fixed';
    bar.style.left = '0';
    bar.style.right = '0';
    bar.style.bottom = '0';
    bar.style.zIndex = '9999';
    bar.style.display = 'none';

    const content = document.createElement('div');
    content.style.display = 'flex';
    content.style.alignItems = 'center';
    content.style.gap = '12px';
    content.style.flexWrap = 'wrap';

    const summary = document.createElement('span');
    summary.id = 'bulk-preview-summary';

    const applyBtn = document.createElement('button');
    applyBtn.id = 'bulk-preview-apply';
    applyBtn.textContent = 'Apply Changes';

    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'bulk-preview-cancel';
    cancelBtn.textContent = 'Cancel Changes';

    content.appendChild(summary);
    content.appendChild(applyBtn);
    content.appendChild(cancelBtn);
    bar.appendChild(content);
    document.body.appendChild(bar);

    // Wire buttons once
    applyBtn.addEventListener('click', async () => {
      if (!bulkPreviewState) return;
      try {
        const { updates, inserts } = bulkPreviewState;
        if (updates && updates.length) {
          const { error: updateError } = await supabaseClient.from('master_roster').upsert(updates);
          if (updateError) throw updateError;
        }
        if (inserts && inserts.length) {
          const { error: insertError } = await supabaseClient.from('master_roster').insert(inserts);
          if (insertError) throw insertError;
        }
        alert('Bulk update completed successfully!');
        clearBulkPreviewRows();
        hideBulkPreviewBar();
        bulkPreviewState = null;
        renderRosterTable();
      } catch (err) {
        alert('An error occurred during the bulk update: ' + err.message);
      }
    });

    cancelBtn.addEventListener('click', () => {
      clearBulkPreviewRows();
      hideBulkPreviewBar();
      bulkPreviewState = null;
      if (bulkUpdateSubmitBtn) bulkUpdateSubmitBtn.textContent = 'Preview Changes';
    });
  }

  function showBulkPreviewBar(){
    ensureBulkPreviewBar();
    const bar = document.getElementById('bulk-preview-bar');
    const summary = document.getElementById('bulk-preview-summary');
    const container = document.getElementById('roster-table-container');
    if (container) container.style.paddingBottom = '84px';
    const up = bulkPreviewState?.updates?.length || 0;
    const ins = bulkPreviewState?.inserts?.length || 0;
    const fld = bulkPreviewState?.fieldToUpdate || '';
    const val = (bulkPreviewState && formatPreviewValue(fld, bulkPreviewState.finalValue)) || '';
    if (summary) summary.innerHTML = `Preview: update <b>${up}</b>, insert <b>${ins}</b> — <code>${fld}</code> → <b>${val || '(blank)'}</b>`;
    if (bar) bar.style.display = 'block';
  }

  function hideBulkPreviewBar(){
    const bar = document.getElementById('bulk-preview-bar');
    const container = document.getElementById('roster-table-container');
    if (container) container.style.paddingBottom = '';
    if (bar) bar.style.display = 'none';
  }

  async function populateBulkUpdateOptions() {
      const { data, error } = await supabaseClient.from('master_roster').select('site, summer_site');
      if (error) {
          console.error('Error fetching sites for bulk update:', error);
          return;
      }
      siteOptionsForBulk = [...new Set(data.map(s => s.site).filter(Boolean))];
      summerSiteOptionsForBulk = [...new Set(data.map(s => s.summer_site).filter(Boolean))];
  }

  function updateBulkValueUI() {
      const field = bulkUpdateField.value;
      let optionsHtml = '';
      if (field === 'site') {
          optionsHtml = `<select id="bulk-update-value" class="filter-select">
              ${siteOptionsForBulk.map(o => `<option value="${o}">${o}</option>`).join('')}
          </select>`;
      } else if (field === 'summer_site') {
          optionsHtml = `<select id="bulk-update-value" class="filter-select">
              <option value=""></option>
              <option value="Kids Play">Kids Play</option>
              <option value="Club Knights">Club Knights</option>
          </select>`;
      } else if (field === 'non_school_day') {
          optionsHtml = `<select id="bulk-update-value" class="filter-select">
              <option value="true">Yes</option>
              <option value="false">No</option>
          </select>`;
      }
      bulkUpdateValueContainer.innerHTML = optionsHtml;
  }

  bulkUpdateBtn.addEventListener('click', async () => {
      await populateBulkUpdateOptions();
      updateBulkValueUI();
      bulkUpdateModal.style.display = 'flex';
      // Reset any prior preview state/UI on open
      bulkPreviewState = null;
      if (bulkUpdateSubmitBtn) bulkUpdateSubmitBtn.textContent = 'Preview Changes';
      const oldPreview = document.getElementById('bulk-update-preview');
      if (oldPreview) oldPreview.remove();
  });

  bulkUpdateCancelBtn.addEventListener('click', () => {
      clearBulkPreviewRows();
      hideBulkPreviewBar();
      bulkPreviewState = null;
      if (bulkUpdateSubmitBtn) bulkUpdateSubmitBtn.textContent = 'Preview Changes';
      bulkUpdateModal.style.display = 'none';
  });

  bulkUpdateField.addEventListener('change', updateBulkValueUI);

  bulkUpdateSubmitBtn.addEventListener('click', async () => {
    // If we already built a preview, this click applies it
    if (bulkPreviewState) {
      try {
        const { updates, inserts } = bulkPreviewState;
        if (updates && updates.length) {
          const { error: updateError } = await supabaseClient.from('master_roster').upsert(updates);
          if (updateError) throw updateError;
        }
        if (inserts && inserts.length) {
          const { error: insertError } = await supabaseClient.from('master_roster').insert(inserts);
          if (insertError) throw insertError;
        }
        alert('Bulk update completed successfully!');
        clearBulkPreviewRows();
        bulkUpdateModal.style.display = 'none';
        bulkPreviewState = null;
        renderRosterTable();
      } catch (err) {
        alert('An error occurred during the bulk update: ' + err.message);
      }
      return;
    }

    // Otherwise, build a preview from the uploaded CSV
    const file = bulkUpdateCsvUpload.files[0];
    if (!file) {
      alert('Please upload a CSV file.');
      return;
    }

    const fieldToUpdate = bulkUpdateField.value;
    const valueEl = document.getElementById('bulk-update-value');
    const valueToSet = valueEl ? valueEl.value : '';
    const isBoolean = fieldToUpdate === 'non_school_day';
    const finalValue = isBoolean ? (valueToSet === 'true') : valueToSet;

    // Detect delimiter from a header-ish row
    const text = await file.text();
    const possibleDelimiters = [",", "\t", ";"];
    let bestDelimiter = ",";
    let maxCount = 0;
    const firstDataRow = text.split(/\r?\n/).find(line => /first.*last|last.*first/i.test(line)) || "";
    for (const d of possibleDelimiters) {
      const count = firstDataRow.split(d).length;
      if (count > maxCount) { maxCount = count; bestDelimiter = d; }
    }

    Papa.parse(file, {
      skipEmptyLines: true,
      delimiter: bestDelimiter,
      complete: async (results) => {
        // Find header row index
        let headerRowIndex = results.data.findIndex(row => {
          const lowerJoin = Array.isArray(row)
            ? row.join(bestDelimiter).toLowerCase()
            : Object.values(row).join(bestDelimiter).toLowerCase();
          return lowerJoin.includes('first') && lowerJoin.includes('last');
        });
        if (headerRowIndex === -1) {
          alert('CSV file missing a valid header row with both first and last name columns.');
          return;
        }

        // Normalize header fields
        const headerFields = Array.isArray(results.data[headerRowIndex])
          ? results.data[headerRowIndex].map(h => h.toLowerCase().replace(/[^a-z]/g, ''))
          : Object.keys(results.data[headerRowIndex]).map(h => h.toLowerCase().replace(/[^a-z]/g, ''));

        // Collect data rows
        const studentRows = results.data.slice(headerRowIndex + 1)
          .filter(row => (Array.isArray(row) ? row.length : Object.values(row).length) > 1);

        const filteredCsvStudents = studentRows.map(row => {
          const obj = {};
          for (let i = 0; i < headerFields.length; i++) {
            if (Array.isArray(row)) obj[headerFields[i]] = (row[i] || '').trim();
            else { const value = Object.values(row)[i]; obj[headerFields[i]] = (value || '').trim(); }
          }
          return obj;
        }).filter(s => (s.firstname || s.first) && (s.lastname || s.last));

        if (filteredCsvStudents.length === 0) {
          alert('CSV file is empty or invalid (no students with both firstname and lastname).');
          return;
        }

        function findKey(obj, possibleNames) {
          return Object.keys(obj).find(key => possibleNames.some(name => key === name));
        }

        try {
          const { data: existingStudents, error } = await supabaseClient
            .from('master_roster').select('id, firstname, lastname');
          if (error) throw error;

          const existingStudentMap = new Map(existingStudents.map(s => [
            `${s.firstname.toLowerCase().trim()}_${s.lastname.toLowerCase().trim()}`, s.id
          ]));

          const updates = []; const inserts = [];
          for (const csvStudent of filteredCsvStudents) {
            const firstNameField = findKey(csvStudent, ['firstname', 'first']);
            const lastNameField = findKey(csvStudent, ['lastname', 'last']);
            if (!firstNameField || !lastNameField) continue;

            const firstName = csvStudent[firstNameField]?.toLowerCase().trim();
            const lastName = csvStudent[lastNameField]?.toLowerCase().trim();
            const mapKey = `${firstName}_${lastName}`;
            const existingId = existingStudentMap.get(mapKey);

            if (existingId) updates.push({ id: existingId, [fieldToUpdate]: finalValue });
            else inserts.push({ firstname: csvStudent[firstNameField], lastname: csvStudent[lastNameField], grade: csvStudent.grade, [fieldToUpdate]: finalValue });
          }

          // Build and inject preview UI
          // Store state and show table-based preview
          bulkPreviewState = { fieldToUpdate, finalValue, updates, inserts };
          applyBulkPreviewToTable(bulkPreviewState);
          if (bulkUpdateSubmitBtn) bulkUpdateSubmitBtn.textContent = 'Apply Changes';
          // Hide the floating modal to maximize space and use the bottom bar for actions
          bulkUpdateModal.style.display = 'none';
          showBulkPreviewBar();

        } catch (err) {
          alert('An error occurred building the preview: ' + err.message);
        }
      }
    });
  });
// roster.js

async function login() {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test", password: "secret" })
  });
  const data = await res.json();
  console.log("Login response:", data);

  if (data.ok) {
    // Store session token in localStorage so we can verify later
    localStorage.setItem("session", data.session);
    alert("Login successful!");
  } else {
    alert("Login failed!");
  }
}

  
  // Initial Render
  renderRosterTable();

  // Real-time subscription
  supabaseClient.channel('master_roster_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'master_roster' }, (payload) => {
      // Re-render table only if not in editing mode to avoid disrupting user input
      if (!isEditing) {
        renderRosterTable();
      }
    })
    .subscribe();
});
