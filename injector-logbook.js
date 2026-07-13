/**
source-injector.js
Runs on: https://iamatc.aai.aero/atc/MyLogBook*
*/
(function () {
'use strict';
const { COL, DUTY_TYPE, normaliseTime, getAtcol, isSimEntry } = window.DGCA;
let _offset = 0;
let _selectedRows = {};

function getAaiUser() {
  try {
    let loginId = '';
    const header = document.querySelector('.ew-user-dropdown .dropdown-header');
    if (header) loginId = header.textContent.replace(/\s+/g, ' ').trim();
    let name = '';
    const nameEl = document.querySelector('#ew-navbar-end .ew-tooltip[data-bs-original-title="Welcome"]');
    if (nameEl) name = nameEl.textContent.replace(/\s+/g, ' ').trim();
    if (!loginId && !name) return null;
    return { name: name || loginId, loginId: loginId || name };
  } catch (_) { return null; }
}

function isUserMismatch(currentUser, queueUser, existingRowCount) {
  return !!(existingRowCount > 0 && queueUser && currentUser && queueUser.loginId && currentUser.loginId && queueUser.loginId !== currentUser.loginId);
}

// Prevent MyLogBook rows and EGcAexport rows from ending up in the same
// queue: service-worker.js routes the WHOLE queue to one filler script
// based on rows[0].source, so a mixed queue silently mis-fills rows from
// the other source.
function isSourceMismatch(existingRows, newRowsSource) {
  return !!(existingRows.length > 0 && existingRows[0].source && existingRows[0].source !== newRowsSource);
}

async function refreshUserMismatchIndicator() {
  try {
    const warnEl = document.getElementById('dgca-user-warn');
    if (!warnEl) return;
    const data = await chrome.storage.session.get(['dgca_pending_rows', 'dgca_queue_user']);
    const existing = data?.dgca_pending_rows || [];
    const queueUser = data?.dgca_queue_user || null;
    const current = getAaiUser();
    if (isUserMismatch(current, queueUser, existing.length)) {
      warnEl.textContent = `⚠ Queue is for ${queueUser.name} — clear it before adding as ${current.name}`;
      warnEl.style.display = 'inline-block';
    } else {
      warnEl.style.display = 'none';
    }
  } catch (_) { }
}

function cellText(tr, origColIdx) {
  const td = tr.cells[origColIdx + _offset];
  return td ? td.innerText.trim() : '';
}

function isDataRow(tr) {
  const dateText = cellText(tr, COL.DATE);
  return /^\d{2}-\d{2}-\d{4}$/.test(dateText);
}

function rowId(date, station, timeFrom, timeTo, dutyType) {
  return `${date}|${station}|${timeFrom}|${timeTo}|${dutyType}`;
}

function detectSourceTimeCategory(tr) {
  if (cellText(tr, COL.CTIME_FROM)) return DUTY_TYPE.CONTROLLING;
  if (cellText(tr, COL.PTIME_FROM)) return DUTY_TYPE.OJT_INSTR_PRACTICAL;
  if (cellText(tr, COL.TTIME_FROM)) return DUTY_TYPE.OJT_INSTR_THEORY;
  if (cellText(tr, COL.OTIME_FROM)) return DUTY_TYPE.OJT_TRAINING_THEORY;
  if (cellText(tr, COL.OPTIME_FROM)) return DUTY_TYPE.OJT_TRAINING_PRACTICAL;
  return DUTY_TYPE.CONTROLLING;
}

function resolvePortalDutyType(sourceCategory, remarksText) {
  if (!isSimEntry(remarksText)) return sourceCategory;
  if (sourceCategory === DUTY_TYPE.OJT_INSTR_THEORY) return DUTY_TYPE.OJT_INSTR_PRACTICAL;
  if (sourceCategory === DUTY_TYPE.OJT_TRAINING_THEORY) return DUTY_TYPE.OJT_TRAINING_PRACTICAL;
  return sourceCategory;
}

function getTimesForDuty(tr, sourceCategory) {
  const map = {
    [DUTY_TYPE.CONTROLLING]: [COL.CTIME_FROM, COL.CTIME_TO, COL.CTIME_TOTAL],
    [DUTY_TYPE.OJT_INSTR_PRACTICAL]: [COL.PTIME_FROM, COL.PTIME_TO, COL.PTIME_TOTAL],
    [DUTY_TYPE.OJT_INSTR_THEORY]: [COL.TTIME_FROM, COL.TTIME_TO, COL.TTIME_TOTAL],
    [DUTY_TYPE.OJT_TRAINING_THEORY]: [COL.OTIME_FROM, COL.OTIME_TO, COL.OTIME_TOTAL],
    [DUTY_TYPE.OJT_TRAINING_PRACTICAL]: [COL.OPTIME_FROM, COL.OPTIME_TO, COL.OPTIME_TOTAL],
  };
  const cols = map[sourceCategory];
  if (!cols) return { from: '', to: '', total: '' };
  return {
    from: normaliseTime(cellText(tr, cols[0])),
    to: normaliseTime(cellText(tr, cols[1])),
    total: normaliseTime(cellText(tr, cols[2])),
  };
}

function parseRow(tr) {
  const remarks = cellText(tr, COL.REMARKS);
  const sourceCategory = detectSourceTimeCategory(tr);
  const dutyType = resolvePortalDutyType(sourceCategory, remarks);
  const times = getTimesForDuty(tr, sourceCategory);
  const date = cellText(tr, COL.DATE);
  const station = cellText(tr, COL.STATION);
  const nameOjti = cellText(tr, COL.NAME_OJTI);
  const pNameTrainee = cellText(tr, COL.PNAME);
  const tNameTrainee = cellText(tr, COL.TNAME);
  
  return {
    id: rowId(date, station, times.from, times.to, dutyType),
    source: 'mylogbook', // NEW: Tag the source
    date, station,
    atsUnit: cellText(tr, COL.ATS_UNIT),
    remarks,
    nameOjti: nameOjti,
    instructorAtcol: getAtcol(nameOjti),
    pNameTrainee: pNameTrainee,
    tNameTrainee: tNameTrainee,
    theoryTraineeAtcol: getAtcol(tNameTrainee),
    practicalTraineeAtcol: getAtcol(pNameTrainee),
    noDays: cellText(tr, COL.NO_DAYS),
    dutyType,
    timeFrom: times.from,
    timeTo: times.to,
    timeTotal: times.total,
  };
}

let _headerInjected = false;
let _buttonInjected = false;

function ensureHeaderInjected() {
  if (_headerInjected) return;
  const table = document.getElementById('logbookTable');
  if (!table) return;
  const thead = table.querySelector('thead');
  if (!thead) return;
  const headerRows = thead.querySelectorAll('tr');
  if (!headerRows[0]) return;
  if (headerRows[0].querySelector('.dgca-chk-header')) return;

  const th = document.createElement('th');
  th.rowSpan = 2;
  th.className = 'dgca-chk-header';
  th.style.cssText = 'min-width:36px;text-align:center;vertical-align:middle;background:var(--lb-header-bg,#f0f0f0);';
  th.innerHTML = `<input type="checkbox" id="dgca-chk-all" title="Select/Deselect all visible" style="cursor:pointer;width:16px;height:16px;">`;
  headerRows[0].insertBefore(th, headerRows[0].firstChild);

  document.addEventListener('change', (e) => {
    if (e.target.id === 'dgca-chk-all') {
      const tableBody = document.getElementById('tableBody');
      if (!tableBody) return;
      tableBody.querySelectorAll('.dgca-row-chk').forEach(chk => {
        chk.checked = e.target.checked;
        const row = _parseRowFromCheckbox(chk);
        if (row) {
          if (e.target.checked) _selectedRows[row.id] = row;
          else delete _selectedRows[row.id];
        }
      });
      updateSelectionBadge();
    }
  });
  _headerInjected = true;
}

function ensureButtonInjected() {
  if (_buttonInjected) return;
  if (document.getElementById('dgca-send-btn')) { _buttonInjected = true; return; }
  const toolbar = document.querySelector('.btn-toolbar');
  if (!toolbar) return;
  const group = document.createElement('div');
  group.className = 'btn-group';
  group.id = 'dgca-btn-group';
  group.innerHTML = `<button id="dgca-send-btn" class="btn btn-success btn-sm" style="font-weight:600;">✈ Add to Queue ▶</button>`;
  toolbar.appendChild(group);
  
  const badge = document.createElement('span');
  badge.id = 'dgca-sel-count';
  badge.style.cssText = 'margin-left:8px;font-size:12px;color:#28a745;font-weight:600;line-height:2.2;';
  badge.textContent = '0 selected';
  toolbar.appendChild(badge);
  
  const userWarn = document.createElement('span');
  userWarn.id = 'dgca-user-warn';
  userWarn.style.cssText = 'margin-left:8px;font-size:12px;color:#c0392b;font-weight:700;line-height:2.2;display:none;';
  toolbar.appendChild(userWarn);

  document.getElementById('dgca-send-btn').addEventListener('click', onSendClick);
  _buttonInjected = true;
  refreshUserMismatchIndicator();
  
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && (changes.dgca_pending_rows || changes.dgca_queue_user)) {
      refreshUserMismatchIndicator();
    }
  });
}

