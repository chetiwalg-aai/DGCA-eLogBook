/**
egca-export-injector.js
Runs on: https://iamatc.aai.aero/atc/EGcAexport*
*/
(function () {
  'use strict';
  
  // ✅ Removed DUTY_TYPE, normaliseTime, and getAtcol as they are no longer needed
  const EGCA_COL = {
    FROM_DATE: 0, TO_DATE: 1, POSTING_STATION: 2, ICAO_CODE: 3,
    ATS_EGCA_ID: 4, RATING: 5, ATS_UNIT: 6, BRIEFING_DONE: 7,
    TYPE_OF_DUTY: 8, START_TIME: 9, END_TIME: 10, TOTAL_DURATION: 11,
    REMARKS: 12, KNOWLEDGE_CHECK: 13, SKILL_TEST_CHECK: 14, OJT_PROVIDED_CHECK: 15,
    OJT_ENV: 16, OJTI_NAME: 17, TRAINEE_LICENSE: 18, INSTRUCTOR_NAME: 19,
    INSTRUCTOR_LICENSE: 20, PROFICIENCY_CHECK: 21, NEWLY_ESTAB_STATION: 22
  };

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
    const dateText = cellText(tr, EGCA_COL.FROM_DATE);
    return /^\d{2}\/\d{2}\/\d{4}$/.test(dateText);
  }

  function rowId(date, station, timeFrom, timeTo, dutyType) {
    return `${date}|${station}|${timeFrom}|${timeTo}|${dutyType}`;
  }

  // Map EGCA portal's "Type of Duty" display text → shared DUTY_TYPE constants.
  // These are the exact strings that appear in the EGCA export table column.
  const EGCA_DUTY_TYPE_MAP = {
    'controlling':                    'controlling',
    'ojt instructor practical':       'ojt_instr_practical',
    'ojt instructor theory':          'ojt_instr_theory',
    'ojt training theory':            'ojt_training_theory',
    'ojt training practical':         'ojt_training_practical',
    'skill assessment':               'skill_assessment',
    'examiner skill test':            'examiner_skill_test',
    'examiner proficiency check':     'examiner_prof_check',
    'examiner knowledge test':        'examiner_knowledge',
    // common abbreviated variants
    'ojt instr. practical':           'ojt_instr_practical',
    'ojt instr. theory':              'ojt_instr_theory',
    'ojt training (practical)':       'ojt_training_practical',
    'ojt training (theory)':          'ojt_training_theory',
    'proficiency check':              'examiner_prof_check',
    'skill test':                     'examiner_skill_test',
    'knowledge test':                 'examiner_knowledge',
  };

  function resolveDutyType(rawText) {
    const key = String(rawText || '').trim().toLowerCase();
    return EGCA_DUTY_TYPE_MAP[key] || 'controlling';
  }

  // Convert EGCA date DD/MM/YYYY → DD-MM-YYYY (shared queue format).
  function normaliseEgcaDate(dateStr) {
    const s = String(dateStr || '').trim();
    // Already DD-MM-YYYY? pass through.
    if (/^\d{2}-\d{2}-\d{4}$/.test(s)) return s;
    // DD/MM/YYYY → DD-MM-YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s.replace(/\//g, '-');
    return s;
  }

  function parseRow(tr) {
    const getText = (idx) => cellText(tr, idx);

    // ── Raw values as-is from the table ──────────────────────────────────────
    const rawFromDate         = getText(EGCA_COL.FROM_DATE);
    const rawToDate           = getText(EGCA_COL.TO_DATE);
    const rawPostingStation   = getText(EGCA_COL.POSTING_STATION);
    const rawIcaoCode         = getText(EGCA_COL.ICAO_CODE);
    const rawAtsEgcaId        = getText(EGCA_COL.ATS_EGCA_ID);
    const rawRating           = getText(EGCA_COL.RATING);
    const rawAtsUnit          = getText(EGCA_COL.ATS_UNIT);
    const rawBriefingDone     = getText(EGCA_COL.BRIEFING_DONE);
    const rawTypeOfDuty       = getText(EGCA_COL.TYPE_OF_DUTY);
    const rawStartTime        = getText(EGCA_COL.START_TIME);
    const rawEndTime          = getText(EGCA_COL.END_TIME);
    const rawRemarks          = getText(EGCA_COL.REMARKS);
    const rawKnowledgeCheck   = getText(EGCA_COL.KNOWLEDGE_CHECK);
    const rawSkillTestCheck   = getText(EGCA_COL.SKILL_TEST_CHECK);
    const rawOjtProvidedCheck = getText(EGCA_COL.OJT_PROVIDED_CHECK);
    const rawOjtEnv           = getText(EGCA_COL.OJT_ENV);
    const rawOjtiName         = getText(EGCA_COL.OJTI_NAME);
    const rawTraineeLicense   = getText(EGCA_COL.TRAINEE_LICENSE);
    const rawInstructorName   = getText(EGCA_COL.INSTRUCTOR_NAME);
    const rawInstructorLicense= getText(EGCA_COL.INSTRUCTOR_LICENSE);
    const rawProficiencyCheck = getText(EGCA_COL.PROFICIENCY_CHECK);
    const rawNewlyEstab       = getText(EGCA_COL.NEWLY_ESTAB_STATION);

    // ── Normalised fields used by panel.js, egca-dgca-filler.js, and sorting ─
    const date     = normaliseEgcaDate(rawFromDate);   // DD-MM-YYYY
    const station  = rawIcaoCode.trim().toUpperCase(); // e.g. 'VIJP'
    const timeFrom = rawStartTime;
    const timeTo   = rawEndTime;
    const dutyType = resolveDutyType(rawTypeOfDuty);
    const atsUnit  = rawAtsUnit;

    return {
      id: rowId(date, station, timeFrom, timeTo, dutyType),
      source: 'egcaexport',

      // ── Normalised camelCase schema (shared with panel.js & filler) ─────────
      date,
      station,
      timeFrom,
      timeTo,
      atsUnit,
      dutyType,
      remarks:           rawRemarks,
      postingStationName: rawPostingStation,
      ratingText:        rawRating,
      nameOjti:          rawOjtiName,       // panel: instructor display
      instructorAtcol:   rawInstructorLicense,

      // ── egcaRaw: full raw data for egca-dgca-filler.js ───────────────────────
      egcaRaw: {
        fromDate:          normaliseEgcaDate(rawFromDate),
        toDate:            normaliseEgcaDate(rawToDate),
        postingStation:    rawPostingStation,
        icaoCode:          rawIcaoCode,
        atsEgcaId:         rawAtsEgcaId,
        rating:            rawRating,
        atsUnit:           rawAtsUnit,
        briefingDone:      rawBriefingDone,
        typeOfDuty:        rawTypeOfDuty,
        startTime:         rawStartTime,
        endTime:           rawEndTime,
        remarks:           rawRemarks,
        knowledgeCheck:    rawKnowledgeCheck,
        skillTestCheck:    rawSkillTestCheck,
        ojtProvidedCheck:  rawOjtProvidedCheck,
        ojtEnv:            rawOjtEnv,
        ojtiName:          rawOjtiName,
        traineeLicense:    rawTraineeLicense,
        instructorName:    rawInstructorName,
        instructorLicense: rawInstructorLicense,
        proficiencyCheck:  rawProficiencyCheck,
        newlyEstabStation: rawNewlyEstab,
      },
    };
  }

  let _headerInjected = false;
  let _buttonInjected = false;

  function ensureHeaderInjected() {
    if (_headerInjected) return;
    const table = document.querySelector('table');
    if (!table) return;
    
    const thead = table.querySelector('thead');
    if (!thead) return;
    
    const headerRows = thead.querySelectorAll('tr');
    if (!headerRows[0]) return;
    if (headerRows[0].querySelector('.dgca-chk-header')) return;
    
    const th = document.createElement('th');
    th.rowSpan = 1;
    th.className = 'dgca-chk-header';
    th.style.cssText = 'min-width:36px;text-align:center;vertical-align:middle;background:#f0f0f0;';
    th.innerHTML = `<input type="checkbox" id="dgca-chk-all" title="Select/Deselect all visible" style="cursor:pointer;width:16px;height:16px;">`;
    
    headerRows[0].insertBefore(th, headerRows[0].firstChild);
    
    document.addEventListener('change', (e) => {
      if (e.target.id === 'dgca-chk-all') {
        table.querySelectorAll('.dgca-row-chk').forEach(chk => {
          chk.checked = e.target.checked;
          const row = parseRowFromCheckbox(chk);
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

  function findDownloadCsvButton() {
    const bottomBtn = document.querySelector('button.btn.mb-2[onclick*="downloadEgcaCsv"]');
    if (bottomBtn) return bottomBtn;
    
    const candidates = Array.from(document.querySelectorAll('button, a.btn, a'));
    const matches = candidates.filter(el => {
      const text = el.textContent.trim().toLowerCase();
      const onclick = el.getAttribute('onclick') || '';
      return (text.includes('download') && text.includes('csv')) ||
             onclick.includes('downloadEgcaCsv');
    });
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }

  function ensureButtonInjected() {
    if (_buttonInjected) return;
    if (document.getElementById('dgca-send-btn')) { _buttonInjected = true; return; }
    
    const downloadBtn = findDownloadCsvButton();
    
    const wrapper = document.createElement('div');
    wrapper.id = 'dgca-inline-btn-wrapper';
    wrapper.style.cssText = 'display:inline-flex; align-items:center; gap:10px; margin-left:12px; vertical-align:middle;';
    
    const sendBtn = document.createElement('button');
    sendBtn.id = 'dgca-send-btn';
    sendBtn.className = 'btn btn-success btn-sm';
    sendBtn.style.cssText = 'font-weight:600; padding:8px 16px;';
    sendBtn.textContent = '✈ Add to DGCA Queue ▶';
    
    const badge = document.createElement('span');
    badge.id = 'dgca-sel-count';
    badge.style.cssText = 'font-size:14px; color:#28a745; font-weight:600;';
    badge.textContent = '0 selected';
    
    const userWarn = document.createElement('span');
    userWarn.id = 'dgca-user-warn';
    userWarn.style.cssText = 'font-size:13px; color:#c0392b; font-weight:700; display:none;';
    
    wrapper.appendChild(sendBtn);
    wrapper.appendChild(badge);
    wrapper.appendChild(userWarn);
    
    if (downloadBtn) {
      downloadBtn.parentNode.insertBefore(wrapper, downloadBtn.nextSibling);
    } else {
      console.warn('[DGCA EGCA Injector] Could not find Download CSV button; falling back to top injection.');
      const btnContainer = document.querySelector('.col-md-12') || document.querySelector('form') || document.body;
      const fallbackWrap = document.createElement('div');
      fallbackWrap.style.cssText = 'margin:15px 0; display:flex; align-items:center; gap:10px;';
      fallbackWrap.appendChild(wrapper);
      
      const firstBtn = btnContainer.querySelector('button');
      if (firstBtn) btnContainer.insertBefore(fallbackWrap, firstBtn);
      else btnContainer.prepend(fallbackWrap);
    }
    
    sendBtn.addEventListener('click', onSendClick);
    _buttonInjected = true;
    refreshUserMismatchIndicator();
    
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && (changes.dgca_pending_rows || changes.dgca_queue_user)) {
        refreshUserMismatchIndicator();
      }
    });
  }

  function injectCheckboxesIntoTable(table) {
    table.querySelectorAll('td.dgca-chk-cell').forEach(td => td.remove());
    const rows = table.querySelectorAll('tr');
    const startIndex = rows[0] && rows[0].querySelector('th') ? 1 : 0;
    
    for (let i = startIndex; i < rows.length; i++) {
      const tr = rows[i];
      const td = document.createElement('td');
      td.className = 'dgca-chk-cell';
      td.style.cssText = 'text-align:center;vertical-align:middle;border:1px solid #ddd;min-width:36px;';
      
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
    }
    
    _offset = 1;
    updateSelectionBadge();
    
    const chkAll = document.getElementById('dgca-chk-all');
    if (chkAll) {
      const all = table.querySelectorAll('.dgca-row-chk');
      const checked = table.querySelectorAll('.dgca-row-chk:checked');
      if (all.length === 0) { chkAll.indeterminate = false; chkAll.checked = false; }
      else {
        chkAll.checked = checked.length === all.length;
        chkAll.indeterminate = checked.length > 0 && checked.length < all.length;
      }
    }
    
    table._dgcaListenerAttached = true;
    table.addEventListener('change', (e) => {
      if (!e.target.classList.contains('dgca-row-chk')) return;
      const tr = e.target.closest('tr');
      if (!tr || !isDataRow(tr)) return;
      
      // ✅ _offset is already 1 because the checkbox cell is present in the DOM
      const row = parseRow(tr);
      
      if (!row) return;
      
      if (e.target.checked) _selectedRows[row.id] = row;
      else delete _selectedRows[row.id];
      
      updateSelectionBadge();
      
      if (chkAll) {
        const all = table.querySelectorAll('.dgca-row-chk');
        const checked = table.querySelectorAll('.dgca-row-chk:checked');
        chkAll.checked = checked.length === all.length;
        chkAll.indeterminate = checked.length > 0 && checked.length < all.length;
      }
    });
  }

  function escAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function parseRowFromCheckbox(chk) {
    const tr = chk.closest('tr');
    if (!tr || !isDataRow(tr)) return null;
    
    // ✅ _offset is already 1
    const row = parseRow(tr);
    
    return row;
  }

  function updateSelectionBadge() {
    const badge = document.getElementById('dgca-sel-count');
    if (badge) badge.textContent = `${Object.keys(_selectedRows).length} selected`;
  }

  function rowSortKey(row) {
    // date is normalised to DD-MM-YYYY by parseRow
    const [d, m, y] = String(row.date || '').split('-');
    const dateKey = `${y || '0000'}${m || '00'}${d || '00'}`;
    const timeKey = String(row.timeFrom || '00:00').replace(':', '');
    return `${dateKey}${timeKey}`;
  }

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
    try { chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }); } catch (_) { }
    
    const newRows = Object.values(_selectedRows);
    if (newRows.length === 0) {
      alert('No rows selected. Please check at least one row.');
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
          alert(`⚠ AAI user has changed.\n\nThe current queue was built while logged in as "${queueUser.name}", but you are now logged in as "${currentUser.name}".\n\nPlease clear the queue first.`);
          return;
        }
        
        if (isSourceMismatch(existing, 'egcaexport')) {
          const existingSourceLabel = existing[0].source === 'mylogbook' ? 'MyLogBook' : existing[0].source;
          alert(`⚠ Mixed source queue.\n\nThe current queue already contains rows from "${existingSourceLabel}". Adding EGCA Export rows to the same queue would cause them to be filled incorrectly.\n\nPlease clear (or finish/submit) the existing queue first.`);
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

  function setup() {
    if (!window.DGCA) {
      console.error('[egca-export-injector] shared.js not loaded yet');
      return;
    }
    
    const table = document.querySelector('table');
    if (!table) {
      const obs = new MutationObserver((_, o) => {
        const tb = document.querySelector('table');
        if (tb) { o.disconnect(); setup(); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      return;
    }
    
    ensureHeaderInjected();
    ensureButtonInjected();
    injectCheckboxesIntoTable(table);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();