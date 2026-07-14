/**
panel.js
Side panel UI logic — egcaexport source only.
*/

const ROW_STATUS = {
	PENDING: 'pending',
	FILLING: 'filling',
	SUBMITTED: 'submitted',
	ERROR: 'error',
	SKIPPED: 'skipped',
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

function rowSortKey(row) {
	const [d, m, y] = String(row.date || '').split('-');
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
const progressErrorPill = $('progress-error-pill');
const badge = $('badge');
const queueSection = $('queue-section');
const queueCount = $('queue-count');
const wsoAtsToggle = $('wso-ats-toggle');
const wsoAtsLabel = $('wso-ats-label');
const dgcaTabStatus = $('dgca-tab-status');
const progressSection = $('progress-section');
const progressText = $('progress-text');
const progressStats = $('progress-stats');
const progressFill = $('progress-fill');
const btnStart = $('btn-start');
const btnAbort = $('btn-abort');
const btnClearSuccess = $('btn-clear-success');
const btnClear = $('btn-clear');
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

// ── Top error pill helpers ────────────────────────────────────────────────────
function showTopError(msg) {
	if (!progressErrorPill) return;
	progressErrorPill.textContent = `✗ ${msg}`;
	progressErrorPill.style.display = 'block';
	progressErrorPill.onclick = () => {
		// Reuse the existing error modal for easy reading/copying
		errorModalRowNum.textContent = 'Session Error';
		errorModalMsg.textContent = msg;
		errorBackdrop.style.display = 'flex';
	};
}

function hideTopError() {
	if (progressErrorPill) {
		progressErrorPill.style.display = 'none';
		progressErrorPill.onclick = null;
	}
}

function getPillClass(status) { return PILL_CLASS[status] || PILL_CLASS[ROW_STATUS.PENDING]; }
function getPillLabel(status) { return PILL_LABEL[status] || PILL_LABEL[ROW_STATUS.PENDING]; }


// ── Storage load ─────────────────────────────────────────────────────────────
function loadFromStorage() {
	chrome.storage.session
		.get(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_session_ts', 'dgca_use_ats', 'dgca_queue_user'])
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

// ── Queue user tag ────────────────────────────────────────────────────────────
function renderQueueUser(user) {
	if (!queueUserInfo) return;
	if (!user || (!user.name && !user.loginId)) {
		queueUserInfo.style.display = 'none';
		return;
	}
	const name = user.name || user.loginId;
	const loginBadge = (user.loginId && user.loginId !== name)
		? `<span class="queue-user-login">(${escHtml(user.loginId)})</span>` : '';
	queueUserInfo.className = 'queue-user-info';
	queueUserInfo.innerHTML = `👤 Queued for <strong>${escHtml(name)}</strong>${loginBadge}`;
	queueUserInfo.style.display = 'flex';
}

// ── Queue section header ──────────────────────────────────────────────────────
function renderQueueSection(rows) {
	queueSection.style.display = 'block';
	queueCount.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} queued`;
	btnStart.disabled = false;
	setBadge('Ready', 'done');
}

// ── Row list ──────────────────────────────────────────────────────────────────
function renderRowList(rows, statuses, errors) {
	rowListSection.style.display = 'block';
	rowList.innerHTML = rows.map((row, i) => {
		const status = statuses[i] || ROW_STATUS.PENDING;
		const error = errors[i] || null;
		const pillClass = getPillClass(status);
		const pillLabel = getPillLabel(status);
		const errorAttr = error
			? `data-error-idx="${i}" style="cursor:pointer;text-decoration:underline dotted;"` : '';

		const raw = row.egcaRaw || {};

		// ATS unit chip
		const atsHtml = row.atsUnit
			? `<span class="row-item__ats">${escHtml(row.atsUnit)}</span>` : '';

		// Duty label — use raw portal text directly; show as tooltip too for brevity
		const dutyShort = raw.typeOfDuty ? raw.typeOfDuty.split('(')[0].trim() : '';
		const dutyHtml = `<span class="row-item__duty" title="${escHtml(raw.typeOfDuty || '')}">${escHtml(dutyShort)}</span>`;

		// Instructor chip — from instructorLicense / ojtiName
		let instrHtml = '';
		const instrName = raw.ojtiName || raw.instructorName || '';
		if (instrName) {
			instrHtml = `<span class="row-item__instr" title="Instructor">👤 ${escHtml(instrName)}</span>`;
		}

		// Trainee chip — from traineeLicense / ojtiName
		let traineeHtml = '';
		if (raw.traineeLicense) {
			const label = raw.ojtiName ? `${raw.ojtiName} (${raw.traineeLicense})` : raw.traineeLicense;
			traineeHtml = `<span class="row-item__trainee" title="Trainee">🎓 ${escHtml(label)}</span>`;
		}


		return `
      <div class="row-item" id="row-item-${i}">
        <div class="row-item__info">
          <span class="row-item__num">${i + 1}</span>
          <span class="row-item__date">${escHtml(row.date)}</span>
          <span class="row-item__time">${escHtml(row.timeFrom)}–${escHtml(row.timeTo)}</span>
          ${atsHtml}
          ${dutyHtml}
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

// ── Per-row status update (live, during session) ──────────────────────────────
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

// ── Row delete ────────────────────────────────────────────────────────────────
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

	chrome.storage.session
		.set({ dgca_pending_rows: state.rows, dgca_row_status: state.statuses, dgca_row_errors: state.errors })
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

// ── Error modal ───────────────────────────────────────────────────────────────
function showErrorModal(index) {
	errorModalRowNum.textContent = index + 1;
	errorModalMsg.textContent = state.errors[index] || 'Unknown error';
	errorBackdrop.style.display = 'flex';
}
errorModalClose.addEventListener('click', () => { errorBackdrop.style.display = 'none'; });
errorBackdrop.addEventListener('click', (e) => {
	if (e.target === errorBackdrop || e.target.classList.contains('error-modal__backdrop')) {
		errorBackdrop.style.display = 'none';
	}
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') errorBackdrop.style.display = 'none'; });

// ── DGCA tab check ────────────────────────────────────────────────────────────
function checkDgcaTab() {
	dgcaTabStatus.textContent = 'DGCA tab: checking…';
	dgcaTabStatus.className = 'tab-status tab-status--checking';
	chrome.runtime.sendMessage({ type: 'PING_DGCA_TAB' }, (resp) => {
		if (chrome.runtime.lastError || !resp?.ok) {
			dgcaTabStatus.textContent = '✗ DGCA tab not ready — open & navigate to entry page';
			dgcaTabStatus.className = 'tab-status tab-status--error';
			state.dgcaTabReady = false;
		} else if (!resp.onEntryPage) {
			dgcaTabStatus.textContent = '⚠ DGCA tab found — navigate to the logbook entry page';
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

// ── WSO/ATS toggle ────────────────────────────────────────────────────────────
wsoAtsToggle.addEventListener('change', () => {
	state.useAts = wsoAtsToggle.checked;
	chrome.storage.session.set({ dgca_use_ats: state.useAts }).catch(() => { });
});

// ── Start filling ─────────────────────────────────────────────────────────────
btnStart.addEventListener('click', () => {
	if (state.rows.length === 0) return;

	hideTopError(); // Clear any previous top errors

	const resorted = sortQueue(state.rows, state.rows.map(() => ROW_STATUS.PENDING), {});
	state.rows = resorted.rows;
	state.statuses = state.rows.map(() => ROW_STATUS.PENDING);
	state.errors = {};
	state.sessionRunning = true;

	chrome.storage.session
		.set({ dgca_pending_rows: state.rows, dgca_row_status: state.statuses, dgca_row_errors: {} })
		.catch(() => { });

	progressSection.style.display = 'block';
	progressText.textContent = 'Starting…';
	progressStats.textContent = '';
	progressFill.style.width = '0%';
	btnStart.disabled = true;
	btnAbort.style.display = 'inline-block';
	wsoAtsToggle.disabled = true;
	setBadge('Running', 'running');
	renderRowList(state.rows, state.statuses, state.errors);

	chrome.runtime.sendMessage({ type: 'REQUEST_START_FILLING' }, (resp) => {
		if (chrome.runtime.lastError || !resp?.ok) {
			// EXTRACT THE ACTUAL ERROR MESSAGE
			const errMsg = resp?.error || chrome.runtime.lastError?.message || 'Unknown error starting session';

			setBadge('Error', 'error');
			btnStart.disabled = false;
			btnAbort.style.display = 'none';

			// KEEP PROGRESS SECTION VISIBLE TO SHOW THE ERROR PILL
			progressSection.style.display = 'block';
			progressText.textContent = 'Start failed';

			wsoAtsToggle.disabled = false;
			state.sessionRunning = false;

			// SHOW THE ERROR IN THE NEW PILL
			showTopError(errMsg);
		}
	});
});

// ── Abort ─────────────────────────────────────────────────────────────────────
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

// ── Clear done rows ───────────────────────────────────────────────────────────
function clearSuccessRows() {
	if (state.sessionRunning) { alert('Cannot clear while session is running.'); return; }
	const keepIndices = state.rows.map((_, i) => i).filter(i => state.statuses[i] !== ROW_STATUS.SUBMITTED);
	if (keepIndices.length === state.rows.length) return;

	const newErrors = {};
	keepIndices.forEach((oldIdx, newIdx) => { if (state.errors[oldIdx]) newErrors[newIdx] = state.errors[oldIdx]; });
	state.rows = keepIndices.map(i => state.rows[i]);
	state.statuses = keepIndices.map(i => state.statuses[i]);
	state.errors = newErrors;

	chrome.storage.session
		.set({ dgca_pending_rows: state.rows, dgca_row_status: state.statuses, dgca_row_errors: state.errors })
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

// ── Clear all ─────────────────────────────────────────────────────────────────
btnClear.addEventListener('click', () => {
	if (state.sessionRunning) { alert('Cannot clear while session is running.'); return; }
	chrome.storage.session
		.remove(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_session_ts', 'dgca_queue_user'])
		.then(() => {
			state.rows = []; state.statuses = []; state.errors = {}; state.queueUser = null;
			queueSection.style.display = 'none';
			rowListSection.style.display = 'none';
			btnStart.disabled = true;
			setBadge('Idle', 'idle');
			renderQueueUser(null);
		}).catch(() => { });
});

// ── Message listener ──────────────────────────────────────────────────────────
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
			setBadge('Done', 'done');
			btnAbort.style.display = 'none';
			btnStart.disabled = false;
			progressText.textContent = `Done — ${msg.done} added, ${msg.errors} errors`;
			return;
		}
		if (status === 'session-error') {
			state.sessionRunning = false;
			setBadge('Error', 'error');
			btnAbort.style.display = 'none';
			btnStart.disabled = false;
			wsoAtsToggle.disabled = false;
			progressText.textContent = 'Session failed';

			// SHOW THE ERROR IN THE NEW PILL
			const errMsg = msg.error || 'Unknown session error';
			showTopError(errMsg);
			return;
		}
		if (status) {
			updateRowStatus(index, status, error);
			const done = state.statuses.filter(s => s === ROW_STATUS.SUBMITTED).length;
			const errCnt = state.statuses.filter(s => s === ROW_STATUS.ERROR).length;
			const pct = total > 0 ? Math.round(((done + errCnt) / total) * 100) : 0;
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