function injectCheckboxesIntoBody(tableBody) {
  tableBody.querySelectorAll('td.dgca-chk-cell').forEach(td => td.remove());
  const rows = tableBody.querySelectorAll('tr');
  rows.forEach(tr => {
    const td = document.createElement('td');
    td.className = 'dgca-chk-cell';
    td.style.cssText = 'text-align:center;vertical-align:middle;border:1px solid var(--lb-border,#000);min-width:36px;';
    const savedOffset = _offset;
    _offset = 0;
    const dataRow = isDataRow(tr);
    let previewRow = null;
    if (dataRow) previewRow = parseRow(tr);
    _offset = savedOffset;
    
    if (previewRow) {
      const isChecked = !!_selectedRows[previewRow.id];
      td.innerHTML = `<input type="checkbox" class="dgca-row-chk"
        data-row-id="${escAttr(previewRow.id)}"
        style="cursor:pointer;width:16px;height:16px;"
        ${isChecked ? 'checked' : ''}>`;
    }
    tr.insertBefore(td, tr.firstChild);
  });
  _offset = 1;
  updateSelectionBadge();
  syncHeaderCheckbox(tableBody);
  wireBodyEvents(tableBody);
}

function escAttr(str) {
  return String(str).replace(/"/g, '"').replace(/'/g, '\'');
}

