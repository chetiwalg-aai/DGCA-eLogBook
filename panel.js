/**
 * sidepanel/panel.js
 * Side panel UI logic — standalone, no imports.
 */

// ── Inlined constants (must stay in sync with shared.js) ─────────────────────
const DUTY_TYPE = {
  CONTROLLING:            'controlling',
  OJT_INSTR_PRACTICAL:    'ojt_instr_practical',
  OJT_INSTR_THEORY:       'ojt_instr_theory',
  OJT_TRAINING_THEORY:    'ojt_training_theory',
  OJT_TRAINING_PRACTICAL: 'ojt_training_practical',
  SKILL_ASSESSMENT:       'skill_assessment',
  EXAMINER_SKILL_TEST:    'examiner_skill_test',
  EXAMINER_PROF_CHECK:    'examiner_prof_check',
  EXAMINER_KNOWLEDGE:     'examiner_knowledge',
};

const ROW_STATUS = {
  PENDING:   'pending',
  FILLING:   'filling',
  SUBMITTED: 'submitted',
  ERROR:     'error',
  SKIPPED:   'skipped',
};

const DUTY_LABEL = {
  [DUTY_TYPE.CONTROLLING]:            'Controlling',
  [DUTY_TYPE.OJT_INSTR_PRACTICAL]:    'OJT Instr. Practical',
  [DUTY_TYPE.OJT_INSTR_THEORY]:       'OJT Instr. Theory',
  [DUTY_TYPE.OJT_TRAINING_THEORY]:    'OJT Training Theory',
  [DUTY_TYPE.OJT_TRAINING_PRACTICAL]: 'OJT Training Practical',
  [DUTY_TYPE.SKILL_ASSESSMENT]:       'Skill Assessment',
  [DUTY_TYPE.EXAMINER_SKILL_TEST]:    'Examiner: Skill Test',
  [DUTY_TYPE.EXAMINER_PROF_CHECK]:    'Examiner: Prof. Check',
  [DUTY_TYPE.EXAMINER_KNOWLEDGE]:     'Examiner: Knowledge',
};

const PILL_CLASS = {
  [ROW_STATUS.PENDING]:   'pill--pending',
  [ROW_STATUS.FILLING]:   'pill--filling',
  [ROW_STATUS.SUBMITTED]: 'pill--submitted',
  [ROW_STATUS.ERROR]:     'pill--error',
  [ROW_STATUS.SKIPPED]:   'pill--skipped',
};

const PILL_LABEL = {
  [ROW_STATUS.PENDING]:   'Pending',
  [ROW_STATUS.FILLING]:   'Filling…',
  [ROW_STATUS.SUBMITTED]: '✓ Added',
  [ROW_STATUS.ERROR]:     '✗ Error',
  [ROW_STATUS.SKIPPED]:   '— Skip',
};

// ── Per-station WSO labels (must stay in sync with shared.js WSO_MAP) ─────────
const WSO_LABEL_MAP = {
  'VIJP': { labelWSO: 'vijpwso', labelATS: 'VIJP_ATS' },
  // Add new stations here as you add them to shared.js WSO_MAP
};

function getWsoLabels(stationCode) {
  const entry = WSO_LABEL_MAP[String(stationCode || 'VIJP').trim().toUpperCase()];
  return entry || { labelWSO: 'WSO', labelATS: 'ATS' };
}

/** Update the WSO toggle label based on the dominant station in the queue. */
function refreshWsoLabel(rows) {
  if (!wsoAtsLabel) return;
  // Pick the most common station in the queue (fallback: VIJP)
  const freq = {};
  (rows || []).forEach(r => { const s = String(r.station || 'VIJP').toUpperCase(); freq[s] = (freq[s] || 0) + 1; });
  const dominant = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0] || 'VIJP';
  const { labelWSO, labelATS } = getWsoLabels(dominant);
  wsoAtsLabel.innerHTML = `Use <strong>${labelATS}</strong> as WSO/EGCA-Id <span style="color:#555;font-size:10px;">(alt: ${labelWSO})</span>`;
}

const OJT_DUTY_TYPES = new Set([
  DUTY_TYPE.OJT_INSTR_PRACTICAL,
  DUTY_TYPE.OJT_INSTR_THEORY,
  DUTY_TYPE.OJT_TRAINING_THEORY,
  DUTY_TYPE.OJT_TRAINING_PRACTICAL,
  DUTY_TYPE.SKILL_ASSESSMENT,
  DUTY_TYPE.EXAMINER_SKILL_TEST,
  DUTY_TYPE.EXAMINER_PROF_CHECK,
  DUTY_TYPE.EXAMINER_KNOWLEDGE,
]);

