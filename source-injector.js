/**
 * source-injector.js
 * Runs on: https://iamatc.aai.aero/atc/MyLogBook*
 * IIFE — reads shared data from window.__DGCA__
 */
(function () {
  'use strict';

  const { COL, DUTY_TYPE, normaliseTime, getAtcol } = window.__DGCA__;

  let _offset = 0;
  let _selectedRows = {};

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

  function detectDutyTypeFromRow(tr) {
    if (cellText(tr, COL.CTIME_FROM)) return DUTY_TYPE.CONTROLLING;
    if (cellText(tr, COL.PTIME_FROM)) return DUTY_TYPE.OJT_INSTR_PRACTICAL;
    if (cellText(tr, COL.TTIME_FROM)) return DUTY_TYPE.OJT_INSTR_THEORY;
    if (cellText(tr, COL.OTIME_FROM)) return DUTY_TYPE.OJT_TRAINING_THEORY;
    if (cellText(tr, COL.OPTIME_FROM)) return DUTY_TYPE.OJT_TRAINING_PRACTICAL;
    return DUTY_TYPE.CONTROLLING;
  }

  function getTimesForDuty(tr, dutyType) {
    const map = {
      [DUTY_TYPE.CONTROLLING]: [COL.CTIME_FROM, COL.CTIME_TO, COL.CTIME_TOTAL],
      [DUTY_TYPE.OJT_INSTR_PRACTICAL]: [COL.PTIME_FROM, COL.PTIME_TO, COL.PTIME_TOTAL],
      [DUTY_TYPE.OJT_INSTR_THEORY]: [COL.TTIME_FROM, COL.TTIME_TO, COL.TTIME_TOTAL],
      [DUTY_TYPE.OJT_TRAINING_THEORY]: [COL.OTIME_FROM, COL.OTIME_TO, COL.OTIME_TOTAL],
      [DUTY_TYPE.OJT_TRAINING_PRACTICAL]: [COL.OPTIME_FROM, COL.OPTIME_TO, COL.OPTIME_TOTAL],
    };
    const cols = map[dutyType];
    if (!cols) return { from: '', to: '', total: '' };
    return {
      from: normaliseTime(cellText(tr, cols[0])),
      to: normaliseTime(cellText(tr, cols[1])),
      total: normaliseTime(cellText(tr, cols[2])),
    };
  }

  function parseRow(tr) {
    const dutyType = detectDutyTypeFromRow(tr);
    const times = getTimesForDuty(tr, dutyType);
    const date = cellText(tr, COL.DATE);
    const station = cellText(tr, COL.STATION);
    const nameOjti = cellText(tr, COL.NAME_OJTI);
    const pNameTrainee = cellText(tr, COL.PNAME);
    const tNameTrainee = cellText(tr, COL.TNAME);

    return {
      id: rowId(date, station, times.from, times.to, dutyType),
      date, station,
      atsUnit: cellText(tr, COL.ATS_UNIT),
      remarks: cellText(tr, COL.REMARKS),
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

  // ── UI injection ──────────────────────────────────────────────────────────
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

    document.getElementById('dgca-send-btn').addEventListener('click', onSendClick);
    _buttonInjected = true;
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
    markStatusCells(tableBody);
  }

  function escAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

  function markStatusCells(tableBody) {
    chrome.storage.session.get(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors'])
      .then((data) => {
        const pendingRows = data?.dgca_pending_rows || [];
        const statuses = data?.dgca_row_status || [];
        const errors = data?.dgca_row_errors || {};

        tableBody.querySelectorAll('tr').forEach(tr => {
          if (!isDataRow(tr)) return;
          _offset = 1;
          const date = cellText(tr, COL.DATE);
          const station = cellText(tr, COL.STATION);
          const matchIdx = pendingRows.findIndex(r => r.date === date && r.station === station);
          if (matchIdx < 0) return;
          const status = statuses[matchIdx];
          if (!status || status === 'pending') return;

          let statusTd = tr.querySelector('.dgca-status-cell');
          if (!statusTd) {
            statusTd = document.createElement('td');
            statusTd.className = 'dgca-status-cell';
            statusTd.style.cssText = 'font-size:11px;font-weight:600;text-align:center;padding:2px 4px;border:1px solid #ccc;cursor:pointer;';
            tr.appendChild(statusTd);
          }
          applyStatusToCell(statusTd, status, errors[matchIdx], matchIdx);
        });
      })
      .catch(() => { });
  }

  function applyStatusToCell(td, status, errorMsg, index) {
    if (status === 'filling') {
      td.textContent = '⏳'; td.style.color = '#007bff'; td.title = 'Filling…';
    } else if (status === 'submitted') {
      td.textContent = '✓'; td.style.color = '#28a745'; td.title = 'Added successfully';
      td.parentElement.style.background = 'rgba(40,167,69,0.08)';
    } else if (status === 'error') {
      td.textContent = '✗'; td.style.color = '#dc3545';
      td.parentElement.style.background = 'rgba(220,53,69,0.08)';
      td.title = errorMsg || 'Error — click for details';
      td.onclick = () => alert(`Row ${index + 1} Error:\n\n${errorMsg || 'Unknown error'}`);
    }
  }

  /**
   * Sort key for a row: combines date (DD-MM-YYYY → sortable YYYYMMDD) and
   * timeFrom (HH:MM) so rows are always processed chronologically.
   * Midnight-crossing entries that end at 00:00 sort by their start time.
   */
  function rowSortKey(row) {
    const [d, m, y] = String(row.date || '').split('-');
    const dateKey = `${y || '0000'}${m || '00'}${d || '00'}`;
    const timeKey = String(row.timeFrom || '00:00').replace(':', '');
    return `${dateKey}${timeKey}`;
  }

  /**
   * Re-sort an array of rows by date+time ascending.
   * Returns a NEW array; statuses and errors are re-indexed to match.
   */
  function sortQueue(rows, statuses, errors) {
    const indexed = rows.map((row, i) => ({
      row,
      status: statuses[i] || 'pending',
      error: errors[i] || null,
      key: rowSortKey(row),
    }));
    indexed.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const sortedRows = indexed.map(x => x.row);
    const sortedStatuses = indexed.map(x => x.status);
    const sortedErrors = {};
    indexed.forEach((x, i) => { if (x.error) sortedErrors[i] = x.error; });
    return { rows: sortedRows, statuses: sortedStatuses, errors: sortedErrors };
  }

  function onSendClick() {
    const newRows = Object.values(_selectedRows);
    if (newRows.length === 0) {
      alert('No rows selected. Please check at least one row across any page.');
      return;
    }

    chrome.storage.session.get(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors'])
      .then((data) => {
        const existing = data?.dgca_pending_rows || [];
        const existingStatus = data?.dgca_row_status || [];
        const existingErrors = data?.dgca_row_errors || {};
        const existingMap = {};
        existing.forEach((r, i) => { existingMap[r.id] = { row: r, index: i }; });

        const toAdd = newRows.filter(r => !existingMap[r.id]);
        if (toAdd.length === 0) {
          alert(`All ${newRows.length} selected rows are already in the queue.`);
          return;
        }

        const rawMerged = [...existing, ...toAdd];
        const rawStatuses = [...existingStatus, ...toAdd.map(() => 'pending')];
        const { rows: merged, statuses: mergedStatus, errors: mergedErrors } =
          sortQueue(rawMerged, rawStatuses, existingErrors);

        return chrome.storage.session.set({
          dgca_pending_rows: merged,
          dgca_row_status: mergedStatus,
          dgca_row_errors: mergedErrors,
          dgca_session_ts: Date.now(),
        }).then(() => {
          chrome.runtime.sendMessage({ type: 'ROWS_QUEUED', count: merged.length });
          const btn = document.getElementById('dgca-send-btn');
          if (btn) {
            const orig = btn.textContent;
            btn.textContent = `✓ ${toAdd.length} added (${merged.length} total)`;
            btn.style.background = '#6c757d';
            setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 3000);
          }
          updateSelectionBadge();
        });
      })
      .catch((err) => {
        console.error('[DGCA] Failed to queue rows:', err);
        alert('Failed to save rows to queue. Please try again.');
      });
  }

  function listenForStatusUpdates() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'session' || !changes.dgca_row_status) return;
      const tableBody = document.getElementById('tableBody');
      if (tableBody) markStatusCells(tableBody);
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
    if (!window.__DGCA__) {
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
    listenForStatusUpdates();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();