function _parseRowFromCheckbox(chk) {
  const tr = chk.closest('tr');
  if (!tr || !isDataRow(tr)) return null;
  return parseRow(tr);
}

function wireBodyEvents(tableBody) {
  if (tableBody._dgcaListenerAttached) return;
  tableBody._dgcaListenerAttached = true;
  tableBody.addEventListener('change', (e) => {
    if (!e.target.classList.contains('dgca-row-chk')) return;
    const row = _parseRowFromCheckbox(e.target);
    if (!row) return;
    if (e.target.checked) _selectedRows[row.id] = row;
    else delete _selectedRows[row.id];
    updateSelectionBadge();
    syncHeaderCheckbox(tableBody);
  });
}

function updateSelectionBadge() {
  const badge = document.getElementById('dgca-sel-count');
  if (badge) badge.textContent = `${Object.keys(_selectedRows).length} selected`;
}

function syncHeaderCheckbox(tableBody) {
  const chkAll = document.getElementById('dgca-chk-all');
  if (!chkAll) return;
  const all = tableBody.querySelectorAll('.dgca-row-chk');
  const checked = tableBody.querySelectorAll('.dgca-row-chk:checked');
  if (all.length === 0) { chkAll.indeterminate = false; chkAll.checked = false; }
  else {
    chkAll.checked = checked.length === all.length;
    chkAll.indeterminate = checked.length > 0 && checked.length < all.length;
  }
}

function rowSortKey(row) {
  const [d, m, y] = String(row.date || '').split('-');
  const dateKey = `${y || '0000'}${m || '00'}${d || '00'}`;
  const timeKey = String(row.timeFrom || '00:00').replace(':', '');
  return `${dateKey}${timeKey}`;
}

function sortQueue(rows, statuses, errors) {
  const indexed = rows.map((row, i) => ({
    row, status: statuses[i] || 'pending', error: errors[i] || null, key: rowSortKey(row),
  }));
  indexed.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const sortedRows = indexed.map(x => x.row);
  const sortedStatuses = indexed.map(x => x.status);
  const sortedErrors = {};
  indexed.forEach((x, i) => { if (x.error) sortedErrors[i] = x.error; });
  return { rows: sortedRows, statuses: sortedStatuses, errors: sortedErrors };
}

