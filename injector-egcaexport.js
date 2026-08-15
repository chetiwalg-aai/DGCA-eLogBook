// Runs on https://iamatc.aai.aero/atc/EGcAexport* — adds row checkboxes and
// one or more "Add to DGCA Queue" buttons, pushing selected rows into the
// shared queue that dgca-filler.js's toolbar reads on the DGCA portal.
(function () {
	'use strict';

	// sortQueue/escAttr live in shared.js (window.DGCA) so this file and the
	// DGCA-side toolbar (dgca-filler.js) share one implementation of queue
	// sorting/escaping instead of two copies that could drift apart.
	const { sortQueue, escAttr } = window.DGCA;

	let _selectedRows = {};

	function _normHeader(s) {
		return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
	}

	// Reads the table's own header row, in document order, ignoring our own
	// injected checkbox <th> so the returned list lines up 1:1 with the
	// data <td>s readRowByHeaders() below pulls out of each row. Read fresh
	// each call rather than cached — it's just a handful of <th> lookups, so
	// there's no real cost, and it means a header rename/reorder/addition on
	// the page is picked up immediately with zero changes needed here.
	//
	// No fixed column-name list is kept in this file at all: whatever
	// headers the table has, that's what gets read and queued (see
	// readRowByHeaders()/parseRow() below, which spread every column through
	// unchanged). If the portal adds/renames/removes a column, this file
	// doesn't need touching — only dgca-filler.js, which is the one place
	// that actually knows what each named field means and does anything
	// with it (raw['HEADER_NAME']).
	function getTableHeaders(table) {
		const thead = table.querySelector('thead');
		if (!thead) return [];
		const headerRow = thead.querySelector('tr');
		if (!headerRow) return [];
		return Array.from(headerRow.querySelectorAll('th'))
			.filter(th => !th.classList.contains('dgca-chk-header'))
			.map(th => _normHeader(th.textContent));
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

	// Reads a single <td>'s value. Handles both plain text cells and the
	// ATS_EGCA_ID cell, which can be either a <select class="ats-egca-picker">
	// (pick from known name+EGCA-ID pairs) or plain free text, depending on
	// the row.
	//
	// Uses textContent — NOT innerText. Several columns on this table (e.g.
	// TOTAL_DURATION) are visually hidden via `.hide-col { display:none
	// !important }`, kept in the DOM only so the portal's own "Download eGCA
	// CSV" button can still read them (see downloadEgcaCsv() in the page's
	// own script, which does the same textContent trick). innerText is
	// layout-aware and returns '' for anything display:none; textContent
	// ignores rendering entirely and always returns the cell's real text —
	// same reasoning as reading a checkbox's containing <td>, which has no
	// textContent of its own to worry about either way.
	function readCellValue(td) {
		const select = td.querySelector('select');
		if (select) return _selectCellText(select);
		return td.textContent.trim();
	}

	// Reads one data row into a plain object keyed by header text, ignoring
	// our own injected checkbox <td> so cells line up 1:1 with the headers
	// array from getTableHeaders() (both filter out the same dgca-chk-*
	// element). Cells are matched to headers positionally, left to right.
	function readRowByHeaders(tr, headers) {
		const cells = Array.from(tr.children).filter(el =>
			el.tagName === 'TD' && !el.classList.contains('dgca-chk-cell'));
		const raw = {};
		headers.forEach((name, i) => {
			const td = cells[i];
			raw[name] = td ? readCellValue(td) : '';
		});
		return raw;
	}

	function isDataRow(tr) {
		const table = tr.closest('table');
		if (!table) return false;
		const raw = readRowByHeaders(tr, getTableHeaders(table));
		return /^\d{2}\/\d{2}\/\d{4}$/.test(raw['FROM_DATE'] || '');
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

	// Flat, keyed by the EGCA table's own header names — row['FROM_DATE'],
	// row['POSTING_STATION'], row['TYPE_OF_DUTY'], etc. — plus a computed
	// `id` (for queue dedup/selection) and `date` (normalised, used for
	// sorting). dgca-filler.js reads the same object back via
	// raw['HEADER_NAME'] with no translation layer in between.
	function parseRow(tr) {
		const table = tr.closest('table');
		if (!table) return null;

		const raw = readRowByHeaders(tr, getTableHeaders(table));
		const rawFromDate = raw['FROM_DATE'] || '';
		if (!/^\d{2}\/\d{2}\/\d{4}$/.test(rawFromDate)) return null;

		const date = normaliseEgcaDate(rawFromDate);
		const station = (raw['ICAO_CODE'] || '').trim().toUpperCase();
		const timeFrom = raw['START_TIME'] || '';
		const timeTo = raw['END_TIME'] || '';
		const dutyType = raw['TYPE_OF_DUTY'] || '';

		raw['FROM_DATE'] = date; // normalise in place, DD-MM-YYYY
		if (raw['TO_DATE']) raw['TO_DATE'] = normaliseEgcaDate(raw['TO_DATE']);

		return { id: rowId(date, station, timeFrom, timeTo, dutyType), date, ...raw };
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
		table.querySelectorAll('td.dgca-chk-cell').forEach(td => td.remove());
		const rows = table.querySelectorAll('tr');
		const startIndex = rows[0] && rows[0].querySelector('th') ? 1 : 0;

		for (let i = startIndex; i < rows.length; i++) {
			const tr = rows[i];
			const td = document.createElement('td');
			td.className = 'dgca-chk-cell';
			td.style.cssText = 'text-align:center;vertical-align:middle;border:1px solid #ddd;min-width:36px;';

			// isDataRow()/parseRow() both read headers via getTableHeaders(),
			// which already ignores our injected checkbox <th>, and read
			// cells via readRowByHeaders(), which already ignores our
			// injected checkbox <td> — so this works whether or not the
			// checkbox column/cells for this row have been injected yet, no
			// offset bookkeeping needed.
			const dataRow = isDataRow(tr);
			const previewRow = dataRow ? parseRow(tr) : null;

			if (previewRow) {
				const isChecked = !!_selectedRows[previewRow.id];
				td.innerHTML = `<input type="checkbox" class="dgca-row-chk"
          data-row-id="${escAttr(previewRow.id)}"
          style="cursor:pointer;width:16px;height:16px;"
          ${isChecked ? 'checked' : ''}>`;
			}
			tr.insertBefore(td, tr.firstChild);
		}

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

			const row = parseRow(tr);
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
		return parseRow(tr);
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

	// Shows a fixed banner telling the user this page is stripping our
	// injected elements back out (e.g. a MutationObserver on the page that
	// removes any newly-added node). This only reports the situation
	function showBlockedNotice() {
		if (document.getElementById('dgca-blocked-notice')) return;

		if (!document.getElementById('dgca-blocked-notice-style')) {
			const style = document.createElement('style');
			style.id = 'dgca-blocked-notice-style';
			style.textContent = `
				#dgca-blocked-notice {
					position: fixed;
					top: 16px;
					right: 16px;
					z-index: 999999;
					width: 340px;
					max-width: calc(100vw - 32px);
					background: #fffbeb;
					color: #664d03;
					border: 1px solid #ffe69c;
					border-top: 4px solid #f0a500;
					border-radius: 10px;
					padding: 16px 16px 14px;
					font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
					font-size: 13px;
					line-height: 1.5;
					box-shadow: 0 8px 24px rgba(0,0,0,.18);
					animation: dgca-blocked-notice-in .25s ease-out;
				}
				@keyframes dgca-blocked-notice-in {
					from { opacity: 0; transform: translateY(-8px); }
					to { opacity: 1; transform: translateY(0); }
				}
				.dgca-blocked-notice__head {
					display: flex;
					align-items: flex-start;
					gap: 10px;
					margin-bottom: 8px;
				}
				.dgca-blocked-notice__icon {
					font-size: 20px;
					line-height: 1;
					flex-shrink: 0;
				}
				.dgca-blocked-notice__title {
					font-size: 14px;
					font-weight: 700;
					color: #92400e;
					flex: 1;
				}
				.dgca-blocked-notice__close {
					cursor: pointer;
					font-weight: bold;
					font-size: 16px;
					line-height: 1;
					color: #92400e;
					opacity: .6;
					flex-shrink: 0;
					padding: 2px;
				}
				.dgca-blocked-notice__close:hover { opacity: 1; }
				.dgca-blocked-notice__body { margin: 0 0 12px; }
				.dgca-blocked-notice__body p { margin: 0 0 6px; }
				.dgca-blocked-notice__body p:last-child { margin-bottom: 0; }
				.dgca-blocked-notice__btn {
					display: flex;
					align-items: center;
					justify-content: center;
					gap: 6px;
					width: 100%;
					box-sizing: border-box;
					background: #f0a500;
					color: #3a2a00;
					font-weight: 700;
					font-size: 13px;
					text-decoration: none;
					border-radius: 6px;
					padding: 9px 12px;
					transition: background .15s;
				}
				.dgca-blocked-notice__btn:hover { background: #d99400; color: #3a2a00; }
				.dgca-blocked-notice__thanks {
					margin-top: 10px;
					font-size: 12px;
					color: #8a6d1f;
					text-align: center;
				}
			`;
			document.head.appendChild(style);
		}

		const notice = document.createElement('div');
		notice.id = 'dgca-blocked-notice';
		notice.innerHTML = `
			<div class="dgca-blocked-notice__head">
				<span class="dgca-blocked-notice__icon">⚠️</span>
				<span class="dgca-blocked-notice__title">DGCA eLogBook Automator Extension blocked</span>
				<span id="dgca-blocked-notice-close" class="dgca-blocked-notice__close">&times;</span>
			</div>
			<div class="dgca-blocked-notice__body">
				<p>Due to recent changes in site, the extension is no longer functional.</p>
				<p>If this issue persists, uninstall this extension and use the official extension instead:</p>
			</div>
			<a class="dgca-blocked-notice__btn" href="https://chromewebstore.google.com/detail/egca-atc-logbook-autofill/fdhkbilacfkbfgghadoeefcblipnlhgd" target="_blank" rel="noopener noreferrer">
				🔗 Get Official Extension
			</a>
			<div class="dgca-blocked-notice__body" style="margin-top:10px;">
				<p>For support with the new extension, contact the IAMATC Site.</p>
			</div>
			<div class="dgca-blocked-notice__thanks">Thank you for your support and understanding ❤️</div>
		`;
		document.body.appendChild(notice);
		const closeBtn = document.getElementById('dgca-blocked-notice-close');
		if (closeBtn) closeBtn.addEventListener('click', () => notice.remove());
	}

	// Checks, a short beat after setup() runs, whether our injected elements
	// are still present. Something on the page (e.g. a MutationObserver)
	// can insert them into the DOM and then remove them within the same
	// tick/microtask, so this check runs on the next macrotask rather than
	// immediately after injection.
	function checkInjectionSurvived() {
		setTimeout(() => {
			const headerOk = !!document.querySelector('.dgca-chk-header');
			const buttonOk = !!document.querySelector('.dgca-inline-btn-wrapper');
			if (!headerOk || !buttonOk) showBlockedNotice();
		}, 500);
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
		checkInjectionSurvived();
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
	else setup();
})();