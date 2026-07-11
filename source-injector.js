/**
 * source-injector.js
 * Runs on: https://iamatc.aai.aero/atc/MyLogBook*
 * IIFE — reads shared data from window.__DGCA__
 */
(function () {
  'use strict';

  const { COL, DUTY_TYPE, normaliseTime, getAtcol, isSimEntry } = window.__DGCA__;

  let _offset = 0;
  let _selectedRows = {};

  /**
   * Read the currently logged-in AAI user from the top navbar.
   *   <li id="ew-navbar-end" ...> first <li> holds the display name next to
   *   the "Welcome" tooltip icon (e.g. "Gaurav Chetiwal").
   *   The separate user-icon dropdown (#ew-nav-link-user) holds the stable
   *   login id in its dropdown-header (e.g. "chetiwalg") — this is the more
   *   reliable identifier since two people could in theory share a display
   *   name, so it's used as the primary comparison key with the friendly
   *   name kept purely for display.
   */
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
    } catch (_) {
      return null;
    }
  }

  /** True when the queue already holds rows tagged to a different AAI user. */
  function isUserMismatch(currentUser, queueUser, existingRowCount) {
    return !!(
      existingRowCount > 0 &&
      queueUser && currentUser &&
      queueUser.loginId && currentUser.loginId &&
      queueUser.loginId !== currentUser.loginId
    );
  }

  /**
   * Keep the "Add to Queue" toolbar warned if the logged-in AAI user no
   * longer matches whoever the current queue was built for. Purely a
   * heads-up — the actual block happens in onSendClick.
   */
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

  /**
   * Determine which set of AAI time columns actually holds data for this row.
   * This is purely about WHERE the times live in the source table — it is
   * NOT the same as the duty type submitted to the DGCA portal (see
   * resolvePortalDutyType below, which can retarget THEORY rows to
   * PRACTICAL when the entry is really a simulator session).
   */
  function detectSourceTimeCategory(tr) {
    if (cellText(tr, COL.CTIME_FROM)) return DUTY_TYPE.CONTROLLING;
    if (cellText(tr, COL.PTIME_FROM)) return DUTY_TYPE.OJT_INSTR_PRACTICAL;
    if (cellText(tr, COL.TTIME_FROM)) return DUTY_TYPE.OJT_INSTR_THEORY;
    if (cellText(tr, COL.OTIME_FROM)) return DUTY_TYPE.OJT_TRAINING_THEORY;
    if (cellText(tr, COL.OPTIME_FROM)) return DUTY_TYPE.OJT_TRAINING_PRACTICAL;
    return DUTY_TYPE.CONTROLLING;
  }

  /**
   * Resolve the duty type actually submitted to the DGCA portal.
   *
   * AAI logs simulator sessions with their time in the THEORY columns
   * (TTIME for the instructor, OTIME for the trainee), but on the DGCA
   * portal a SIM entry is a PRACTICAL duty (with the "Simulation" ojtEnv
   * option, handled separately in dgca-filler.js) — not a theory/classroom
   * entry. So when remarks mark the row as SIM, retarget:
   *   OJT_INSTR_THEORY    -> OJT_INSTR_PRACTICAL
   *   OJT_TRAINING_THEORY -> OJT_TRAINING_PRACTICAL
   * Non-theory categories (already practical, or controlling) pass through
   * unchanged — the SIM tag has nothing to override there.
   */
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
    // sourceCategory tells us WHERE the times live (source table columns);
    // dutyType is what actually gets submitted to the DGCA portal, which can
    // diverge from sourceCategory for SIM entries (see resolvePortalDutyType).
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
    // Ask the background to open the side panel for this tab. Must be fired
    // synchronously, right at the start of the click handler — the "transient
    // user activation" that makes chrome.sidePanel.open() legal only survives
    // a few seconds and can be spent by awaiting storage calls first. Safe to
    // call even if the panel is already open (no-op / just focuses it).
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

        // Guard against mixing rows scraped under two different AAI logins
        // into the same queue/session — the DGCA-side ATCOL/instructor data
        // would otherwise silently be attributed to the wrong person.
        if (isUserMismatch(currentUser, queueUser, existing.length)) {
          refreshUserMismatchIndicator();
          alert(
            `⚠ AAI user has changed.\n\n` +
            `The current queue was built while logged in as "${queueUser.name}", ` +
            `but you are now logged in as "${currentUser.name}".\n\n` +
            `Please open the side panel and clear the queue first, then re-select ` +
            `and add rows for "${currentUser.name}".`
          );
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
        const { rows: merged, statuses: mergedStatus, errors: mergedErrors } =
          sortQueue(rawMerged, rawStatuses, existingErrors);

        // Tag the queue with whoever it's for. Keep the existing tag if for
        // some reason the current page couldn't resolve a user (don't erase
        // a known-good tag with a null read).
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

    // Also re-check periodically: the AAI user can change (logout/login in
    // the same tab) without touching the pending-rows queue at all, so the
    // storage.onChanged listener alone wouldn't catch it.
    if (!window.__dgcaUserWatch) {
      window.__dgcaUserWatch = setInterval(refreshUserMismatchIndicator, 5000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();