function onSendClick() {
  try { chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }); } catch (_) { }
  const newRows = Object.values(_selectedRows);
  if (newRows.length === 0) {
    alert('No rows selected. Please check at least one row across any page.');
    return;
  }
  const currentUser = getAaiUser();
  chrome.storage.session.get(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_queue_user'])
    .then((data) => {
      const existing = data?.dgca_pending_rows || [];
      const existingStatus = data?.dgca_row_status || [];
      const existingErrors = data?.dgca_row_errors || {};
      const queueUser = data?.dgca_queue_user || null;

      if (isUserMismatch(currentUser, queueUser, existing.length)) {
        refreshUserMismatchIndicator();
        alert(`⚠ AAI user has changed.\n\nThe current queue was built while logged in as "${queueUser.name}", but you are now logged in as "${currentUser.name}".\n\nPlease open the side panel and clear the queue first.`);
        return;
      }

      if (isSourceMismatch(existing, 'mylogbook')) {
        const existingSourceLabel = existing[0].source === 'egcaexport' ? 'EGCA Export' : existing[0].source;
        alert(`⚠ Mixed source queue.\n\nThe current queue already contains rows from "${existingSourceLabel}". Adding MyLogBook rows to the same queue would cause them to be filled incorrectly.\n\nPlease open the side panel and clear (or finish/submit) the existing queue first.`);
        return;
      }

      const existingMap = {};
      existing.forEach((r, i) => { existingMap[r.id] = { row: r, index: i }; });
      const toAdd = newRows.filter(r => !existingMap[r.id]);
      if (toAdd.length === 0) {
        alert(`All ${newRows.length} selected rows are already in the queue.`);
        return;
      }

      const rawMerged = [...existing, ...toAdd];
      const rawStatuses = [...existingStatus, ...toAdd.map(() => 'pending')];
      const { rows: merged, statuses: mergedStatus, errors: mergedErrors } = sortQueue(rawMerged, rawStatuses, existingErrors);

      const nextQueueUser = currentUser || queueUser || null;
      return chrome.storage.session.set({
        dgca_pending_rows: merged,
        dgca_row_status: mergedStatus,
        dgca_row_errors: mergedErrors,
        dgca_session_ts: Date.now(),
        dgca_queue_user: nextQueueUser,
      }).then(() => {
        chrome.runtime.sendMessage({ type: 'ROWS_QUEUED', count: merged.length, user: nextQueueUser });
        const btn = document.getElementById('dgca-send-btn');
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = `✓ ${toAdd.length} added (${merged.length} total)`;
          btn.style.background = '#6c757d';
          setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 3000);
        }
        updateSelectionBadge();
        refreshUserMismatchIndicator();
      });
    })
    .catch((err) => {
      console.error('[DGCA] Failed to queue rows:', err);
      alert('Failed to save rows to queue. Please try again.');
    });
}

let _mutationObserver = null;
let _debounceTimer = null;
function startObserving(tableBody) {
  if (_mutationObserver) _mutationObserver.disconnect();
  _mutationObserver = new MutationObserver(() => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      const tb = document.getElementById('tableBody');
      if (!tb) return;
      _offset = 0;
      injectCheckboxesIntoBody(tb);
      tb._dgcaListenerAttached = false;
      wireBodyEvents(tb);
    }, 100);
  });
  _mutationObserver.observe(tableBody, { childList: true });
}

function setup() {
  if (!window.DGCA) {
    console.error('[source-injector] shared.js not loaded yet');
    return;
  }
  const tableBody = document.getElementById('tableBody');
  if (!tableBody || tableBody.children.length === 0) {
    const obs = new MutationObserver((_, o) => {
      const tb = document.getElementById('tableBody');
      if (tb && tb.children.length > 0) { o.disconnect(); setup(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return;
  }
  ensureHeaderInjected();
  ensureButtonInjected();
  _offset = 0;
  injectCheckboxesIntoBody(tableBody);
  startObserving(tableBody);
  if (!window.__dgcaUserWatch) {
    window.__dgcaUserWatch = setInterval(refreshUserMismatchIndicator, 5000);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
else setup();
})();