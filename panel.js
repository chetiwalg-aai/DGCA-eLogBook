/**
sidepanel/panel.js
Side panel UI logic — standalone, no imports.
*/
const DUTY_TYPE = {
  CONTROLLING: 'controlling',
  OJT_INSTR_PRACTICAL: 'ojt_instr_practical',
  OJT_INSTR_THEORY: 'ojt_instr_theory',
  OJT_TRAINING_THEORY: 'ojt_training_theory',
  OJT_TRAINING_PRACTICAL: 'ojt_training_practical',
  SKILL_ASSESSMENT: 'skill_assessment',
  EXAMINER_SKILL_TEST: 'examiner_skill_test',
  EXAMINER_PROF_CHECK: 'examiner_prof_check',
  EXAMINER_KNOWLEDGE: 'examiner_knowledge',
};
const ROW_STATUS = {
  PENDING: 'pending',
  FILLING: 'filling',
  SUBMITTED: 'submitted',
  ERROR: 'error',
  SKIPPED: 'skipped',
};
const DUTY_LABEL = {
  [DUTY_TYPE.CONTROLLING]: 'Controlling',
  [DUTY_TYPE.OJT_INSTR_PRACTICAL]: 'OJT Instr. Practical',
  [DUTY_TYPE.OJT_INSTR_THEORY]: 'OJT Instr. Theory',
  [DUTY_TYPE.OJT_TRAINING_THEORY]: 'OJT Training Theory',
  [DUTY_TYPE.OJT_TRAINING_PRACTICAL]: 'OJT Training Practical',
  [DUTY_TYPE.SKILL_ASSESSMENT]: 'Skill Assessment',
  [DUTY_TYPE.EXAMINER_SKILL_TEST]: 'Examiner: Skill Test',
  [DUTY_TYPE.EXAMINER_PROF_CHECK]: 'Examiner: Prof. Check',
  [DUTY_TYPE.EXAMINER_KNOWLEDGE]: 'Examiner: Knowledge',
};
const PILL_CLASS = {
  [ROW_STATUS.PENDING]: 'pill--pending',
  [ROW_STATUS.FILLING]: 'pill--filling',
  [ROW_STATUS.SUBMITTED]: 'pill--submitted',
  [ROW_STATUS.ERROR]: 'pill--error',
  [ROW_STATUS.SKIPPED]: 'pill--skipped',
};
const PILL_LABEL = {
  [ROW_STATUS.PENDING]: 'Pending',
  [ROW_STATUS.FILLING]: 'Filling…',
  [ROW_STATUS.SUBMITTED]: '✓ Added',
  [ROW_STATUS.ERROR]: '✗ Error',
  [ROW_STATUS.SKIPPED]: '— Skip',
};

const WSO_LABEL_MAP = {
  'VIJP': { labelWSO: 'vijpwso', labelATS: 'VIJP_ATS' },
};
function getWsoLabels(stationCode) {
  const entry = WSO_LABEL_MAP[String(stationCode || 'VIJP').trim().toUpperCase()];
  return entry || { labelWSO: 'WSO', labelATS: 'ATS' };
}

function refreshWsoLabel(rows) {
  if (!wsoAtsLabel) return;
  const freq = {};
  (rows || []).forEach(r => { const s = String(r.station || 'VIJP').toUpperCase(); freq[s] = (freq[s] || 0) + 1; });
  const dominant = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0] || 'VIJP';
  const { labelWSO, labelATS } = getWsoLabels(dominant);
  wsoAtsLabel.innerHTML = `Use <strong>${labelATS}</strong> as WSO/EGCA-Id <span style="color:#555;font-size:10px;">(alt: ${labelWSO})</span>`;
}

const OJT_DUTY_TYPES = new Set([
  DUTY_TYPE.OJT_INSTR_PRACTICAL, DUTY_TYPE.OJT_INSTR_THEORY,
  DUTY_TYPE.OJT_TRAINING_THEORY, DUTY_TYPE.OJT_TRAINING_PRACTICAL,
  DUTY_TYPE.SKILL_ASSESSMENT, DUTY_TYPE.EXAMINER_SKILL_TEST,
  DUTY_TYPE.EXAMINER_PROF_CHECK, DUTY_TYPE.EXAMINER_KNOWLEDGE,
]);

function rowSortKey(row) {
  // Handles DD-MM-YYYY (mylogbook) and DD/MM/YYYY (legacy egca) gracefully
  const sep = String(row.date || '').includes('/') ? '/' : '-';
  const [d, m, y] = String(row.date || '').split(sep);
  const dateKey = `${y || '0000'}${m || '00'}${d || '00'}`;
  const timeKey = String(row.timeFrom || '00:00').replace(':', '');
  return `${dateKey}${timeKey}`;
}