// ── Sort utility ──────────────────────────────────────────────────────────────
/**
 * Convert a row's date (DD-MM-YYYY) + timeFrom (HH:MM) into a single
 * comparable string "YYYYMMDDHHMMM" so rows sort chronologically.
 */
function rowSortKey(row) {
  const [d, m, y] = String(row.date || '').split('-');
  const dateKey = `${y || '0000'}${m || '00'}${d || '00'}`;
  const timeKey = String(row.timeFrom || '00:00').replace(':', '');
  return `${dateKey}${timeKey}`;
}

/**
 * Sort rows + their parallel statuses/errors by date+time ascending.
 * Always returns a new set of arrays — never mutates in place.
 */
function sortQueue(rows, statuses, errors) {
  const indexed = rows.map((row, i) => ({
    row,
    status: statuses[i] || ROW_STATUS.PENDING,
    error:  errors[i]   || null,
    key:    rowSortKey(row),
  }));
  indexed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const sortedRows     = indexed.map(x => x.row);
  const sortedStatuses = indexed.map(x => x.status);
  const sortedErrors   = {};
  indexed.forEach((x, i) => { if (x.error) sortedErrors[i] = x.error; });
  return { rows: sortedRows, statuses: sortedStatuses, errors: sortedErrors };
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  rows:           [],
  statuses:       [],
  errors:         {},
  sessionRunning: false,
  dgcaTabReady:   false,
  useAts:         false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const badge            = $('badge');
const instructions     = $('instructions');
const queueSection     = $('queue-section');
const queueCount       = $('queue-count');
const wsoAtsToggle     = $('wso-ats-toggle');
const dgcaTabStatus    = $('dgca-tab-status');
const progressSection  = $('progress-section');
const progressText     = $('progress-text');
const progressStats    = $('progress-stats');
const progressFill     = $('progress-fill');
const btnStart         = $('btn-start');
const btnAbort         = $('btn-abort');
const btnClearSuccess  = $('btn-clear-success');
const btnClear         = $('btn-clear');
const wsoAtsLabel      = $('wso-ats-label');
const btnCheckDgca     = $('btn-check-dgca');
const rowListSection   = $('row-list-section');
const rowList          = $('row-list');
const errorModal       = $('error-modal');
const errorBackdrop    = $('error-backdrop');
const errorModalRowNum = $('error-modal-row-num');
const errorModalMsg    = $('error-modal-msg');
const errorModalClose  = $('error-modal-close');
const logEl            = $('log');

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg, type = '') {
  logEl.innerHTML = `<span class="log__entry log__entry--${type}">${escHtml(msg)}</span>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')   // ← FIXED: was no-op
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setBadge(label, cls) {
  badge.textContent = label;
  badge.className   = `badge badge--${cls}`;
}

function dutyLabel(dutyType) {
  return DUTY_LABEL[dutyType] || dutyType;
}

function getPillClass(status) {
  return PILL_CLASS[status] || PILL_CLASS[ROW_STATUS.PENDING];
}

function getPillLabel(status) {
  return PILL_LABEL[status] || PILL_LABEL[ROW_STATUS.PENDING];
}

// ── Load state from storage ──────────────────────────────────────────────────
// Everything lives in chrome.storage.session — clears automatically on browser close.
function loadFromStorage() {
  chrome.storage.session.get(
    ['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_session_ts', 'dgca_use_ats']
  ).then((data) => {
    state.useAts         = !!(data?.dgca_use_ats);
    wsoAtsToggle.checked = state.useAts;

    const rows     = data?.dgca_pending_rows || [];
    const statuses = data?.dgca_row_status   || [];
    const errors   = data?.dgca_row_errors   || {};

    // Always display (and process) in chronological order regardless of
    // the order in which rows were added to the queue.
    const sorted = sortQueue(rows, statuses, errors);
    state.rows     = sorted.rows;
    state.statuses = sorted.statuses;
    state.errors   = sorted.errors;

    if (rows.length > 0) {
      renderQueueSection(state.rows);
      renderRowList(state.rows, state.statuses, state.errors);
      checkDgcaTab();
    } else {
      queueSection.style.display   = 'none';
      rowListSection.style.display = 'none';
      btnStart.disabled            = true;
      setBadge('Idle', 'idle');
    }
  }).catch(() => {});
}

// ── Render queue section (count only) ─────────────────────────────────────────
function renderQueueSection(rows) {
  queueSection.style.display = 'block';
  queueCount.textContent     = `${rows.length} row${rows.length === 1 ? '' : 's'} queued`;
  btnStart.disabled = false;
  setBadge('Ready', 'done');
  refreshWsoLabel(rows);
}

// ── Render full row list ──────────────────────────────────────────────────────
function renderRowList(rows, statuses, errors) {
  rowListSection.style.display = 'block';
  rowList.innerHTML = rows.map((row, i) => {
    const status = statuses[i] || ROW_STATUS.PENDING;
    const error  = errors[i]   || null;

    const pillClass = getPillClass(status);
    const pillLabel = getPillLabel(status);

    // ← FIXED: Always add data-error-idx if there's an error
    const errorAttr = error
      ? `data-error-idx="${i}" style="cursor:pointer;text-decoration:underline dotted;"`
      : '';

    const atsHtml = row.atsUnit
      ? `<span class="row-item__ats">${escHtml(row.atsUnit)}</span>`
      : '';

    let instrHtml = '';
    if (OJT_DUTY_TYPES.has(row.dutyType) && row.nameOjti) {
      instrHtml = `<span class="row-item__instr" title="Instructor">👤 ${escHtml(row.nameOjti)}</span>`;
    }

    return `
      <div class="row-item" id="row-item-${i}">
        <div class="row-item__info">
          <span class="row-item__num">${i + 1}</span>
          <span class="row-item__date">${row.date}</span>
          <span class="row-item__time">${row.timeFrom}–${row.timeTo}</span>
          ${atsHtml}
          <span class="row-item__duty">${dutyLabel(row.dutyType)}</span>
          ${instrHtml}
        </div>
        <span id="pill-${i}" class="pill ${pillClass}" ${errorAttr}>${pillLabel}</span>
        <button class="row-item__delete" data-delete-idx="${i}" title="Remove from queue">×</button>
      </div>`;
  }).join('');

  // Wire error pill clicks
  rowList.querySelectorAll('[data-error-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.errorIdx, 10);
      showErrorModal(idx);
    });
  });

  // Wire delete buttons
  rowList.querySelectorAll('[data-delete-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.deleteIdx, 10);
      deleteRow(idx);
    });
  });
}

function updateRowStatus(index, status, error) {
  state.statuses[index] = status;
  if (error) state.errors[index] = error;

  const item = $(`row-item-${index}`);
  const pill = $(`pill-${index}`);
  if (!item || !pill) return;

  pill.className   = `pill ${getPillClass(status)}`;
  pill.textContent = getPillLabel(status);

  if (status === ROW_STATUS.ERROR && error) {
    // ← FIXED: Add data-error-idx attribute for consistency
    pill.setAttribute('data-error-idx', index);
    pill.style.cursor         = 'pointer';
    pill.style.textDecoration = 'underline dotted';
    pill.title                = 'Click to see error details';
    pill.onclick              = () => showErrorModal(index);
  } else {
    pill.removeAttribute('data-error-idx');
    pill.style.cursor         = '';
    pill.style.textDecoration = '';
    pill.title                = '';
    pill.onclick              = null;
  }

  item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Delete a single row from queue ────────────────────────────────────────────
function deleteRow(index) {
  if (state.sessionRunning) {
    alert('Cannot remove rows while session is running.');
    return;
  }
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

  chrome.storage.session.set({
    dgca_pending_rows: state.rows,
    dgca_row_status:   state.statuses,
    dgca_row_errors:   state.errors,
  }).then(() => {
    if (state.rows.length === 0) {
      queueSection.style.display   = 'none';
      rowListSection.style.display = 'none';
      btnStart.disabled            = true;
      setBadge('Idle', 'idle');
    } else {
      renderQueueSection(state.rows);
      renderRowList(state.rows, state.statuses, state.errors);
    }
    log(`Row ${index + 1} removed from queue.`);
  }).catch(() => {});
}

// ── Error modal ───────────────────────────────────────────────────────────────
function showErrorModal(index) {
  const err = state.errors[index] || 'Unknown error';
  errorModalRowNum.textContent = index + 1;
  errorModalMsg.textContent    = err;
  errorBackdrop.style.display  = 'flex';
}

errorModalClose.addEventListener('click', () => { errorBackdrop.style.display = 'none'; });
errorBackdrop.addEventListener('click', (e) => {
  // Close only when clicking the backdrop itself, not the modal content
  if (e.target === errorBackdrop || e.target.classList.contains('error-modal__backdrop')) {
    errorBackdrop.style.display = 'none';
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') errorBackdrop.style.display = 'none';
});

// ── Check DGCA tab ────────────────────────────────────────────────────────────
function checkDgcaTab() {
  dgcaTabStatus.textContent = 'DGCA tab: checking…';
  dgcaTabStatus.className   = 'tab-status tab-status--checking';
  chrome.runtime.sendMessage({ type: 'PING_DGCA_TAB' }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) {
      dgcaTabStatus.textContent = '✗ DGCA tab not ready — open & navigate to entry page';
      dgcaTabStatus.className   = 'tab-status tab-status--error';
      state.dgcaTabReady        = false;
    } else {
      dgcaTabStatus.textContent = '✓ DGCA tab ready';
      dgcaTabStatus.className   = 'tab-status tab-status--ready';
      state.dgcaTabReady        = true;
    }
  });
}

btnCheckDgca.addEventListener('click', checkDgcaTab);

// ── WSO toggle ────────────────────────────────────────────────────────────────
wsoAtsToggle.addEventListener('change', () => {
  state.useAts = wsoAtsToggle.checked;
  chrome.storage.session.set({ dgca_use_ats: state.useAts }).catch(() => {});
  const { labelWSO, labelATS } = getWsoLabels(
    (state.rows[0]?.station || 'VIJP').toUpperCase()
  );
  log(`WSO/EGCA-Id set to: ${state.useAts ? labelATS : labelWSO}`, 'ok');
});

// ── Start session ─────────────────────────────────────────────────────────────
btnStart.addEventListener('click', () => {
  if (state.rows.length === 0) {
    log('No rows queued. Go to AAI MyLogBook and send rows first.', 'error');
    return;
  }

  // Re-sort before starting so processing is always chronological,
  // even if rows were queued in a different order.
  const resorted = sortQueue(state.rows, state.rows.map(() => ROW_STATUS.PENDING), {});
  state.rows     = resorted.rows;
  state.statuses = state.rows.map(() => ROW_STATUS.PENDING);
  state.errors   = {};
  state.sessionRunning = true;

  chrome.storage.session.set({
    dgca_pending_rows: state.rows,
    dgca_row_status:   state.statuses,
    dgca_row_errors:   {},
  }).catch(() => {});

  progressSection.style.display = 'block';
  progressText.textContent      = 'Starting…';
  progressStats.textContent     = '';
  progressFill.style.width      = '0%';
  btnStart.disabled             = true;
  btnAbort.style.display        = 'inline-block';
  wsoAtsToggle.disabled         = true;
  setBadge('Running', 'running');
  const _wsoLabels = getWsoLabels((state.rows[0]?.station || 'VIJP').toUpperCase());
  log(`Session started — ${state.rows.length} rows to process (WSO: ${state.useAts ? _wsoLabels.labelATS : _wsoLabels.labelWSO})…`);

  renderRowList(state.rows, state.statuses, state.errors);

  chrome.runtime.sendMessage({ type: 'REQUEST_START_FILLING' }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) {
      const err = resp?.error || chrome.runtime.lastError?.message || 'Unknown error';
      log(`Failed to start: ${err}`, 'error');
      setBadge('Error', 'error');
      btnStart.disabled             = false;
      btnAbort.style.display        = 'none';
      progressSection.style.display = 'none';
      wsoAtsToggle.disabled         = false;
      state.sessionRunning          = false;
    }
  });
});

// ── Abort session ─────────────────────────────────────────────────────────────
btnAbort.addEventListener('click', () => {
  if (!confirm('Abort the current session?')) return;
  chrome.runtime.sendMessage({ type: 'REQUEST_ABORT' });
  state.sessionRunning          = false;
  setBadge('Idle', 'idle');
  btnAbort.style.display        = 'none';
  btnStart.disabled             = false;
  wsoAtsToggle.disabled         = false;
  progressSection.style.display = 'none';
  log('Session aborted.');
});

// ── Clear submitted rows only ────────────────────────────────────────────────
function clearSuccessRows() {
  if (state.sessionRunning) {
    alert('Cannot clear while session is running.');
    return;
  }
  const submittedCount = state.statuses.filter(s => s === ROW_STATUS.SUBMITTED).length;
  if (submittedCount === 0) {
    log('No successfully submitted rows to clear.', '');
    return;
  }

  // Keep only non-submitted rows; rebuild errors map with re-indexed keys
  const keepIndices = state.rows
    .map((_, i) => i)
    .filter(i => state.statuses[i] !== ROW_STATUS.SUBMITTED);

  const newRows     = keepIndices.map(i => state.rows[i]);
  const newStatuses = keepIndices.map(i => state.statuses[i]);
  const newErrors   = {};
  keepIndices.forEach((oldIdx, newIdx) => {
    if (state.errors[oldIdx]) newErrors[newIdx] = state.errors[oldIdx];
  });

  state.rows     = newRows;
  state.statuses = newStatuses;
  state.errors   = newErrors;

  chrome.storage.session.set({
    dgca_pending_rows: state.rows,
    dgca_row_status:   state.statuses,
    dgca_row_errors:   state.errors,
  }).then(() => {
    if (state.rows.length === 0) {
      queueSection.style.display   = 'none';
      rowListSection.style.display = 'none';
      btnStart.disabled            = true;
      setBadge('Idle', 'idle');
    } else {
      renderQueueSection(state.rows);
      renderRowList(state.rows, state.statuses, state.errors);
    }
    log(`Cleared ${submittedCount} submitted row${submittedCount === 1 ? '' : 's'} from queue.`, 'ok');
  }).catch(() => {});
}

btnClearSuccess.addEventListener('click', clearSuccessRows);

// ── Clear queued rows ─────────────────────────────────────────────────────────
btnClear.addEventListener('click', () => {
  if (state.sessionRunning) {
    alert('Cannot clear while session is running.');
    return;
  }
  chrome.storage.session.remove([
    'dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_session_ts'
  ]).then(() => {
    state.rows     = [];
    state.statuses = [];
    state.errors   = {};
    queueSection.style.display   = 'none';
    rowListSection.style.display = 'none';
    btnStart.disabled            = true;
    setBadge('Idle', 'idle');
    log('Queue cleared.');
  }).catch(() => {});
});

// ── Progress events from background ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ROWS_READY') {
    loadFromStorage();
    log(`${msg.count} rows queued from AAI MyLogBook.`, 'ok');
    return;
  }

  if (msg.type === 'FILL_PROGRESS') {
    const { index, total, status, error } = msg;

    // ── Session-level terminal events ──────────────────────────────────────
    if (status === 'session-complete') {
      state.sessionRunning  = false;
      wsoAtsToggle.disabled = false;

      const summary = `${msg.done} added, ${msg.errors} errors`;

      setBadge('Done', 'done');
      btnAbort.style.display        = 'none';
      btnStart.disabled             = false;
      progressText.textContent      = `Done — ${summary}`;
      const logType = msg.errors === 0 ? 'ok' : 'error';
      const logSuffix = msg.errors === 0 ? '' : ' Fix errors and re-run if needed.';
      log(`Session complete: ${summary}.${logSuffix}`, logType);
      return;
    }

    if (status === 'session-error') {
      state.sessionRunning          = false;
      setBadge('Error', 'error');
      btnAbort.style.display        = 'none';
      btnStart.disabled             = false;
      wsoAtsToggle.disabled         = false;
      progressText.textContent      = 'Session failed — see log';
      log(`Session error: ${msg.error || 'Unknown error'}`, 'error');
      return;
    }

    // ── Per-row progress ───────────────────────────────────────────────────
    if (status) {
      updateRowStatus(index, status, error);

      const done   = state.statuses.filter(s => s === ROW_STATUS.SUBMITTED).length;
      const errCnt = state.statuses.filter(s => s === ROW_STATUS.ERROR).length;
      const proc   = done + errCnt;
      const pct    = total > 0 ? Math.round((proc / total) * 100) : 0;

      progressText.textContent  = `Row ${index + 1} / ${total} — ${status}`;
      progressStats.textContent = `${done} added · ${errCnt} errors`;
      progressFill.style.width  = `${pct}%`;

      if (error) {
        log(`Row ${index + 1} error — click the pill for details.`, 'error');
      } else if (status === ROW_STATUS.SUBMITTED) {
        log(`Row ${index + 1} added ✓`, 'ok');
      }
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.dgca_pending_rows) {
    loadFromStorage();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadFromStorage();
checkDgcaTab();