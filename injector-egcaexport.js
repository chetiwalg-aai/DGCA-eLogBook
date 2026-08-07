// Runs on https://iamatc.aai.aero/atc/EGcAexport* — adds row checkboxes and
// one or more "Add to DGCA Queue" buttons, pushing selected rows into the
// shared queue that dgca-filler.js's toolbar reads on the DGCA portal.
(function () {
	'use strict';

	// Columns are looked up by header text, not fixed index, since column
	// order in this table has changed before.
	const EGCA_COL_NAMES = [
		'FROM_DATE', 'TO_DATE', 'POSTING_STATION', 'ICAO_CODE',
		'ATS_EGCA_ID', 'RATING', 'ATS_UNIT', 'BRIEFING_DONE',
		'TYPE_OF_DUTY', 'START_TIME', 'END_TIME', 'TOTAL_DURATION',
		'REMARKS', 'KNOWLEDGE_CHECK', 'SKILL_TEST_CHECK', 'OJT_PROVIDED_CHECK',
		'OJT_ENV', 'TRAINEE_LICENSE', 'TRAINEE_LICEN_TYPE', 'TRAINEE_NAME',
		'INSTRUCTOR_LICENSE', 'INSTRUCTOR_NAME', 'PROFICIENCY_CHECK', 'NEWLY_ESTAB_STATION',
	];

	// Positional fallback, used only when the header row can't be read by
	// name (see buildHeaderMap). Index 0 is intentionally unused/reserved so
	// FROM_DATE lines up with column 1 in the underlying table; kept in
	// sync with EGCA_COL_NAMES above.
	const EGCA_COL_FALLBACK = {
		FROM_DATE: 1, TO_DATE: 2, POSTING_STATION: 3, ICAO_CODE: 4,
		ATS_EGCA_ID: 5, RATING: 6, ATS_UNIT: 7, BRIEFING_DONE: 8,
		TYPE_OF_DUTY: 9, START_TIME: 10, END_TIME: 11, TOTAL_DURATION: 12,
		REMARKS: 13, KNOWLEDGE_CHECK: 14, SKILL_TEST_CHECK: 15, OJT_PROVIDED_CHECK: 16,
		OJT_ENV: 17, TRAINEE_LICENSE: 18, TRAINEE_LICEN_TYPE: 19, TRAINEE_NAME: 20,
		INSTRUCTOR_LICENSE: 21, INSTRUCTOR_NAME: 22, PROFICIENCY_CHECK: 23, NEWLY_ESTAB_STATION: 24
	};

	// sortQueue/escAttr live in shared.js (window.DGCA) so this file and the
	// DGCA-side toolbar (dgca-filler.js) share one implementation of queue
	// sorting/escaping instead of two copies that could drift apart.
	const { sortQueue, escAttr } = window.DGCA;

	let _offset = 0;
	let _selectedRows = {};
	let _headerMap = null; // EGCA_COL_NAMES entry -> column index in the *original* table (before our injected checkbox column)
	let _usingFallbackMap = false; // true once buildHeaderMap() has failed to read the header row at least once

	function _normHeader(s) {
		return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
	}

	// Scans the table's header row and builds a name -> column-index map.
	// Ignores our own injected checkbox <th> so indices line up with the
	// original (unmodified) table markup — matching how _offset is used
	// elsewhere (0 before the checkbox column is injected, 1 after).
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

		// Tracks whether any column fell back to positional lookup, since
		// positional lookup has no guarantee it's reading the right cell if
		// columns were reordered — drives the stricter validateParsedRow()
		// checks below.
		_usingFallbackMap = !_headerMap || EGCA_COL_NAMES.some(n => !(n in _headerMap));
	}

	// Resolves a logical column name to its cell index for the current row,
	// preferring the live header map and falling back to the last known-good
	// static layout if the header row is ever unreadable.
	function colIndex(name) {
		if (_headerMap && name in _headerMap) return _headerMap[name];
		return EGCA_COL_FALLBACK[name];
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

	// Keeps the user-mismatch warning, the Clear Queue button, and the Add
	// to DGCA Queue button in sync with current queue state. Clear Queue is
	// always visible (not just on a mismatch) so clearing a stale queue
	// doesn't require switching to the DGCA-side toolbar. Both buttons are
	// disabled while a fill session is running on that toolbar, since it is
	// actively iterating dgca_pending_rows by index and writing
	// dgca_row_status/dgca_row_errors as it goes — mutating the queue
	// concurrently would desync those indices.
	async function refreshUserMismatchIndicator() {
		try {
			const warnEls = document.querySelectorAll('.dgca-user-warn');
			const clearBtns = document.querySelectorAll('.dgca-clear-queue-btn');
			const sendBtns = document.querySelectorAll('.dgca-send-btn');
			if (warnEls.length === 0 && clearBtns.length === 0 && sendBtns.length === 0) return;

			const data = await window.DGCA_STORAGE.get(['dgca_pending_rows', 'dgca_queue_user', 'dgca_session_running']);
			const existing = data?.dgca_pending_rows || [];
			const queueUser = data?.dgca_queue_user || null;
			const sessionRunning = !!data?.dgca_session_running;
			const current = getAaiUser();

			const mismatch = isUserMismatch(current, queueUser, existing.length);
			warnEls.forEach(warnEl => {
				if (mismatch) {
					warnEl.textContent = `⚠ Queue is for ${queueUser.name} — clear it before adding as ${current.name}`;
					warnEl.style.display = 'inline-block';
				} else {
					warnEl.style.display = 'none';
				}
			});
			clearBtns.forEach(btn => {
				btn.style.display = 'inline-block';
				btn.disabled = existing.length === 0 || sessionRunning;
				btn.title = sessionRunning ? 'Cannot clear while a fill session is running on the DGCA tab' : '';
			});
			sendBtns.forEach(btn => {
				btn.disabled = sessionRunning;
				btn.title = sessionRunning ? 'Cannot add to queue while a fill session is running on the DGCA tab' : '';
			});
		} catch (_) { }
	}

	// Clears the shared queue from this page, so the user doesn't have to
	// switch to the DGCA-side toolbar just to press Clear All there.
	async function clearQueue() {
		try {
			const data = await window.DGCA_STORAGE.get(['dgca_session_running']);
			if (data?.dgca_session_running) {
				alert('A fill session is currently running on the DGCA tab. Please wait for it to finish or abort it there before clearing the queue.');
				refreshUserMismatchIndicator();
				return;
			}
		} catch (_) { }
		if (!confirm('Clear the entire DGCA queue?')) return;
		try {
			await window.DGCA_STORAGE.remove([
				'dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_row_timings', 'dgca_session_ts', 'dgca_queue_user',
			]);
			updateSelectionBadge();
			// No direct refreshUserMismatchIndicator() call here: removing
			// dgca_pending_rows/dgca_queue_user fires the window.DGCA_STORAGE
			// .onChanged listener registered in ensureButtonInjected(), which
			// already calls it — calling it again would just repeat the same
			// storage read + DOM update a moment later.
		} catch (err) {
			console.error('[DGCA] Failed to clear queue:', err);
			alert('Failed to clear queue. Please try again.');
		}
	}

	// ATS_EGCA_ID's option value and text both carry the same "NAME (ID)"
	// label in this table, so either can be read; the visible text is
	// preferred since that's what has to match against the DGCA-side
	// dropdown later.
	function _selectCellText(select) {
		const opt = select.options[select.selectedIndex];
		if (!opt || !opt.value) return '';
		return (opt.textContent || opt.value).trim();
	}

	// Reads a cell by logical column name. Handles both plain
	// contenteditable text cells and the ATS_EGCA_ID cell, which can be
	// either a <select class="ats-egca-picker"> (pick from known
	// name+EGCA-ID pairs) or plain free text, depending on the row.
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

	// Sanity-checks a few distinctly-shaped columns to catch a shifted
	// positional map before it silently queues misaligned data.
	function validateParsedRow(row) {
		const raw = row.egcaRaw;
		const checks = [
			[/^\d{2}-\d{2}-\d{4}$/.test(raw.toDate), 'TO_DATE'],       // normaliseEgcaDate() output, DD-MM-YYYY
			[/^\d{2}:\d{2}$/.test(raw.startTime), 'START_TIME'],
			[/^\d{2}:\d{2}$/.test(raw.endTime), 'END_TIME'],
			[/^[A-Z0-9]{3,4}$/.test(row.station), 'ICAO_CODE'],
		];
		const failed = checks.filter(([ok]) => !ok).map(([, name]) => name);
		if (failed.length > 0) {
			console.warn(
				'[DGCA Injector] Positional fallback column map produced a row that fails shape validation for:',
				failed.join(', '),
				'— skipping this row rather than queuing possibly-misaligned data. Raw row:', raw
			);
			return false;
		}
		return true;
	}

	function rowId(date, station, timeFrom, timeTo, dutyType) {
		return `${date}|${station}|${timeFrom}|${timeTo}|${dutyType}`;
	}

	// Converts an EGCA date DD/MM/YYYY to the shared queue's DD-MM-YYYY format.
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
		const rawTraineeLicenType = getText('TRAINEE_LICEN_TYPE');
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

		const row = {
			id: rowId(date, station, timeFrom, timeTo, dutyType),

			// ── Normalised camelCase schema (consumed by the DGCA toolbar) ──────
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
				traineeLicenType: rawTraineeLicenType,
				instructorName: rawInstructorName,
				instructorLicense: rawInstructorLicense,
				proficiencyCheck: rawProficiencyCheck,
				newlyEstabStation: rawNewlyEstab,
			},
		};

		if (_usingFallbackMap && !validateParsedRow(row)) return null;
		return row;
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

	// Returns every "Download eGCA CSV" button on the page (there can be more
	// than one — e.g. one above the preview table and one below it), not just
	// the last one, so a queue button is injected alongside each.
	function findDownloadCsvButtons() {
		const candidates = Array.from(document.querySelectorAll('button, a.btn, a'));
		const matches = candidates.filter(el => {
			const text = el.textContent.trim().toLowerCase();
			const onclick = el.getAttribute('onclick') || '';
			return (text.includes('download') && text.includes('csv')) ||
				onclick.includes('downloadEgcaCsv');
		});
		// De-dupe in case an element matches via both text and onclick checks.
		return Array.from(new Set(matches));
	}

	// Builds one queue-button instance (button + selection badge + warning +
	// toast) and inserts it right after the given download button. idSuffix
	// is '' for the first instance, keeping the original element IDs (other
	// code such as the success-state toggle in onSendClick looks those up
	// directly), and e.g. '-2', '-3' for subsequent instances so IDs stay
	// unique across the page. Every instance shares the same dgca-* classes
	// so updateSelectionBadge/refreshUserMismatchIndicator/onSendClick keep
	// all copies in sync at once.
	function injectButtonInstance(downloadBtn, idSuffix) {
		const wrapper = document.createElement('div');
		wrapper.className = 'dgca-inline-btn-wrapper';
		if (!idSuffix) wrapper.id = 'dgca-inline-btn-wrapper';
		wrapper.style.cssText = 'display:inline-flex; align-items:center; gap:10px; margin-left:12px; vertical-align:middle;';

		const sendBtn = document.createElement('button');
		sendBtn.className = 'btn btn-success btn-sm dgca-send-btn dgca-ext-shimmer-btn';
		if (!idSuffix) sendBtn.id = 'dgca-send-btn';
		sendBtn.style.cssText = 'font-weight:600; padding:8px 16px;';
		sendBtn.textContent = '✈ Add to DGCA Queue ▶';

		const badge = document.createElement('span');
		badge.className = 'dgca-sel-count';
		if (!idSuffix) badge.id = 'dgca-sel-count';
		badge.style.cssText = 'font-size:14px; color:#28a745; font-weight:600;';
		badge.textContent = '0 selected';

		const userWarn = document.createElement('span');
		userWarn.className = 'dgca-user-warn';
		if (!idSuffix) userWarn.id = 'dgca-user-warn';
		userWarn.style.cssText = 'font-size:13px; color:#c0392b; font-weight:700; display:none;';

		const clearQueueBtn = document.createElement('button');
		clearQueueBtn.className = 'btn btn-outline-danger btn-sm dgca-clear-queue-btn';
		if (!idSuffix) clearQueueBtn.id = 'dgca-clear-queue-btn';
		clearQueueBtn.type = 'button';
		// Always visible (not only on a user mismatch) — refreshUserMismatchIndicator()
		// disables it when the queue is empty or a session is running, and
		// re-enables it otherwise.
		clearQueueBtn.style.cssText = 'font-weight:600; padding:4px 10px; display:inline-block;';
		clearQueueBtn.disabled = true;
		clearQueueBtn.textContent = '🗑 Clear Queue';

		const toast = document.createElement('span');
		toast.className = 'dgca-toast-msg';
		if (!idSuffix) toast.id = 'dgca-toast-msg';
		toast.style.cssText = 'font-size:13px; color:#0d6efd; font-weight:700; display:none;';

		wrapper.appendChild(sendBtn);
		wrapper.appendChild(badge);
		wrapper.appendChild(userWarn);
		wrapper.appendChild(clearQueueBtn);
		wrapper.appendChild(toast);

		downloadBtn.parentNode.insertBefore(wrapper, downloadBtn.nextSibling);
		sendBtn.addEventListener('click', onSendClick);
		clearQueueBtn.addEventListener('click', clearQueue);
	}

	// ── Shimmer (visual highlight) ───────────────────────────────────────
	// Shared sweeping-highlight treatment applied to both our own "Add to
	// DGCA Queue" button and the portal's native "Generate Preview" button,
	// so the two calls-to-action in the row-selection workflow both draw
	// the eye. Same keyframe shape/duration as the Start-button shimmer in
	// dgca-filler.js's toolbar, duplicated here (rather than shared via
	// shared.js) since it's pure CSS with no logic to reuse and this page
	// never loads that toolbar's stylesheet.
	function injectShimmerStyle() {
		if (document.getElementById('dgca-ext-shimmer-style')) return;
		const style = document.createElement('style');
		style.id = 'dgca-ext-shimmer-style';
		style.textContent = `
			.dgca-ext-shimmer-btn {
				position: relative;
				overflow: hidden;
			}
			/* Only sweeps while the button is actually clickable, so a
			   disabled button doesn't shimmer as if it were live. */
			.dgca-ext-shimmer-btn:not(:disabled)::after {
				content: '';
				position: absolute;
				top: 0;
				left: 0;
				height: 100%;
				width: 50%;
				background: linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.65) 50%, rgba(255, 255, 255, 0) 100%);
				animation: dgca-ext-shimmer-bar 3.2s ease-in-out infinite;
				pointer-events: none;
			}
			@keyframes dgca-ext-shimmer-bar {
				0% { transform: translateX(-100%); }
				100% { transform: translateX(350%); }
			}
		`;
		document.head.appendChild(style);
	}

	// Finds the portal's native "Generate Preview" submit button so it can
	// be tagged with the shared shimmer class. Matched by visible text
	// rather than a fixed ID/selector, same reasoning as
	// findDownloadCsvButtons() above — it's the portal's own markup, not
	// ours, and IDs there aren't guaranteed stable.
	function findGeneratePreviewButton() {
		const candidates = Array.from(document.querySelectorAll('button[type="submit"], button.btn-min'));
		return candidates.find(el => el.textContent.trim().toLowerCase().includes('generate preview')) || null;
	}

	function ensurePreviewButtonShimmer() {
		const btn = findGeneratePreviewButton();
		if (btn && !btn.classList.contains('dgca-ext-shimmer-btn')) {
			btn.classList.add('dgca-ext-shimmer-btn');
		}
	}

	function ensureButtonInjected() {
		if (_buttonInjected) return;
		if (document.querySelector('.dgca-inline-btn-wrapper')) { _buttonInjected = true; return; }

		const downloadBtns = findDownloadCsvButtons();

		if (downloadBtns.length > 0) {
			downloadBtns.forEach((btn, i) => injectButtonInstance(btn, i === 0 ? '' : `-${i + 1}`));
		} else {
			console.warn('[DGCA Injector] Could not find any Download CSV button; falling back to top injection.');
			const btnContainer = document.querySelector('.col-md-12') || document.querySelector('form') || document.body;
			const fallbackWrap = document.createElement('div');
			fallbackWrap.style.cssText = 'margin:15px 0; display:flex; align-items:center; gap:10px;';

			const firstBtn = btnContainer.querySelector('button');
			if (firstBtn) btnContainer.insertBefore(fallbackWrap, firstBtn);
			else btnContainer.prepend(fallbackWrap);

			// Reuse injectButtonInstance via a throwaway anchor node.
			const anchor = document.createElement('span');
			fallbackWrap.appendChild(anchor);
			injectButtonInstance(anchor, '');
			anchor.remove();
		}

		_buttonInjected = true;
		refreshUserMismatchIndicator();

		window.DGCA_STORAGE.onChanged((changes, area) => {
			if (area === 'session' && (changes.dgca_pending_rows || changes.dgca_queue_user || changes.dgca_session_running)) {
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

	if (!table._dgcaListenerAttached) {
		table._dgcaListenerAttached = true;
		table.addEventListener('change', (e) => {
			if (!e.target.classList.contains('dgca-row-chk')) return;
			const tr = e.target.closest('tr');
			if (!tr || !isDataRow(tr)) return;

			const row = parseRow(tr); // _offset is already 1
			if (!row) return;

			if (e.target.checked) _selectedRows[row.id] = row;
			else delete _selectedRows[row.id];

			updateSelectionBadge();

			const chkAllEl = document.getElementById('dgca-chk-all');
			if (chkAllEl) {
				const all = table.querySelectorAll('.dgca-row-chk');
				const checked = table.querySelectorAll('.dgca-row-chk:checked');
				chkAllEl.checked = checked.length === all.length;
				chkAllEl.indeterminate = checked.length > 0 && checked.length < all.length;
			}
		});
	}
	}

	function parseRowFromCheckbox(chk) {
		const tr = chk.closest('tr');
		if (!tr || !isDataRow(tr)) return null;
		return parseRow(tr); // _offset is already 1
	}

	function updateSelectionBadge() {
		const text = `${Object.keys(_selectedRows).length} selected`;
		document.querySelectorAll('.dgca-sel-count').forEach(badge => { badge.textContent = text; });
	}

	function onSendClick() {
		const newRows = Object.values(_selectedRows);
		if (newRows.length === 0) {
			alert('No rows selected. Please check at least one row.');
			return;
		}

		const currentUser = getAaiUser();

		window.DGCA_STORAGE.get(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_queue_user', 'dgca_session_running'])
			.then((data) => {
				const existing = data?.dgca_pending_rows || [];
				const existingStatus = data?.dgca_row_status || [];
				const existingErrors = data?.dgca_row_errors || {};
				const queueUser = data?.dgca_queue_user || null;

				if (data?.dgca_session_running) {
					refreshUserMismatchIndicator();
					alert('A fill session is currently running on the DGCA tab. Please wait for it to finish or abort it there before adding more rows.');
					return;
				}

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
					// The write above already fires storage.onChanged, which the
					// background script relays to the DGCA tab's toolbar (see
					// service-worker.js); the popup, a trusted extension context,
					// listens to chrome.storage.onChanged directly whenever it's
					// open. No separate broadcast is needed here.
					const successText = `✓ ${toAdd.length} added (${merged.length} total)`;
					document.querySelectorAll('.dgca-send-btn').forEach(btn => {
						const orig = btn.textContent;
						btn.textContent = successText;
						btn.style.background = '#6c757d';
						setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 3000);
					});

					document.querySelectorAll('.dgca-toast-msg').forEach(toast => {
						toast.textContent = 'Data imported, Open DGCA Entry Page to Fill the Entries.';
						toast.style.display = 'inline-block';
						setTimeout(() => { toast.style.display = 'none'; }, 6000);
					});

					updateSelectionBadge();
					// refreshUserMismatchIndicator() is intentionally not called
					// here — the dgca_pending_rows/dgca_queue_user write above
					// already fires the window.DGCA_STORAGE.onChanged listener
					// registered in ensureButtonInjected(), which calls it.
				});
			})
			.catch((err) => {
				console.error('[DGCA] Failed to queue rows:', err);
				alert('Failed to save rows to queue. Please try again.');
			});
	}

	function setup() {
		injectShimmerStyle();
		ensurePreviewButtonShimmer();

		const table = document.querySelector('table');
		if (!table) {
			const obs = new MutationObserver((_, o) => {
				ensurePreviewButtonShimmer();
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