function sortQueue(rows, statuses, errors) {
  const indexed = rows.map((row, i) => ({
    row, status: statuses[i] || ROW_STATUS.PENDING, error: errors[i] || null, key: rowSortKey(row),
  }));
  indexed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const sortedRows = indexed.map(x => x.row);
  const sortedStatuses = indexed.map(x => x.status);
  const sortedErrors = {};
  indexed.forEach((x, i) => { if (x.error) sortedErrors[i] = x.error; });
  return { rows: sortedRows, statuses: sortedStatuses, errors: sortedErrors };
}

const state = {
  rows: [], statuses: [], errors: {},
  sessionRunning: false, dgcaTabReady: false, useAts: false, queueUser: null,
};

const $ = id => document.getElementById(id);
const badge = $('badge');
const queueSection = $('queue-section');
const queueCount = $('queue-count');
const wsoAtsToggle = $('wso-ats-toggle');
const dgcaTabStatus = $('dgca-tab-status');
const progressSection = $('progress-section');
const progressText = $('progress-text');
const progressStats = $('progress-stats');
const progressFill = $('progress-fill');
const btnStart = $('btn-start');
const btnAbort = $('btn-abort');
const btnClearSuccess = $('btn-clear-success');
const btnClear = $('btn-clear');
const wsoAtsLabel = $('wso-ats-label');
const btnCheckDgca = $('btn-check-dgca');
const rowListSection = $('row-list-section');
const rowList = $('row-list');
const queueUserInfo = $('queue-user-info');
const errorBackdrop = $('error-backdrop');
const errorModalRowNum = $('error-modal-row-num');
const errorModalMsg = $('error-modal-msg');
const errorModalClose = $('error-modal-close');

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setBadge(label, cls) {
  badge.textContent = label;
  badge.className = `badge badge--${cls}`;
}

function dutyLabel(dutyType) { return DUTY_LABEL[dutyType] || dutyType; }
function getPillClass(status) { return PILL_CLASS[status] || PILL_CLASS[ROW_STATUS.PENDING]; }
function getPillLabel(status) { return PILL_LABEL[status] || PILL_LABEL[ROW_STATUS.PENDING]; }

