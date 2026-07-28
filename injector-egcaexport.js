/**
injector.js
Runs on: https://iamatc.aai.aero/atc/EGcAexport*
Adds row checkboxes + a "Add to DGCA Queue" button to the EGcAexport table
and pushes selected rows into the shared session-storage queue that the
DGCA-side filler content script reads from.
*/
(function () {
	'use strict';

	// Column positions in the EGcAexport table are looked up by header text
	// rather than hard-coded indices, since the source table's columns have
	// changed order/count more than once (e.g. a CSV_SCHEMA_VERSION column
	// was added). As long as a <th> with the expected label exists somewhere
	// in the header row, its data will be found regardless of position.
	const EGCA_COL_NAMES = [
		'FROM_DATE', 'TO_DATE', 'POSTING_STATION', 'ICAO_CODE',
		'ATS_EGCA_ID', 'RATING', 'ATS_UNIT', 'BRIEFING_DONE',
		'TYPE_OF_DUTY', 'START_TIME', 'END_TIME', 'TOTAL_DURATION',
		'REMARKS', 'KNOWLEDGE_CHECK', 'SKILL_TEST_CHECK', 'OJT_PROVIDED_CHECK',
		'OJT_ENV', 'TRAINEE_LICENSE', 'TRAINEE_NAME', 'INSTRUCTOR_LICENSE',
		'INSTRUCTOR_NAME', 'PROFICIENCY_CHECK', 'NEWLY_ESTAB_STATION',
	];

	// Kept only as a fallback for the (unlikely) case the header row can't be
	// read at all — mirrors the last known-good column order. Current as of
	// the CSV_SCHEMA_VERSION column being added at position 0, shifting
	// every subsequent column right by one versus the previous layout.
	const EGCA_COL_FALLBACK = {
		CSV_SCHEMA_VERSION: 0,
		FROM_DATE: 1, TO_DATE: 2, POSTING_STATION: 3, ICAO_CODE: 4,
		ATS_EGCA_ID: 5, RATING: 6, ATS_UNIT: 7, BRIEFING_DONE: 8,
		TYPE_OF_DUTY: 9, START_TIME: 10, END_TIME: 11, TOTAL_DURATION: 12,
		REMARKS: 13, KNOWLEDGE_CHECK: 14, SKILL_TEST_CHECK: 15, OJT_PROVIDED_CHECK: 16,
		OJT_ENV: 17, TRAINEE_LICENSE: 18, TRAINEE_NAME: 19, INSTRUCTOR_LICENSE: 20,
		INSTRUCTOR_NAME: 21, PROFICIENCY_CHECK: 22, NEWLY_ESTAB_STATION: 23
	};

	let _offset = 0;
	let _selectedRows = {};
	let _headerMap = null; // EGCA_COL_NAMES entry -> column index in the *original* table (before our injected checkbox column)

	function _normHeader(s) {
		return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
	}

	// Scans the table's header row(s) and builds a name -> column-index map.
	// Ignores our own injected checkbox <th> so indices line up with the
	// original (unmodified) table markup, matching how _offset is used
	// elsewhere (0 before we inject the checkbox column, 1 after).
	function buildHeaderMap(table) {
		const thead = table.querySelector('thead');
		if (!thead) return null;
		const headerRows = thead.querySelectorAll('tr');
		if (!headerRows[0]) return null;

		const ths = Array.from(headerRows[0].querySelectorAll('th'))
			.filter(th => !th.classList.contains('dgca-chk-header'));

		const map = {};
		ths.forEach((th, idx) => {
			const name = _normHeader(th.textContent);
			if (name) map[name] = idx;
		});

		const missing = EGCA_COL_NAMES.filter(n => !(n in map));
		if (missing.length > 0) {
			console.warn('[DGCA Injector] Header columns not found by name, falling back to positional map for:', missing);
		}
		return map;
	}

	function ensureHeaderMap(table) {
		const map = buildHeaderMap(table);
		if (map) _headerMap = map;
		else if (!_headerMap) _headerMap = null; // will fall back per-field below
	}

	// Resolves a logical column name to its cell index for the given row,
	// preferring the live header map and falling back to the last known-good
	// static layout if the header row is ever unreadable.
	function colIndex(name) {
		if (_headerMap && name in _headerMap) return _headerMap[name];
		return EGCA_COL_FALLBACK[name];
	}

	// Firefox's sidebarAction.open() requires a direct, synchronous call from
	// a genuine user-gesture event handler — unlike Chrome's sidePanel.open(),
	// it does NOT honor gesture context relayed through runtime.sendMessage.
	// So on Firefox, the background script's attempt to auto-open the sidebar
	// from OPEN_SIDE_PANEL silently fails, and we need to tell the user to
	// click the toolbar icon themselves instead.
	function isFirefox() {
		return typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent || '');
	}

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

	async function refreshUserMismatchIndicator() {
		try {
			const warnEl = document.getElementById('dgca-user-warn');
			if (!warnEl) return;

			const data = await window.DGCA_STORAGE.get(['dgca_pending_rows', 'dgca_queue_user']);
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

	// ATS_EGCA_ID's option value/text both carry the same "NAME (ID)" label
	// in this table, so reading either works; prefer the visible text since
	// that's what has to match against the DGCA-side dropdown later.
	function _selectCellText(select) {
		const opt = select.options[select.selectedIndex];
		if (!opt || !opt.value) return '';
		return (opt.textContent || opt.value).trim();
	}

	// Reads a cell by logical column name. Handles both plain
	// contenteditable text cells and the ATS_EGCA_ID cell, which can now be
	// either a <select class="ats-egca-picker"> (pick from known
	// name+EGCA-ID pairs) or plain free-text, depending on the row.
	function cellText(tr, colName) {
		const idx = colIndex(colName);
		if (idx === undefined || idx === null) return '';
		const td = tr.cells[idx + _offset];
		if (!td) return '';

		const select = td.querySelector('select');
		if (select) return _selectCellText(select);

		return td.innerText.trim();
	}

	function isDataRow(tr) {
		const dateText = cellText(tr, 'FROM_DATE');
		return /^\d{2}\/\d{2}\/\d{4}$/.test(dateText);
	}

	function rowId(date, station, timeFrom, timeTo, dutyType) {
		return `${date}|${station}|${timeFrom}|${timeTo}|${dutyType}`;
	}

	// Convert EGCA date DD/MM/YYYY → DD-MM-YYYY (shared queue format).
	function normaliseEgcaDate(dateStr) {
		const s = String(dateStr || '').trim();
		if (/^\d{2}-\d{2}-\d{4}$/.test(s)) return s;
		if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s.replace(/\//g, '-');
		return s;
	}

	function parseRow(tr) {
		const getText = (colName) => cellText(tr, colName);

		const rawFromDate = getText('FROM_DATE');
		const rawToDate = getText('TO_DATE');
		const rawPostingStation = getText('POSTING_STATION');
		const rawIcaoCode = getText('ICAO_CODE');
		const rawAtsEgcaId = getText('ATS_EGCA_ID');
		const rawRating = getText('RATING');
		const rawAtsUnit = getText('ATS_UNIT');
		const rawBriefingDone = getText('BRIEFING_DONE');
		const rawTypeOfDuty = getText('TYPE_OF_DUTY');
		const rawStartTime = getText('START_TIME');
		const rawEndTime = getText('END_TIME');
		const rawRemarks = getText('REMARKS');
		const rawKnowledgeCheck = getText('KNOWLEDGE_CHECK');
		const rawSkillTestCheck = getText('SKILL_TEST_CHECK');
		const rawOjtProvidedCheck = getText('OJT_PROVIDED_CHECK');
		const rawOjtEnv = getText('OJT_ENV');
		const rawTraineeName = getText('TRAINEE_NAME');
		const rawTraineeLicense = getText('TRAINEE_LICENSE');
		const rawInstructorName = getText('INSTRUCTOR_NAME');
		const rawInstructorLicense = getText('INSTRUCTOR_LICENSE');
		const rawProficiencyCheck = getText('PROFICIENCY_CHECK');
		const rawNewlyEstab = getText('NEWLY_ESTAB_STATION');

		const date = normaliseEgcaDate(rawFromDate);   // DD-MM-YYYY
		const station = rawIcaoCode.trim().toUpperCase(); // e.g. 'VIJP'
		const timeFrom = rawStartTime;
		const timeTo = rawEndTime;
		const dutyType = rawTypeOfDuty;
		const atsUnit = rawAtsUnit;

		return {
			id: rowId(date, station, timeFrom, timeTo, dutyType),

			// ── Normalised camelCase schema (shared with panel.js & filler) ─────
			date,
			station,
			timeFrom,
			timeTo,
			atsUnit,
			dutyType,
			remarks: rawRemarks,
			postingStationName: rawPostingStation,
			ratingText: rawRating,
			nameTrainee: rawTraineeName,
			instructorAtcol: rawInstructorLicense,

			// ── egcaRaw: full raw data used by dgca-filler.js ────────────────────
			egcaRaw: {
				fromDate: normaliseEgcaDate(rawFromDate),
				toDate: normaliseEgcaDate(rawToDate),
				postingStation: rawPostingStation,
				icaoCode: rawIcaoCode,
				atsEgcaId: rawAtsEgcaId,
				rating: rawRating,
				atsUnit: rawAtsUnit,
				briefingDone: rawBriefingDone,
				typeOfDuty: rawTypeOfDuty,
				startTime: rawStartTime,
				endTime: rawEndTime,
				remarks: rawRemarks,
				knowledgeCheck: rawKnowledgeCheck,
				skillTestCheck: rawSkillTestCheck,
				ojtProvidedCheck: rawOjtProvidedCheck,
				ojtEnv: rawOjtEnv,
				traineeName: rawTraineeName,
				traineeLicense: rawTraineeLicense,
				instructorName: rawInstructorName,
				instructorLicense: rawInstructorLicense,
				proficiencyCheck: rawProficiencyCheck,
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

		const toast = document.createElement('span');
		toast.id = 'dgca-toast-msg';
		toast.style.cssText = 'font-size:13px; color:#0d6efd; font-weight:700; display:none;';

		wrapper.appendChild(sendBtn);
		wrapper.appendChild(badge);
		wrapper.appendChild(userWarn);
		wrapper.appendChild(toast);

		if (downloadBtn) {
			downloadBtn.parentNode.insertBefore(wrapper, downloadBtn.nextSibling);
		} else {
			console.warn('[DGCA Injector] Could not find Download CSV button; falling back to top injection.');
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

		window.DGCA_STORAGE.onChanged((changes, area) => {
			if (area === 'session' && (changes.dgca_pending_rows || changes.dgca_queue_user)) {
				refreshUserMismatchIndicator();
			}
		});
	}

	function injectCheckboxesIntoTable(table) {
		ensureHeaderMap(table);
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

			// _offset is already 1 because the checkbox cell is present in the DOM
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
		return parseRow(tr); // _offset is already 1
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
		// On Chrome, this can successfully auto-open the side panel because
		// Chrome preserves user-gesture context across the runtime.sendMessage
		// hop. Firefox does not, so sidebarAction.open() would just silently
		// fail there — skip the attempt and rely on the toast nudge below
		// instead of a call we know can't succeed.
		if (!isFirefox()) {
			try { chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }); } catch (_) { }
		}

		const newRows = Object.values(_selectedRows);
		if (newRows.length === 0) {
			alert('No rows selected. Please check at least one row.');
			return;
		}

		const currentUser = getAaiUser();

		window.DGCA_STORAGE.get(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_queue_user'])
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

				return window.DGCA_STORAGE.set({
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

					if (isFirefox()) {
						const toast = document.getElementById('dgca-toast-msg');
						if (toast) {
							toast.textContent = '👉 Click the extension icon in your toolbar to open the panel';
							toast.style.display = 'inline-block';
							setTimeout(() => { toast.style.display = 'none'; }, 6000);
						}
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