function loadFromStorage() {
  chrome.storage.session.get(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_session_ts', 'dgca_use_ats', 'dgca_queue_user'])
    .then((data) => {
      state.useAts = !!(data?.dgca_use_ats);
      wsoAtsToggle.checked = state.useAts;
      state.queueUser = data?.dgca_queue_user || null;
      const rows = data?.dgca_pending_rows || [];
      const statuses = data?.dgca_row_status || [];
      const errors = data?.dgca_row_errors || {};
      
      const sorted = sortQueue(rows, statuses, errors);
      state.rows = sorted.rows;
      state.statuses = sorted.statuses;
      state.errors = sorted.errors;
      
      if (rows.length > 0) {
        renderQueueSection(state.rows);
        renderQueueUser(state.queueUser);
        renderRowList(state.rows, state.statuses, state.errors);
        checkDgcaTab();
      } else {
        queueSection.style.display = 'none';
        rowListSection.style.display = 'none';
        btnStart.disabled = true;
        setBadge('Idle', 'idle');
        renderQueueUser(null);
      }
    }).catch(() => { });
}

function renderQueueUser(user) {
  if (!queueUserInfo) return;
  if (!user || (!user.name && !user.loginId)) {
    queueUserInfo.style.display = 'none';
    return;
  }
  const name = user.name || user.loginId;
  const loginBadge = (user.loginId && user.loginId !== name) ? `<span class="queue-user-login">(${escHtml(user.loginId)})</span>` : '';
  queueUserInfo.className = 'queue-user-info';
  queueUserInfo.innerHTML = `👤 Queued for <strong>${escHtml(name)}</strong>${loginBadge}`;
  queueUserInfo.style.display = 'flex';
}

function renderQueueSection(rows) {
  queueSection.style.display = 'block';
  queueCount.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} queued`;
  btnStart.disabled = false;
  setBadge('Ready', 'done');
  refreshWsoLabel(rows);

  // NEW: Dynamically highlight the data source
  const sourceBadge = $('source-badge');
  if (sourceBadge && rows.length > 0) {
    const source = rows[0].source || 'mylogbook'; // Assume uniform source per queue
    const sourceText = source === 'egcaexport' ? 'EGCA Export' : 'MyLogBook';
    const sourceClass = source === 'egcaexport' ? 'source-badge--egcaexport' : 'source-badge--mylogbook';
    sourceBadge.textContent = `Source: ${sourceText}`;
    sourceBadge.className = `source-badge ${sourceClass}`;
  }
}

function renderRowList(rows, statuses, errors) {
  rowListSection.style.display = 'block';
  rowList.innerHTML = rows.map((row, i) => {
    const status = statuses[i] || ROW_STATUS.PENDING;
    const error = errors[i] || null;
    const pillClass = getPillClass(status);
    const pillLabel = getPillLabel(status);
    const errorAttr = error ? `data-error-idx="${i}" style="cursor:pointer;text-decoration:underline dotted;"` : '';

    const isEgca = row.source === 'egcaexport';
    const raw = row.egcaRaw || {};

    // ── ATS unit chip ─────────────────────────────────────────────────────────
    // For EGCA rows use the normalised atsUnit field (same field, consistent name).
    const atsHtml = row.atsUnit
      ? `<span class="row-item__ats">${escHtml(row.atsUnit)}</span>`
      : '';

    // ── Duty label ────────────────────────────────────────────────────────────
    // dutyType is now always a DUTY_TYPE constant for both sources.
    // For EGCA we also show the raw portal text in a tooltip for traceability.
    const dutyTitle = isEgca && raw.typeOfDuty ? ` title="${escHtml(raw.typeOfDuty)}"` : '';
    const dutyHtml  = `<span class="row-item__duty"${dutyTitle}>${dutyLabel(raw.typeOfDuty)}</span>`;

    // ── Instructor chip ───────────────────────────────────────────────────────
    let instrHtml = '';
    if (OJT_DUTY_TYPES.has(row.dutyType)) {
      // mylogbook: nameOjti is the instructor name string
      // egcaexport: nameOjti is mapped from OJTI_NAME; raw.instructorName is the filler's instructor
      const instrName = row.nameOjti || (isEgca ? raw.instructorName : '');
      if (instrName) {
        instrHtml = `<span class="row-item__instr" title="Instructor">👤 ${escHtml(instrName)}</span>`;
      }
    }

    // ── Trainee chip ──────────────────────────────────────────────────────────
    let traineeHtml = '';
    if (isEgca) {
      // For EGCA rows the trainee is identified by their license number from raw data
      const traineeLic = raw.traineeLicense;
      const traineeName = raw.ojtiName || '';  // OJTI_NAME col in egca can hold trainee info
      if (traineeLic) {
        const label = traineeName ? `${traineeName} (${traineeLic})` : traineeLic;
        const icon  = row.dutyType === DUTY_TYPE.OJT_INSTR_THEORY ? '📚' : '🎓';
        traineeHtml = `<span class="row-item__trainee" title="Trainee">${icon} ${escHtml(label)}</span>`;
      }
    } else {
      // mylogbook rows
      if (row.dutyType === DUTY_TYPE.OJT_INSTR_PRACTICAL && row.pNameTrainee) {
        traineeHtml = `<span class="row-item__trainee" title="Trainee (Practical)">🎓 ${escHtml(row.pNameTrainee)}</span>`;
      } else if (row.dutyType === DUTY_TYPE.OJT_INSTR_THEORY && row.tNameTrainee) {
        traineeHtml = `<span class="row-item__trainee" title="Trainee (Theory)">📚 ${escHtml(row.tNameTrainee)}</span>`;
      }
    }

    // ── EGCA-only: posting station hint ───────────────────────────────────────
    const stationHint = isEgca && row.postingStationName
      ? `<span class="row-item__duty" style="color:#ba68c8;font-size:10px;" title="Posting station">${escHtml(row.postingStationName)}</span>`
      : '';

    return `
      <div class="row-item" id="row-item-${i}">
        <div class="row-item__info">
          <span class="row-item__num">${i + 1}</span>
          <span class="row-item__date">${escHtml(row.date)}</span>
          <span class="row-item__time">${escHtml(row.timeFrom)}–${escHtml(row.timeTo)}</span>
          ${atsHtml}
          ${dutyHtml}
          ${stationHint}
          ${instrHtml}
          ${traineeHtml}
        </div>
        <span id="pill-${i}" class="pill ${pillClass}" ${errorAttr}>${pillLabel}</span>
        <button class="row-item__delete" data-delete-idx="${i}" title="Remove from queue">×</button>
      </div>`;
  }).join('');

  rowList.querySelectorAll('[data-error-idx]').forEach(el => {
    el.addEventListener('click', () => showErrorModal(parseInt(el.dataset.errorIdx, 10)));
  });
  rowList.querySelectorAll('[data-delete-idx]').forEach(el => {
    el.addEventListener('click', () => deleteRow(parseInt(el.dataset.deleteIdx, 10)));
  });
}

function updateRowStatus(index, status, error) {
  state.statuses[index] = status;
  if (error) state.errors[index] = error;
  const item = $(`row-item-${index}`);
  const pill = $(`pill-${index}`);
  if (!item || !pill) return;
  
  pill.className = `pill ${getPillClass(status)}`;
  pill.textContent = getPillLabel(status);
  
  if (status === ROW_STATUS.ERROR && error) {
    pill.setAttribute('data-error-idx', index);
    pill.style.cursor = 'pointer';
    pill.style.textDecoration = 'underline dotted';
    pill.title = 'Click to see error details';
    pill.onclick = () => showErrorModal(index);
  } else {
    pill.removeAttribute('data-error-idx');
    pill.style.cursor = '';
    pill.style.textDecoration = '';
    pill.title = '';
    pill.onclick = null;
  }
  item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function deleteRow(index) {
  if (state.sessionRunning) { alert('Cannot remove rows while session is running.'); return; }
  if (!confirm(`Remove row ${index + 1} (${state.rows[index]?.date || ''}) from queue?`)) return;
  
  state.rows.splice(index, 1);
  state.statuses.splice(index, 1);
  const newErrors = {};
  Object.keys(state.errors).forEach(k => {
    const ki = parseInt(k, 10);
    if (ki < index) newErrors[ki] = state.errors[ki];
    else if (ki > index) newErrors[ki - 1] = state.errors[ki];
  });
  state.errors = newErrors;
  
  chrome.storage.session.set({ dgca_pending_rows: state.rows, dgca_row_status: state.statuses, dgca_row_errors: state.errors })
    .then(() => {
      if (state.rows.length === 0) {
        queueSection.style.display = 'none';
        rowListSection.style.display = 'none';
        btnStart.disabled = true;
        setBadge('Idle', 'idle');
      } else {
        renderQueueSection(state.rows);
        renderRowList(state.rows, state.statuses, state.errors);
      }
    }).catch(() => { });
}

function showErrorModal(index) {
  const err = state.errors[index] || 'Unknown error';
  errorModalRowNum.textContent = index + 1;
  errorModalMsg.textContent = err;
  errorBackdrop.style.display = 'flex';
}
errorModalClose.addEventListener('click', () => { errorBackdrop.style.display = 'none'; });
errorBackdrop.addEventListener('click', (e) => {
  if (e.target === errorBackdrop || e.target.classList.contains('error-modal__backdrop')) {
    errorBackdrop.style.display = 'none';
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') errorBackdrop.style.display = 'none'; });

function checkDgcaTab() {
  dgcaTabStatus.textContent = 'DGCA tab: checking…';
  dgcaTabStatus.className = 'tab-status tab-status--checking';
  chrome.runtime.sendMessage({ type: 'PING_DGCA_TAB' }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) {
      dgcaTabStatus.textContent = '✗ DGCA tab not ready — open & navigate to entry page';
      dgcaTabStatus.className = 'tab-status tab-status--error';
      state.dgcaTabReady = false;
    } else {
      dgcaTabStatus.textContent = '✓ DGCA tab ready';
      dgcaTabStatus.className = 'tab-status tab-status--ready';
      state.dgcaTabReady = true;
    }
  });
}
btnCheckDgca.addEventListener('click', checkDgcaTab);

wsoAtsToggle.addEventListener('change', () => {
  state.useAts = wsoAtsToggle.checked;
  chrome.storage.session.set({ dgca_use_ats: state.useAts }).catch(() => { });
  const { labelWSO, labelATS } = getWsoLabels((state.rows[0]?.station || 'VIJP').toUpperCase());
  // log(`WSO/EGCA-Id set to: ${state.useAts ? labelATS : labelWSO}`, 'ok'); // Uncomment if logEl exists
});

btnStart.addEventListener('click', () => {
  if (state.rows.length === 0) { return; }
  const resorted = sortQueue(state.rows, state.rows.map(() => ROW_STATUS.PENDING), {});
  state.rows = resorted.rows;
  state.statuses = state.rows.map(() => ROW_STATUS.PENDING);
  state.errors = {};
  state.sessionRunning = true;
  
  chrome.storage.session.set({ dgca_pending_rows: state.rows, dgca_row_status: state.statuses, dgca_row_errors: {} }).catch(() => { });
  
  progressSection.style.display = 'block';
  progressText.textContent = 'Starting…';
  progressStats.textContent = '';
  progressFill.style.width = '0%';
  btnStart.disabled = true;
  btnAbort.style.display = 'inline-block';
  wsoAtsToggle.disabled = true;
  setBadge('Running', 'running');
  
  const _wsoLabels = getWsoLabels((state.rows[0]?.station || 'VIJP').toUpperCase());
  renderRowList(state.rows, state.statuses, state.errors);
  
  chrome.runtime.sendMessage({ type: 'REQUEST_START_FILLING' }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) {
      const err = resp?.error || chrome.runtime.lastError?.message || 'Unknown error';
      setBadge('Error', 'error');
      btnStart.disabled = false;
      btnAbort.style.display = 'none';
      progressSection.style.display = 'none';
      wsoAtsToggle.disabled = false;
      state.sessionRunning = false;
    }
  });
});

btnAbort.addEventListener('click', () => {
  if (!confirm('Abort the current session?')) return;
  chrome.runtime.sendMessage({ type: 'REQUEST_ABORT' });
  state.sessionRunning = false;
  setBadge('Idle', 'idle');
  btnAbort.style.display = 'none';
  btnStart.disabled = false;
  wsoAtsToggle.disabled = false;
  progressSection.style.display = 'none';
});

function clearSuccessRows() {
  if (state.sessionRunning) { alert('Cannot clear while session is running.'); return; }
  const submittedCount = state.statuses.filter(s => s === ROW_STATUS.SUBMITTED).length;
  if (submittedCount === 0) { return; }
  
  const keepIndices = state.rows.map((_, i) => i).filter(i => state.statuses[i] !== ROW_STATUS.SUBMITTED);
  const newRows = keepIndices.map(i => state.rows[i]);
  const newStatuses = keepIndices.map(i => state.statuses[i]);
  const newErrors = {};
  keepIndices.forEach((oldIdx, newIdx) => { if (state.errors[oldIdx]) newErrors[newIdx] = state.errors[oldIdx]; });
  
  state.rows = newRows;
  state.statuses = newStatuses;
  state.errors = newErrors;
  
  chrome.storage.session.set({ dgca_pending_rows: state.rows, dgca_row_status: state.statuses, dgca_row_errors: state.errors })
    .then(() => {
      if (state.rows.length === 0) {
        queueSection.style.display = 'none';
        rowListSection.style.display = 'none';
        btnStart.disabled = true;
        setBadge('Idle', 'idle');
      } else {
        renderQueueSection(state.rows);
        renderRowList(state.rows, state.statuses, state.errors);
      }
    }).catch(() => { });
}
btnClearSuccess.addEventListener('click', clearSuccessRows);

btnClear.addEventListener('click', () => {
  if (state.sessionRunning) { alert('Cannot clear while session is running.'); return; }
  chrome.storage.session.remove(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_session_ts', 'dgca_queue_user'])
    .then(() => {
      state.rows = []; state.statuses = []; state.errors = {}; state.queueUser = null;
      queueSection.style.display = 'none';
      rowListSection.style.display = 'none';
      btnStart.disabled = true;
      setBadge('Idle', 'idle');
      renderQueueUser(null);
    }).catch(() => { });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ROWS_READY') {
    loadFromStorage();
    return;
  }
  if (msg.type === 'FILL_PROGRESS') {
    const { index, total, status, error } = msg;
    if (status === 'session-complete') {
      state.sessionRunning = false;
      wsoAtsToggle.disabled = false;
      const summary = `${msg.done} added, ${msg.errors} errors`;
      setBadge('Done', 'done');
      btnAbort.style.display = 'none';
      btnStart.disabled = false;
      progressText.textContent = `Done — ${summary}`;
      return;
    }
    if (status === 'session-error') {
      state.sessionRunning = false;
      setBadge('Error', 'error');
      btnAbort.style.display = 'none';
      btnStart.disabled = false;
      wsoAtsToggle.disabled = false;
      progressText.textContent = 'Session failed — see log';
      return;
    }
    if (status) {
      updateRowStatus(index, status, error);
      const done = state.statuses.filter(s => s === ROW_STATUS.SUBMITTED).length;
      const errCnt = state.statuses.filter(s => s === ROW_STATUS.ERROR).length;
      const proc = done + errCnt;
      const pct = total > 0 ? Math.round((proc / total) * 100) : 0;
      progressText.textContent = `Row ${index + 1} / ${total} — ${status}`;
      progressStats.textContent = `${done} added · ${errCnt} errors`;
      progressFill.style.width = `${pct}%`;
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && (changes.dgca_pending_rows || changes.dgca_queue_user)) {
    loadFromStorage();
  }
});

loadFromStorage();
checkDgcaTab();