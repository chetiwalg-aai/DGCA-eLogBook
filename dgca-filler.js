/**
dgca-filler.js
Runs on: https://www.dgca.gov.in/*

Injects a toolbar on the DGCA e-Log Book entry page that reads the shared
row queue (built on the AAI EGCA-export page by injector-egcaexport.js),
lets the user review/reorder/delete rows, and fills the entry form for each
queued row one at a time. All dropdowns are matched by their exact visible
text against the raw values captured from the EGCA export table — no static
value maps needed.
*/
(function () {
	'use strict';
	const { parseDateDMY, formatDDMMYYYY, sleep, addOneDay, namesMatch, escHtml } = window.DGCA;

	// ── Shared selectors ────────────────────────────────────────────────────
	const SEL = {
		briefingCheckbox: '#isbriefingDone',
		fromDate: '#logBookDate',
		toDate: '#logBookEndDate',
		postingStation: '#postingStation',
		wsoEgcaId: '#atStoEgcaId',
		ratingId: '#ratingId',
		atsUnitId: '#atsUnitId',
		remarksField: '#ratingAndAtsRemarks',
		typeOfDutyId: '#typeOfDutyId',
		ojtFieldsDiv: '#ojtFields',
		ojtEnv: '#ojtOprEnvSmlation',
		ojtTrainerName: '#ojtTrainerName',
		examinerLicNumDiv: '#examinerLicenseNumberDiv',
		examinerAtcol: '#examinerLicenseNumber',
		traineeLicNumDiv: '#traineeLicenseNumberDiv',
		traineeAtcol: '#traineeLicenseNumber',
		isProficiency: '#isProficiencyChecked',
		isTheoryClasses: '#isTheoryClasses',
		isSkillTest: '#isSkillTestChecked',
		isOjtProvided: '#isOjtProvided',
		startTime: '#ojtStartTime',
		endTime: '#ojtEndTime',
		addButton: '#btnAddanssTrnTrainingDtlsVOList',
		resultTable: '#anssELogBookDtlsVOList',
		// Portal's own global AJAX-busy indicator. showProgressbar()/
		// hideProgressbar() (statusbar.js) are the only things that toggle
		// this element's visibility — set to 'visible' when a request starts,
		// 'hidden' when it finishes. That's the single source of truth; the
		// element's own #imgtd/#statuBarTd1 children are not (see comment on
		// isStatusbarIdle below).
		statusbar: '#statusbar',
	};

	// ── Alert capture (fed by alert-interceptor.js in the MAIN world) ──────
	const ALERT_EVENT_NAME = 'dgca_alert_captured';
	let _lastCapturedAlert = null;

	window.addEventListener(ALERT_EVENT_NAME, (e) => {
		_lastCapturedAlert = e.detail.msg;
	});

	// ── Session state broadcast (consumed by alert-interceptor.js in the
	// MAIN world) — tells it whether native alert()/confirm()/prompt() should
	// be suppressed (auto-handled during automation) or passed through to the
	// real dialog (manual entry, nothing queued/running). Must match
	// SESSION_EVENT_NAME in alert-interceptor.js.
	const SESSION_STATE_EVENT = 'dgca_session_state_changed';
	function notifySessionState(running) {
		try {
			const detail = { running: !!running };
			// Firefox wraps objects created by an isolated-world content
			// script in an Xray wrapper, so the page's MAIN-world listener
			// (alert-interceptor.js) can see the event fire but can't read
			// properties off `detail` — it comes through as effectively
			// undefined, so _sessionRunning there never flips and native
			// dialogs never get auto-dismissed. cloneInto() (a Firefox-only
			// content-script global — absent in Chrome, hence the feature
			// check) makes a plain clone in the page's own scope that it
			// can read normally. Chrome has no such restriction and no
			// cloneInto, so it just uses the object as-is.
			const eventDetail = (typeof cloneInto === 'function')
				? cloneInto(detail, window)
				: detail;
			window.dispatchEvent(new CustomEvent(SESSION_STATE_EVENT, { detail: eventDetail }));
		} catch (_) { }
		document.getElementById('dgca-ext-toolbar')?.classList.toggle('dgca-ext-toolbar--session-running', !!running);
		// Persisted (not just an in-page event) so the popup and the
		// EGCA-export injector — separate tabs/contexts that can't see this
		// page's window events — can also lock out queue mutation (Clear
		// All / Add to Queue / Clear Queue) while a fill session is active.
		window.DGCA_STORAGE.set({ dgca_session_running: !!running }).catch(() => { });
	}

	function detectAlert() {
		if (_lastCapturedAlert) {
			const msg = _lastCapturedAlert;
			_lastCapturedAlert = null;
			return msg;
		}
		const selectors = ['.swal2-popup:not(.swal2-toast)', '.modal.show', '.alertmsg:not([id^="alert_"]):not(:empty)', '.alert-danger:not(:empty)', '.error-msg:not(:empty)'];
		for (const sel of selectors) {
			const el = document.querySelector(sel);
			if (el && getComputedStyle(el).display !== 'none') {
				const txt = el.innerText?.trim();
				if (txt && txt.length < 500) return txt;
			}
		}
		return null;
	}

	async function dismissModals() {
		if (window.Swal && typeof window.Swal.close === 'function') {
			try { window.Swal.close(); } catch (_) { }
		}
		document.querySelector('.swal2-confirm')?.click();
		document.querySelectorAll('.modal.show, .modal[style*="display: block"]').forEach(m => { m.style.display = 'none'; m.classList.remove('show'); });
		document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
		document.body.classList.remove('modal-open');
		document.body.style.overflow = '';
		document.body.style.paddingRight = '';
		await sleep(200);
	}

	async function waitForSelector(sel, timeout = 10000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const el = document.querySelector(sel);
			if (el) return el;
			await sleep(80);
		}
		throw new Error(`Timeout waiting for element: ${sel}`);
	}

	async function waitForSelectOptions(sel, timeout = 12000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const el = document.querySelector(sel);
			if (el) {
				const real = Array.from(el.options).filter(o => o.value && o.value !== '-1');
				if (real.length > 0) return el;
			}
			await sleep(120);
		}
		throw new Error(`Timeout waiting for options in: ${sel}`);
	}

	async function waitForOptionValue(sel, value, timeout = 10000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const el = document.querySelector(sel);
			if (el) {
				const opt = Array.from(el.options).find(o => o.value === value);
				if (opt) return el;
			}
			await sleep(120);
		}
		throw new Error(`Option value "${value}" never appeared in ${sel}`);
	}

	async function waitForVisible(sel, timeout = 8000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const el = document.querySelector(sel);
			if (el && getComputedStyle(el).display !== 'none') return el;
			await sleep(80);
		}
		throw new Error(`Timeout waiting for element to become visible: ${sel}`);
	}

	async function waitForFieldValue(selector, timeout = 10000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const el = document.querySelector(selector);
			if (el && el.value && el.value.trim() !== '') return el;
			await sleep(100);
		}
		throw new Error(`Timeout waiting for value in: ${selector}`);
	}

	function _normText(s) {
		return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
	}

	/**
	 * Select an option by matching its visible text rather than a pre-built
	 * value map. Useful for EGCA-export sourced data, where the source table
	 * already contains the exact human-readable label (posting station name,
	 * rating name, etc.) that appears in the DGCA portal's own <option> text.
	 *
	 * Tries an exact (normalized) match first, then a loose contains-match
	 * either direction, so minor formatting differences (extra spaces, a
	 * trailing "AIRPORT" etc.) don't break it. Throws if nothing matches so
	 * callers can fall back to a static map when needed.
	 */
	async function selectByText(selector, text) {
		const el = await waitForSelector(selector);
		const target = _normText(text);
		if (!target) throw new Error(`selectByText: empty target text for ${selector}`);

		const options = Array.from(el.options).filter(o => o.value && o.value !== '-1');
		let match = options.find(o => _normText(o.text) === target);
		if (!match) {
			match = options.find(o => _normText(o.text).includes(target) || target.includes(_normText(o.text)));
		}
		if (!match) {
			throw new Error(`selectByText: no option matching "${text}" in ${selector}`);
		}

		el.value = match.value;
		el.dispatchEvent(new Event('change', { bubbles: true }));
		el.dispatchEvent(new Event('input', { bubbles: true }));
		if (window.jQuery) {
			try {
				const $el = window.jQuery(el);
				if (typeof $el.selectpicker === 'function') {
					$el.selectpicker('val', match.value);
					$el.selectpicker('refresh');
				}
			} catch (_) { }
		}
		await sleep(150);
		return match.value;
	}

	async function selectByValue(selector, value) {
		const el = await waitForOptionValue(selector, value);
		el.value = value;
		el.dispatchEvent(new Event('change', { bubbles: true }));
		el.dispatchEvent(new Event('input', { bubbles: true }));
		if (window.jQuery) {
			try {
				const $el = window.jQuery(el);
				if (typeof $el.selectpicker === 'function') {
					$el.selectpicker('val', value);
					$el.selectpicker('refresh');
				}
			} catch (_) { }
		}
		await sleep(150);
	}

	async function setDatePickerValue(selector, dateStr) {
		const el = await waitForSelector(selector);
		el.value = dateStr;
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		el.dispatchEvent(new Event('blur', { bubbles: true }));
		if (el.onblur) { try { el.onblur(); } catch (_) { } }
		await sleep(100);
	}

	async function typeIntoField(selector, text) {
		const el = await waitForSelector(selector);
		el.value = '';
		el.dispatchEvent(new Event('focus', { bubbles: true }));
		await sleep(30);
		el.value = String(text);
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		el.dispatchEvent(new Event('blur', { bubbles: true }));
		if (el.onblur) { try { el.onblur(); } catch (_) { } }
		await sleep(80);
	}

	async function ensureCheckbox(selector, shouldBeChecked) {
		const el = await waitForSelector(selector);
		if (getComputedStyle(el).display === 'none') return;
		if (el.checked !== shouldBeChecked) {
			el.click();
			await sleep(100);
		}
	}

	function countResultTableRows() {
		const counter = document.querySelector('#anssELogBookDtlsVOListcounter');
		if (counter) {
			const n = parseInt(counter.value, 10);
			return isNaN(n) ? 0 : n;
		}
		const tbl = document.querySelector(SEL.resultTable);
		if (!tbl) return 0;
		return tbl.querySelectorAll('tr[id^="row"]').length;
	}

	async function resetFields() {
		try {
			_lastCapturedAlert = null;
			await dismissModals();
			const resetBtn = document.querySelector('#btnResetanssTrnTrainingDtlsVOList');
			if (resetBtn) {
				resetBtn.click();
				await sleep(400);
			} else {
				for (const sel of [SEL.fromDate, SEL.toDate]) {
					const el = document.querySelector(sel);
					if (!el) continue;
					el.value = '';
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				}
				for (const sel of [SEL.startTime, SEL.endTime, SEL.examinerAtcol, SEL.traineeAtcol]) {
					const el = document.querySelector(sel);
					if (!el) continue;
					el.value = '';
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('blur', { bubbles: true }));
				}
				await sleep(300);
			}
		} catch (_) { }
	}

	// ── Portal's global AJAX-busy indicator ──────────────────────────────────
	// Clicking Add kicks off a server round-trip; the result table can update
	// (optimistically, client-side) before that round-trip has actually
	// finished on the server. If the next row's Add gets clicked while the
	// server is still processing the previous one, the portal can't handle
	// the overlapping request and that row errors out — even though nothing
	// was wrong with its data. #imgtd/#statuBarTd1 (statusbar.js) are the
	// portal's own busy indicator, so wait for those to go idle rather than
	// trusting the row count alone.
	// Verified against statusbar.js/.css: showProgressbar() sets
	// #statusbar.style.visibility = 'visible' and disables the background;
	// hideProgressbar() sets it back to 'hidden'. Those two functions are
	// the only things that touch this element's visibility, so it's a
	// reliable busy/idle signal — unlike #imgtd (a CSS background-image,
	// never gets a spinner <img> child to detect) or #statuBarTd1 (its
	// text-setting line is commented out in statusbar.js and the CSS keeps
	// it display:none regardless, so it's effectively dead and never
	// reflects busy state).
	function isStatusbarIdle() {
		const bar = document.querySelector(SEL.statusbar);
		if (!bar) return true; // element not present — nothing to gate on
		return getComputedStyle(bar).visibility !== 'visible';
	}

	async function waitForStatusbarIdle(timeout = 8000) {
		// Give the framework a moment to actually flip into the busy state
		// first — checking immediately after a click can catch the
		// pre-request idle state and return instantly, defeating the point.
		await sleep(150);
		const startedAt = Date.now();
		const deadline = startedAt + timeout;
		while (Date.now() < deadline) {
			if (isStatusbarIdle()) {
				const waited = Date.now() - startedAt;
				// Only log waits that actually cost meaningful time, so this
				// doesn't spam the console on the common case where the
				// portal was already idle. Useful for telling "genuinely
				// slow server response" apart from "stuck at the timeout."
				if (waited > 500) console.log(`[DGCA Filler] statusbar idle after ${waited}ms`);
				return true;
			}
			await sleep(120);
		}
		// Timed out — the indicator may just not be wired the way we expect
		// for this action, or the request is genuinely taking longer than
		// `timeout`. Proceed rather than stalling the whole session; the
		// existing row-count/alert checks are still the actual source of
		// truth for whether the row was added.
		console.warn(`[DGCA Filler] statusbar still busy after ${timeout}ms wait — proceeding anyway`);
		return false;
	}

	// Waits for the portal's busy indicator to actually appear after a
	// click, rather than assuming it will. Mirrors isStatusbarIdle's caveat
	// in reverse: some actions may not toggle #statusbar at all, so this
	// times out and returns false instead of hanging if busy never shows.
	async function waitForStatusbarBusy(timeout = 2000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (!isStatusbarIdle()) return true;
			await sleep(50);
		}
		return false;
	}

	async function clickAddAndVerify() {
		const rowsBefore = countResultTableRows();
		const addBtn = await waitForSelector(SEL.addButton, 6000);

		// NOTE: no pre-click wait here anymore. The previous call to this
		// function already waits for idle right before it returns (below),
		// and resetFields()/fillRow() run several of their own awaited
		// steps in between — so by the time we get here the portal is
		// already idle in the overwhelmingly common case, and paying the
		// 150ms floor + poll cadence again here was pure overhead. If
		// something outside this loop left it busy, the click below will
		// simply queue behind it same as it always could.

		_lastCapturedAlert = null;
		addBtn.click();

		// Mirror the page's real sequence: spinner appears first, then
		// either a validation alert or the spinner clearing (with the row
		// landing) resolves it. Confirming busy first means the alert/
		// row-count check below is reacting to *this* click's request, not
		// to stale state left over from before the click.
		const wentBusy = await waitForStatusbarBusy();
		if (!wentBusy) {
			console.log('[DGCA Filler] statusbar never went busy after Add click — proceeding without it as a gate');
		}

		// Poll for either a validation alert, or the statusbar going idle
		// again with the row count having ticked up — whichever comes
		// first. Both are checked in the same loop so neither has to wait
		// out a separate fixed timeout before the other is noticed.
		const POLL_MS = 150;
		const FAST_POLL_MS = 4000;
		const fastDeadline = Date.now() + FAST_POLL_MS;
		let alertText = null;
		let rowsAfter = rowsBefore;
		let wentIdle = false;
		while (Date.now() < fastDeadline) {
			await sleep(POLL_MS);
			alertText = await detectAlert();
			if (alertText) break;
			if (isStatusbarIdle()) {
				wentIdle = true;
				rowsAfter = countResultTableRows();
				if (rowsAfter > rowsBefore) break;
			}
		}

		if (alertText) {
			await dismissModals();
			await waitForStatusbarIdle();
			return { ok: false, error: `Portal validation error: ${alertText}` };
		}

		if (!wentIdle || rowsAfter <= rowsBefore) {
			// Either the statusbar hasn't cleared yet, or it cleared but the
			// row count hasn't caught up within the fast-poll window. Rather
			// than declaring failure off a fixed timeout, wait for idle
			// explicitly — it can take longer than the fast-poll window on a
			// loaded server. This is what previously produced "Row was not
			// added" errors for rows that, in fact, did get added a moment
			// later: the fixed window gave up before a slow response landed,
			// and nothing checked again afterward.
			await waitForStatusbarIdle(10000);
			rowsAfter = countResultTableRows();

			if (rowsAfter <= rowsBefore) {
				const lateAlert = await detectAlert();
				if (lateAlert) {
					await dismissModals();
					return { ok: false, error: `Portal validation error (late): ${lateAlert}` };
				}
				return { ok: false, error: `Row was not added to the table (before: ${rowsBefore}, after: ${rowsAfter}).` };
			}
		}

		// Row count has ticked up and the statusbar has already gone idle
		// in this loop's own check — no need to re-wait for idle again here.
		return { ok: true };
	}

	// ── Row filling logic ────────────────────────────────────────────────────
	async function fillRow(row, wsoAtsText = 'WSO') {
		const { timeFrom, timeTo } = row;
		const raw = row.egcaRaw || {};

		const { d, m, y } = parseDateDMY(raw.fromDate);
		const fromDateStr = formatDDMMYYYY(d, m, y);

		let toDateStr;
		if (raw.fromDate === raw.toDate && timeTo === '00:00') {
			const n = addOneDay(d, m, y);
			toDateStr = formatDDMMYYYY(n.d, n.m, n.y);
		} else {
			const { d: d2, m: m2, y: y2 } = parseDateDMY(raw.toDate);
			toDateStr = formatDDMMYYYY(d2, m2, y2);
		}

		await ensureCheckbox(SEL.briefingCheckbox, true);
		await setDatePickerValue(SEL.fromDate, fromDateStr);
		await setDatePickerValue(SEL.toDate, toDateStr);

		// ── Posting Station (by text) ────────────────────────────────────────
		await selectByText(SEL.postingStation, raw.postingStation);
		await waitForFieldValue('#letterIcaoCode');

		// ── WSO / ATS EGCA ID (by text) ──────────────────────────────────────
		await waitForSelectOptions(SEL.wsoEgcaId);
		if (raw.atsEgcaId) {
			try {
				await selectByText(SEL.wsoEgcaId, raw.atsEgcaId);
			} catch (err) {
				const altText = raw.atsEgcaId.replace(/_/g, ' ');
				if (altText !== raw.atsEgcaId) {
					await selectByText(SEL.wsoEgcaId, altText);
				} else {
					throw err;
				}
			}
		} else {
			await selectByText(SEL.wsoEgcaId, wsoAtsText);
		}


		if (raw.rating) {
			// ── Rating (by text) ─────────────────────────────────────────────────
			await selectByText(SEL.ratingId, raw.rating);

			// ── ATS Unit (by text) ───────────────────────────────────────────────
			await waitForSelectOptions(SEL.atsUnitId);
			await selectByText(SEL.atsUnitId, raw.atsUnit.replace(/-/g, ''));
		}

		// ── Type of Duty (by text) ───────────────────────────────────────────
		await selectByText(SEL.typeOfDutyId, raw.typeOfDuty);

		if (raw.typeOfDuty === 'Operation Duty(Control)') {
			if (raw.proficiencyCheck === 'Y') {
				await ensureCheckbox(SEL.isProficiency, true);
				await waitForVisible(SEL.examinerLicNumDiv);
				await selectByText(SEL.ojtEnv, raw.ojtEnv);
				await typeIntoField(SEL.examinerAtcol, raw.instructorLicense);
				await waitForFieldValue(SEL.ojtTrainerName);
			}
			if (raw.newlyEstabStation) {
				await ensureCheckbox('#isAtsUnitChecked', true);
			}

		} else if (raw.typeOfDuty === 'Instruction') {
			if (raw.knowledgeCheck === 'Y') {
				await ensureCheckbox(SEL.isTheoryClasses, true);
				if (raw.traineeLicense) {
					await typeIntoField(SEL.remarksField, `${raw.traineeName} (${raw.traineeLicense})`);
				}
			} else if (raw.ojtProvidedCheck === 'Y') {
				await ensureCheckbox(SEL.isOjtProvided, true);
				await waitForVisible(SEL.traineeLicNumDiv);
				await selectByText(SEL.ojtEnv, raw.ojtEnv);
				await typeIntoField(SEL.traineeAtcol, raw.traineeLicense);
				const instructorField = await waitForFieldValue('#nameOfInstructor');
				if (raw.traineeLicenType === "SATCOL" && raw.traineeName) {
					await typeIntoField('#nameOfInstructor', raw.traineeName.toUpperCase());
				} else if (raw.traineeName && !namesMatch(instructorField.value, raw.traineeName)) {
					await typeIntoField('#nameOfInstructor', raw.traineeName.toUpperCase());
				}
			}

		} else if (raw.typeOfDuty === 'OJT (On Job Training)') {
			await waitForVisible(SEL.examinerLicNumDiv);
			await selectByText(SEL.ojtEnv, raw.ojtEnv);
			await typeIntoField(SEL.examinerAtcol, raw.instructorLicense);
			await waitForFieldValue(SEL.ojtTrainerName);

		} else if (raw.typeOfDuty === 'Examiner Functions') {
			if (raw.knowledgeCheck === 'Y') {
				await ensureCheckbox(SEL.isTheoryClasses, true);
				await typeIntoField('#nameOfInstructor', raw.instructorName);
			} else if (raw.proficiencyCheck === 'Y') {
				await ensureCheckbox(SEL.isProficiency, true);
				await waitForVisible(SEL.ojtFieldsDiv);
				await selectByText(SEL.ojtEnv, raw.ojtEnv);
				await typeIntoField(SEL.traineeAtcol, raw.traineeLicense);
				await waitForFieldValue('#nameOfInstructor');
			} else if (raw.skillTestCheck === 'Y') {
				await ensureCheckbox(SEL.isSkillTest, true);
				await waitForVisible(SEL.ojtFieldsDiv);
				await selectByText(SEL.ojtEnv, raw.ojtEnv);
				await typeIntoField(SEL.traineeAtcol, raw.traineeLicense);
				const instructorField = await waitForFieldValue('#nameOfInstructor');
				if (raw.traineeLicenType === "SATCOL" && raw.traineeName) {
					await typeIntoField('#nameOfInstructor', raw.traineeName.toUpperCase());
				} else if (raw.traineeName && !namesMatch(instructorField.value, raw.traineeName)) {
					await typeIntoField('#nameOfInstructor', raw.traineeName.toUpperCase());
				}
			}

		} else if (raw.typeOfDuty === 'Classroom training/Classroom theory functions') {
			await waitForVisible(SEL.ojtFieldsDiv);
			await waitForVisible(SEL.examinerLicNumDiv);
			await typeIntoField(SEL.examinerAtcol, raw.instructorLicense);
			await waitForFieldValue(SEL.ojtTrainerName);

		} else if (raw.typeOfDuty === 'Skill test') {
			await waitForVisible(SEL.ojtFieldsDiv);
			await selectByText(SEL.ojtEnv, raw.ojtEnv);
			await typeIntoField(SEL.ojtTrainerName, raw.instructorName);

		} else if (raw.typeOfDuty === 'Familiarization of ATS Unit') {
			await waitForVisible(SEL.ojtFieldsDiv);
			await selectByText(SEL.ojtEnv, raw.ojtEnv);
			await typeIntoField('#newlyEstablisAtstsation', raw.newlyEstabStation);

		} else if (raw.typeOfDuty === 'ART(Annual Refresher Training)') {
			// ART logic — no extra fields required today.
		}
		// Any other/unrecognised type of duty: no extra fields required.

		await typeIntoField(SEL.startTime, timeFrom);
		await typeIntoField(SEL.endTime, timeTo);
		await waitForFieldValue('#totalDuration');
		await sleep(300);
	}

	let _sessionRunning = false;
	let _aborted = false;

	// ── Inline toolbar injected into the DGCA "Logbook" panel heading ────────
	// The toolbar is the sole queue UI: Start/Abort controls, queue count,
	// row list, and the WSO/ATS mode toggle all live here. State is kept in
	// chrome.storage.session (via window.DGCA_STORAGE) so it survives page
	// navigation and is visible to the EGCA-export page's mismatch banner
	// and the popup's summary.
	let _toolbarEls = null;

	// Row indices whose detail box is currently expanded in the toolbar's
	// queue list — kept outside _toolbarEls since it must survive full
	// row-list re-renders (renderToolbarRowList rebuilds the DOM).
	let _expandedRows = new Set();

	function findLogbookHeading() {
		const titles = document.querySelectorAll('h5.panel-title');
		for (const el of titles) {
			if (el.textContent.trim() === 'Logbook') {
				return el.closest('.panel-heading');
			}
		}
		return null;
	}

	// Only inject the toolbar on the actual e-Log Book entry page, not any
	// other page on the DGCA portal that happens to have its own unrelated
	// "Logbook" panel.
	function isOnEntryPage() {
		const breadcrumbEl = document.querySelector('#breadcrumb');
		const breadcrumbOk = !!breadcrumbEl &&
			breadcrumbEl.textContent.includes('Air Traffic Controllers e-Log Book');
		return breadcrumbOk && !!document.querySelector(SEL.briefingCheckbox);
	}

	// Formats a duration in ms as e.g. "850ms" or "1.4s" — used for the
	// per-row "time to add" badge (debugging / performance monitoring).
	function formatDuration(ms) {
		if (ms == null) return '';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function injectToolbarStyle() {
		if (document.getElementById('dgca-ext-toolbar-style')) return;
		const style = document.createElement('style');
		style.id = 'dgca-ext-toolbar-style';
		style.textContent = `
			.dgca-ext-toolbar {
				display: flex;
				flex-direction: column;
				gap: 5px;
				margin-top: 8px;
				clear: both;
				padding: 7px 10px;
				background: #12121f;
				border: 1px solid #2a2a3e;
				border-radius: 8px;
				box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
				font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
				font-size: 12px;
				color: #e0e0e0;
			}
			.dgca-ext-toolbar-label {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 5px;
				font-size: 10px;
				font-weight: 700;
				letter-spacing: 0.5px;
				text-transform: uppercase;
				color: #7a7a95;
			}
			/* Generic text-shimmer helper — color-parameterized via CSS
			   custom properties so the title and footer credit can share the
			   same animation without duplicating keyframes. The emoji/prefix
			   next to the shimmered text is deliberately kept OUTSIDE this
			   span in the markup: -webkit-background-clip: text +
			   color: transparent applied to a span containing an emoji can
			   cause the emoji glyph itself to flicker/blank (color emoji
			   glyphs don't clip reliably), which was the root cause of the
			   original "glitching" title.
			   The gradient tile is sized to 3x the text's own width
			   (background-size: 300%, relative to the element itself since
			   it's the background-painting area) and only ever travels from
			   background-position 100% to 0%. At both ends of that range the
			   3x-wide tile still fully overlaps the element — so the base
			   shimmer color always sits behind the text and it never drops to
			   fully transparent mid-loop (a fixed px sweep wider than the
			   text, tried earlier, let the tile slide completely off the
			   text and made it flicker invisible at each end). Only the
			   bright highlight band drifts across and off the edges. This is
			   also reflow-safe (percentages, not px): it auto-scales if the
			   text width changes, e.g. a late webfont swap. */
			.dgca-ext-shimmer-text {
				background-image: linear-gradient(90deg,
					var(--dgca-shimmer-base) 0%, var(--dgca-shimmer-base) 40%,
					var(--dgca-shimmer-hi) 50%,
					var(--dgca-shimmer-base) 60%, var(--dgca-shimmer-base) 100%);
				background-size: 300% 100%;
				background-repeat: no-repeat;
				-webkit-background-clip: text;
				background-clip: text;
				-webkit-text-fill-color: transparent;
				color: transparent;
				display: inline-block;
				animation: dgca-ext-shimmer-text 6s linear infinite;
			}
			@keyframes dgca-ext-shimmer-text {
				from { background-position: 100% 0; }
				to   { background-position: 0% 0; }
			}
			/* background-position animations (this one, unlike the
			   transform-based dgca-ext-shimmer-bar) force a repaint every
			   frame — -webkit-background-clip: text has to re-rasterize the
			   glyphs under the moving gradient each time, since it's not a
			   compositor-only property. That's negligible for the
			   title/footer, which mostly sit idle, but the Queue label
			   (--queue) runs continuously through an entire fill session,
			   competing with fillRow()/clickAddAndVerify()'s own DOM writes
			   on the *same* page's main thread — plausibly enough to add up
			   over a long queue. Previously paused (not removed) while a
			   session was running, toggled via the --session-running class
			   on the toolbar root in runSession()/notifySessionState() —
			   but stopping the shimmer during a session is no longer
			   wanted, so it now keeps sweeping continuously regardless of
			   session state. */
			.dgca-ext-shimmer-text--title {
				--dgca-shimmer-base: #7a7a95;
				--dgca-shimmer-hi: #eaf6ff;
			}
			.dgca-ext-shimmer-text--footer {
				--dgca-shimmer-base: #4fc3f7;
				--dgca-shimmer-hi: #ffffff;
				animation-duration: 7s;
			}
			.dgca-ext-video-guide {
				color: #4fc3f7;
				text-decoration: none;
				font-weight: 700;
				letter-spacing: 0.3px;
			}
			.dgca-ext-video-guide:hover {
				text-decoration: underline;
			}
			.dgca-ext-toolbar-row {
				display: flex;
				align-items: center;
				gap: 10px;
				flex-wrap: wrap;
			}
			.dgca-ext-toolbar button {
				border: none;
				border-radius: 6px;
				padding: 6px 14px;
				font-size: 12px;
				font-weight: 600;
				cursor: pointer;
				transition: filter 0.15s, transform 0.05s;
			}
			.dgca-ext-toolbar button:not(:disabled):hover {
				filter: brightness(1.15);
			}
			.dgca-ext-toolbar button:not(:disabled):active {
				transform: translateY(1px);
			}
			.dgca-ext-toolbar button:disabled {
				opacity: 0.4;
				cursor: not-allowed;
			}
			#dgca-ext-btn-start {
				background: #4fc3f7;
				color: #0a0a14;
				position: relative;
				overflow: hidden;
			}
			/* Sweeping highlight overlay — only animates while the button is
			   actually clickable (session not running, queue non-empty), so
			   a disabled Start button doesn't shimmer as if it were live. */
			#dgca-ext-btn-start:not(:disabled)::after {
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
			#dgca-ext-btn-abort { background: #ef5350; color: #fff; }
			.dgca-ext-divider {
				height: 1px;
				background: #24243a;
				margin: 2px 0;
			}
			.dgca-ext-columns {
				display: flex;
				gap: 14px;
				align-items: stretch;
			}
			.dgca-ext-col-left {
				flex: 0 0 30%;
				min-width: 0;
				display: flex;
				flex-direction: column;
				gap: 8px;
			}
			.dgca-ext-col-right {
				flex: 1;
				min-width: 0;
				display: flex;
				flex-direction: column;
				gap: 6px;
				border-left: 1px solid #24243a;
				padding-left: 14px;
			}
			.dgca-ext-col-right-label {
				display: inline-block;
				align-self: flex-start;
				font-size: 10px;
				font-weight: 700;
				letter-spacing: 0.5px;
				text-transform: uppercase;
				/* color intentionally omitted — this element also carries
				   dgca-ext-shimmer-text(--queue), which owns the color via a
				   clipped gradient; a plain color here would win the cascade
				   (declared later, same specificity) and silently kill the
				   shimmer clip. Its text is reset via .textContent whenever
				   the queue count/name changes (see updateToolbarUiState),
				   which doesn't recreate the element, so the shimmer
				   animation keeps running uninterrupted across updates.
				   Note: background-color, not the background shorthand —
				   the shorthand resets background-image (the shimmer
				   gradient) to none for anything it doesn't mention, and
				   since this rule is declared after .dgca-ext-shimmer-text
				   it would win that tie and wipe the gradient out, leaving
				   fully transparent text with nothing behind it. */
				background-color: rgba(79, 195, 247, 0.12);
				border: 1px solid rgba(79, 195, 247, 0.3);
				border-radius: 4px;
				padding: 3px 8px;
			}
			.dgca-ext-shimmer-text--queue {
				--dgca-shimmer-base: #4fc3f7;
				--dgca-shimmer-hi: #ffffff;
				animation-duration: 6.5s;
			}
			.dgca-ext-progress-row {
				display: flex;
				flex-direction: column;
				align-items: stretch;
				gap: 4px;
			}
			.dgca-ext-progress-row .dgca-ext-toolbar-row {
				justify-content: space-between;
			}
			.dgca-ext-progress-text {
				color: #4fc3f7;
				font-weight: 600;
				font-size: 12px;
			}
			.dgca-ext-progress-track {
				height: 5px;
				background: #2a2a3e;
				border-radius: 3px;
				overflow: hidden;
				display: flex;
			}
			.dgca-ext-progress-fill {
				height: 100%;
				width: 0%;
				position: relative;
				overflow: hidden;
				transition: width 0.3s ease;
			}
			.dgca-ext-progress-fill--success {
				background: #4caf50;
			}
			.dgca-ext-progress-fill--error {
				background: #ef5350;
			}
			/* Slow shimmer sweep over the filled portion of the bar while a
			   session is actively running — toggled via the --active modifier
			   class in JS (updateToolbarProgressBar), not shown on a
			   completed/idle bar. */
			.dgca-ext-progress-fill--active::after {
				content: '';
				position: absolute;
				top: 0;
				left: 0;
				height: 100%;
				width: 40%;
				background: linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.45) 50%, rgba(255, 255, 255, 0) 100%);
				animation: dgca-ext-shimmer-bar 3.2s ease-in-out infinite;
			}
			@keyframes dgca-ext-shimmer-bar {
				0% { transform: translateX(-100%); }
				100% { transform: translateX(350%); }
			}
			.dgca-ext-error-pill {
				background: #3d1515;
				color: #ef5350;
				cursor: pointer;
				display: block;
				white-space: normal;
				padding: 6px 10px;
				font-size: 11px;
				text-align: left;
				border: 1px solid #5a1b1b;
				border-radius: 6px;
				font-weight: 600;
				position: relative;
				overflow: hidden;
				transition: filter 0.15s;
			}
			.dgca-ext-error-pill:hover {
				filter: brightness(1.2);
			}
			/* Always-on shimmer — unlike the "Filling"/progress/Start-button
			   sweeps above, this one isn't conditional on a session being
			   active: an error pill is meant to keep drawing the eye until
			   the user deals with it, whether or not anything is currently
			   running. */
			.dgca-ext-error-pill::after {
				content: '';
				position: absolute;
				top: 0;
				left: 0;
				height: 100%;
				width: 40%;
				background: linear-gradient(90deg, rgba(239, 83, 80, 0) 0%, rgba(239, 83, 80, 0.35) 50%, rgba(239, 83, 80, 0) 100%);
				animation: dgca-ext-shimmer-bar 3.2s ease-in-out infinite;
				pointer-events: none;
			}
			.dgca-ext-wso-row {
				gap: 16px;
				color: #b5b5c5;
			}
			.dgca-ext-wso-option {
				display: flex;
				align-items: center;
				gap: 6px;
				cursor: pointer;
			}
			.dgca-ext-wso-option input[type="radio"] {
				cursor: pointer;
				accent-color: #4fc3f7;
			}
			.dgca-ext-wso-option strong {
				color: #e0e0e0;
			}
			.dgca-ext-wso-option input[type="radio"]:disabled,
			.dgca-ext-wso-custom-text:disabled {
				cursor: not-allowed;
				opacity: 0.5;
			}
			.dgca-ext-wso-custom-text {
				background: #0f0f1a;
				border: 1px solid #4a4a6e;
				border-radius: 4px;
				color: #e0e0e0;
				font-size: 12px;
				padding: 3px 8px;
				width: 84px;
			}
			.dgca-ext-wso-custom-text:focus {
				outline: none;
				border-color: #4fc3f7;
			}
			.dgca-ext-ats-id-info {
				color: #b5b5c5;
			}
			.dgca-ext-ats-id-info strong {
				color: #4fc3f7;
				background: rgba(79, 195, 247, 0.12);
				padding: 2px 8px;
				border-radius: 4px;
				border: 1px solid rgba(79, 195, 247, 0.25);
			}
			.dgca-ext-btn-clear {
				background: #23233a;
				border: 1px solid #4a4a6e;
				color: #cfd3e0;
			}
			.dgca-ext-btn-clear:not(:disabled):hover {
				background: #2c2c48;
				border-color: #6a6a9e;
				color: #fff;
			}
			.dgca-ext-btn-clear-done {
				background: #17281c;
				border: 1px solid #2e6b3e;
				color: #6fcf82;
			}
			.dgca-ext-btn-clear-done:not(:disabled):hover {
				background: #1c3322;
				border-color: #3e8c53;
				color: #8ee6a0;
			}
			.dgca-ext-row-list {
				display: flex;
				flex-direction: column;
				gap: 7px;
				max-height: 180px;
				overflow-y: auto;
				margin-top: 4px;
			}
			.dgca-ext-row-item {
				display: flex;
				flex-direction: column;
				gap: 4px;
				background: #1a1a2e;
				border: 1px solid #2a2a3e;
				border-radius: 5px;
				padding: 3px 7px;
				cursor: pointer;
				/* Without this, flexbox treats every card as shrinkable
				   (the default), and once total content (e.g. after
				   expanding one card's detail box) exceeds the row-list's
				   max-height, it squeezes OTHER cards shorter to try to
				   still fit everything — instead of leaving them alone and
				   letting overflow-y: auto do its job. That's what showed
				   up as the filling row losing height the moment a
				   different row was expanded above it. */
				flex-shrink: 0;
			}
			.dgca-ext-row-item:hover {
				border-color: #3a3a5e;
			}
			.dgca-ext-row-item--expanded {
				border-color: #4a4a6e;
			}
			/* Applied to whichever row card is currently 'filling' — a soft
			   blue glow sweep so the active row is obvious at a glance in a
			   long queue list, independent of the "Filling" pill shimmer. */
			.dgca-ext-row-item--active {
				position: relative;
				overflow: hidden;
				border-color: #2f6fa3;
			}
			.dgca-ext-row-item--active::after {
				content: '';
				position: absolute;
				top: 0;
				left: 0;
				height: 100%;
				width: 35%;
				background: linear-gradient(90deg, rgba(79, 195, 247, 0) 0%, rgba(79, 195, 247, 0.18) 50%, rgba(79, 195, 247, 0) 100%);
				animation: dgca-ext-shimmer-bar 3.2s ease-in-out infinite;
				pointer-events: none;
			}
			.dgca-ext-row-item__main {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 4px;
			}
			.dgca-ext-row-item__detail {
				padding: 6px 8px;
				background: #0f0f1a;
				border: 1px solid #2a2a3e;
				border-radius: 4px;
				color: #b5b5c5;
				font-size: 10px;
				font-family: 'SF Mono', 'Consolas', monospace;
				white-space: pre-wrap;
				word-break: break-word;
				cursor: default;
			}
			.dgca-ext-row-item__detail--error {
				border-color: #3d1515;
				color: #ef5350;
			}
			.dgca-ext-row-item__detail--submitted {
				border-color: #2e6b3e;
				color: #6fcf82;
			}
			.dgca-ext-row-item__detail--filling {
				border-color: #1a3550;
				color: #4fc3f7;
			}
			.dgca-ext-row-item__info {
				display: flex;
				gap: 5px;
				align-items: center;
				flex: 1;
				min-width: 0;
				overflow: hidden;
				flex-wrap: wrap;
			}
			.dgca-ext-row-item__num {
				font-size: 10px;
				color: #7a7a95;
				min-width: 14px;
			}
			.dgca-ext-row-item__date {
				font-size: 11px;
				color: #4fc3f7;
			}
			.dgca-ext-row-item__time {
				font-size: 10px;
				color: #aab0c0;
				font-family: 'SF Mono', 'Consolas', monospace;
			}
			/* "Time to add" debugging/perf badge — separate class from
			   __time above (which shows the row's own from/to time range) so
			   the two aren't confused; distinct amber color for scannability.
			   The <10s/>=10s threshold is evaluated once in JS when the
			   timing value first arrives (buildRowItemHtml/patchRowItem),
			   not on every frame or repeatedly — it just picks a modifier
			   class alongside the text, so this adds no ongoing CSS/JS cost
			   beyond what the badge already did. */
			.dgca-ext-row-item__duration {
				font-size: 10px;
				color: #ffa726;
				font-family: 'SF Mono', 'Consolas', monospace;
			}
			.dgca-ext-row-item__duration--fast {
				color: #66bb6a;
			}
			.dgca-ext-row-item__delete {
				background: none;
				border: none;
				color: #ef5350;
				cursor: pointer;
				font-size: 14px;
				padding: 0 3px;
				opacity: 0.4;
				flex-shrink: 0;
			}
			.dgca-ext-row-item__delete:hover {
				opacity: 1;
			}
			.dgca-ext-pill {
				font-size: 9px;
				font-weight: 700;
				padding: 1px 6px;
				border-radius: 999px;
				white-space: nowrap;
				flex-shrink: 0;
			}
			.dgca-ext-pill--pending { background: #2a2a3e; color: #9a9ab0; }
			.dgca-ext-pill--filling {
				background: #1a3550;
				color: #4fc3f7;
				position: relative;
				overflow: hidden;
			}
			/* Sweep on the "Filling" pill itself — a second shimmer cue
			   alongside the row-card glow above, same speed as every other
			   shimmer in the toolbar now (dgca-ext-shimmer-bar's shared
			   3.2s duration) for a consistent, calmer feel. */
			.dgca-ext-pill--filling::after {
				content: '';
				position: absolute;
				top: 0;
				left: 0;
				height: 100%;
				width: 60%;
				background: linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.55) 50%, rgba(255, 255, 255, 0) 100%);
				animation: dgca-ext-shimmer-bar 3.2s ease-in-out infinite;
				pointer-events: none;
			}
			.dgca-ext-pill--submitted { background: #1a3320; color: #4caf50; }
			/* Error pill: unlike --filling above (only shimmers while a
			   session is actively running), this one shimmers unconditionally
			   — an error should keep drawing the eye until the user clears it,
			   whether or not a session is currently in progress. */
			.dgca-ext-pill--error {
				background: #3d1515;
				color: #ef5350;
				position: relative;
				overflow: hidden;
			}
			.dgca-ext-pill--error::after {
				content: '';
				position: absolute;
				top: 0;
				left: 0;
				height: 100%;
				width: 60%;
				background: linear-gradient(90deg, rgba(239, 83, 80, 0) 0%, rgba(239, 83, 80, 0.45) 50%, rgba(239, 83, 80, 0) 100%);
				animation: dgca-ext-shimmer-bar 3.2s ease-in-out infinite;
				pointer-events: none;
			}
			.dgca-ext-pill--skipped { background: #2e2e3e; color: #9a9ab0; }
			.dgca-ext-footer {
				text-align: center;
				font-size: 10px;
				color: #6a6a8a;
				padding-top: 5px;
				margin-top: 1px;
				border-top: 1px solid #24243a;
			}
			.dgca-ext-footer strong {
				font-weight: 600;
			}
			.dgca-ext-footer-version {
				margin-left: 4px;
			}
		`;
		document.head.appendChild(style);
	}

	function buildToolbar(heading) {
		const existing = heading.querySelector('#dgca-ext-toolbar');
		if (existing) return existing;

		injectToolbarStyle();

		const toolbar = document.createElement('div');
		toolbar.id = 'dgca-ext-toolbar';
		toolbar.className = 'dgca-ext-toolbar';
		toolbar.innerHTML = `
			<div class="dgca-ext-toolbar-label">
				<span>✈ <span class="dgca-ext-shimmer-text dgca-ext-shimmer-text--title">DGCA eLogBook Automator</span></span>
				<a class="dgca-ext-video-guide" href="https://youtu.be/xppOqtbQIps" target="_blank" rel="noopener noreferrer">▶ Video Guide</a>
			</div>
			<div class="dgca-ext-divider"></div>
			<div class="dgca-ext-columns">
				<div class="dgca-ext-col-left">
					<div class="dgca-ext-toolbar-row">
						<button id="dgca-ext-btn-start" type="button">▶ Start Filling</button>
						<button id="dgca-ext-btn-abort" type="button" style="display:none;">■ Abort</button>
						<button id="dgca-ext-btn-clear-done" type="button" class="dgca-ext-btn-clear-done">✓ Clear Done</button>
						<button id="dgca-ext-btn-clear-all" type="button" class="dgca-ext-btn-clear">🗑 Clear All</button>
					</div>
					<div id="dgca-ext-error-pill" class="dgca-ext-error-pill" style="display:none;" title="Click for full error details"></div>
					<div class="dgca-ext-toolbar-row dgca-ext-wso-row" id="dgca-ext-wso-row">
						<label class="dgca-ext-wso-option">
							<input type="radio" name="dgca-ext-wso-ats-mode" id="dgca-ext-wso-ats-mode-ats" value="ats">
							<strong>ATS</strong>
						</label>
						<label class="dgca-ext-wso-option">
							<input type="radio" name="dgca-ext-wso-ats-mode" id="dgca-ext-wso-ats-mode-custom" value="custom">
							<input type="text" id="dgca-ext-wso-custom-text" class="dgca-ext-wso-custom-text" value="WSO">
						</label>
					</div>
					<div class="dgca-ext-toolbar-row dgca-ext-ats-id-info" id="dgca-ext-ats-id-info" style="display:none;">
						<span>EGCA-Id: <strong id="dgca-ext-ats-id-value"></strong></span>
					</div>
					<div class="dgca-ext-progress-row" id="dgca-ext-progress-row" style="display:none;">
						<div class="dgca-ext-toolbar-row">
							<span id="dgca-ext-progress-text" class="dgca-ext-progress-text"></span>
						</div>
						<div class="dgca-ext-progress-track" id="dgca-ext-progress-track">
							<div id="dgca-ext-progress-fill-success" class="dgca-ext-progress-fill dgca-ext-progress-fill--success"></div>
							<div id="dgca-ext-progress-fill-error" class="dgca-ext-progress-fill dgca-ext-progress-fill--error"></div>
						</div>
					</div>
					<div class="dgca-ext-footer">
						Made with ❤️ by <strong class="dgca-ext-shimmer-text dgca-ext-shimmer-text--footer">Gaurav Chetiwal</strong> © 2026
						<span class="dgca-ext-footer-version">v<span id="dgca-ext-app-version">…</span></span>
					</div>
				</div>
				<div class="dgca-ext-col-right">
					<div class="dgca-ext-col-right-label dgca-ext-shimmer-text dgca-ext-shimmer-text--queue" id="dgca-ext-col-right-label">Queue</div>
					<div class="dgca-ext-row-list" id="dgca-ext-row-list"></div>
				</div>
			</div>
		`;
		heading.appendChild(toolbar);

		const btnStart = toolbar.querySelector('#dgca-ext-btn-start');
		const btnAbort = toolbar.querySelector('#dgca-ext-btn-abort');
		const btnClearDone = toolbar.querySelector('#dgca-ext-btn-clear-done');
		const btnClearAll = toolbar.querySelector('#dgca-ext-btn-clear-all');
		const wsoAtsModeAts = toolbar.querySelector('#dgca-ext-wso-ats-mode-ats');
		const wsoAtsModeCustom = toolbar.querySelector('#dgca-ext-wso-ats-mode-custom');
		const wsoCustomText = toolbar.querySelector('#dgca-ext-wso-custom-text');
		const wsoRow = toolbar.querySelector('#dgca-ext-wso-row');
		const atsIdInfo = toolbar.querySelector('#dgca-ext-ats-id-info');
		const atsIdValue = toolbar.querySelector('#dgca-ext-ats-id-value');
		const rowList = toolbar.querySelector('#dgca-ext-row-list');
		const progressRow = toolbar.querySelector('#dgca-ext-progress-row');
		const progressText = toolbar.querySelector('#dgca-ext-progress-text');
		const progressFillSuccess = toolbar.querySelector('#dgca-ext-progress-fill-success');
		const progressFillError = toolbar.querySelector('#dgca-ext-progress-fill-error');
		const errorPill = toolbar.querySelector('#dgca-ext-error-pill');
		const colRightLabel = toolbar.querySelector('#dgca-ext-col-right-label');
		const appVersionEl = toolbar.querySelector('#dgca-ext-app-version');

		try {
			appVersionEl.textContent = chrome.runtime.getManifest().version;
		} catch (_) { }

		btnClearAll.addEventListener('click', () => {
			if (_sessionRunning) return;
			if (!confirm('Clear the entire queue?')) return;
			window.DGCA_STORAGE.remove([
				'dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_row_timings',
				'dgca_session_ts', 'dgca_queue_user',
			]).then(() => { _expandedRows.clear(); refreshToolbar(); }).catch(() => { });
		});

		// Drops only the rows that finished 'submitted', keeping
		// pending/error/filling ones in place.
		btnClearDone.addEventListener('click', async () => {
			if (_sessionRunning) { alert('Cannot clear while session is running.'); return; }
			let data;
			try {
				data = await window.DGCA_STORAGE.get(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_row_timings']);
			} catch (_) { return; }

			const rows = data?.dgca_pending_rows || [];
			const statuses = data?.dgca_row_status || [];
			const errors = data?.dgca_row_errors || {};
			const timings = data?.dgca_row_timings || {};
			const keepIndices = rows.map((_, i) => i).filter(i => statuses[i] !== 'submitted');
			if (keepIndices.length === rows.length) return;

			const newErrors = {};
			const newTimings = {};
			keepIndices.forEach((oldIdx, newIdx) => {
				if (errors[oldIdx]) newErrors[newIdx] = errors[oldIdx];
				if (timings[oldIdx] != null) newTimings[newIdx] = timings[oldIdx];
			});
			const newRows = keepIndices.map(i => rows[i]);
			const newStatuses = keepIndices.map(i => statuses[i]);
			const newExpanded = new Set();
			keepIndices.forEach((oldIdx, newIdx) => { if (_expandedRows.has(oldIdx)) newExpanded.add(newIdx); });
			_expandedRows = newExpanded;

			try {
				await window.DGCA_STORAGE.set({
					dgca_pending_rows: newRows, dgca_row_status: newStatuses,
					dgca_row_errors: newErrors, dgca_row_timings: newTimings,
				});
				if (newRows.length === 0) await window.DGCA_STORAGE.remove(['dgca_queue_user']).catch(() => { });
				refreshToolbar();
			} catch (_) { }
		});

		rowList.addEventListener('click', (e) => {
			const delBtn = e.target.closest('[data-dgca-delete-idx]');
			if (delBtn) { deleteToolbarRow(parseInt(delBtn.dataset.dgcaDeleteIdx, 10)); return; }
			const item = e.target.closest('.dgca-ext-row-item');
			if (item) { toggleToolbarRowExpand(parseInt(item.dataset.dgcaRowIdx, 10)); return; }
		});

		btnStart.addEventListener('click', () => {
			if (_sessionRunning || btnStart.disabled) return;
			startSession();
		});

		btnAbort.addEventListener('click', () => {
			if (!confirm('Abort the current session?')) return;
			abortSession();
		});

		function persistWsoAtsMode() {
			window.DGCA_STORAGE.set({
				dgca_wso_ats_mode: wsoAtsModeAts.checked ? 'ats' : 'custom',
				dgca_wso_custom_text: wsoCustomText.value,
			}).catch(() => { });
		}

		[wsoAtsModeAts, wsoAtsModeCustom].forEach(radio => {
			radio.addEventListener('change', () => {
				wsoCustomText.disabled = wsoAtsModeAts.checked || _sessionRunning;
				persistWsoAtsMode();
			});
		});

		wsoCustomText.addEventListener('input', persistWsoAtsMode);
		wsoCustomText.addEventListener('focus', () => {
			if (!wsoAtsModeCustom.checked) wsoAtsModeCustom.click();
		});

		_toolbarEls = {
			btnStart, btnAbort, btnClearDone, btnClearAll, wsoAtsModeAts, wsoAtsModeCustom, wsoCustomText,
			wsoRow, atsIdInfo, atsIdValue, rowList, progressRow, progressText,
			progressFillSuccess, progressFillError, errorPill, colRightLabel,
		};
		return toolbar;
	}

	// Reads the logged-in user's display name off the DGCA page's own header,
	// e.g.:
	//   <p id="viewRoleDiv" class="...">
	//     <span>Gaurav Chetiwal</span>
	//     <span class="sub-text">IATCN2023000468</span>
	//     <span class="sub-text"><a onclick="fnViewAllRole();">(View Role)</a></span>
	//   </p>
	// The name is the one plain (non ".sub-text") span; license number and
	// the "(View Role)" link both carry .sub-text and are skipped. Read
	// live on every call rather than cached, since it's cheap and this can
	// be evaluated before the portal has finished populating the header.
	function getDgcaPageUserName() {
		const el = document.querySelector('#viewRoleDiv span:not(.sub-text)');
		return el ? el.textContent.trim() : '';
	}

	// ── Progress / session-error display ──────────────────────────────────
	// Single line now — success/error counts are always folded into `text`
	// itself (e.g. "Row 3 / 10 — filling — 1 success · 0 error") instead of
	// living in a separate dedicated stats span next to it.
	function showToolbarProgress(text) {
		if (!_toolbarEls?.progressRow) return;
		_toolbarEls.progressRow.style.display = 'flex';
		_toolbarEls.progressText.textContent = text;
	}

	function hideToolbarProgress() {
		if (!_toolbarEls?.progressRow) return;
		_toolbarEls.progressRow.style.display = 'none';
	}

	// Segmented bar: green portion = submitted so far, red portion = errors so
	// far, both as a share of the total queued rows. Shimmer only plays while
	// a session is actually running — a completed/idle bar stays still.
	function updateToolbarProgressBar(done, errCnt, total) {
		if (!_toolbarEls?.progressFillSuccess) return;
		const safeTotal = total > 0 ? total : 1;
		_toolbarEls.progressFillSuccess.style.width = `${(done / safeTotal) * 100}%`;
		_toolbarEls.progressFillError.style.width = `${(errCnt / safeTotal) * 100}%`;
		_toolbarEls.progressFillSuccess.classList.toggle('dgca-ext-progress-fill--active', _sessionRunning);
		_toolbarEls.progressFillError.classList.toggle('dgca-ext-progress-fill--active', _sessionRunning);
	}

	function showToolbarError(msg) {
		if (!_toolbarEls?.errorPill) return;
		const { errorPill } = _toolbarEls;
		errorPill.textContent = `✗ ${msg}`;
		errorPill.style.display = 'block';
		errorPill.onclick = () => alert(msg);
	}

	function hideToolbarError() {
		if (!_toolbarEls?.errorPill) return;
		_toolbarEls.errorPill.style.display = 'none';
		_toolbarEls.errorPill.onclick = null;
	}

	// ── Row delete (via the storage bridge) ──────────────────────────────────
	async function deleteToolbarRow(index) {
		if (_sessionRunning) { alert('Cannot remove rows while session is running.'); return; }
		let data;
		try {
			data = await window.DGCA_STORAGE.get(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_row_timings']);
		} catch (_) { return; }

		const rows = data?.dgca_pending_rows || [];
		const statuses = data?.dgca_row_status || [];
		const errors = data?.dgca_row_errors || {};
		const timings = data?.dgca_row_timings || {};
		if (index < 0 || index >= rows.length) return;

		if (!confirm(`Remove row ${index + 1} (${rows[index]?.date || ''}) from queue?`)) return;

		rows.splice(index, 1);
		statuses.splice(index, 1);
		const newErrors = {};
		const newTimings = {};
		Object.keys(errors).forEach(k => {
			const ki = parseInt(k, 10);
			if (ki < index) newErrors[ki] = errors[ki];
			else if (ki > index) newErrors[ki - 1] = errors[ki];
		});
		Object.keys(timings).forEach(k => {
			const ki = parseInt(k, 10);
			if (ki < index) newTimings[ki] = timings[ki];
			else if (ki > index) newTimings[ki - 1] = timings[ki];
		});
		const newExpanded = new Set();
		_expandedRows.forEach(ei => {
			if (ei < index) newExpanded.add(ei);
			else if (ei > index) newExpanded.add(ei - 1);
		});
		_expandedRows = newExpanded;

		try {
			await window.DGCA_STORAGE.set({
				dgca_pending_rows: rows, dgca_row_status: statuses,
				dgca_row_errors: newErrors, dgca_row_timings: newTimings,
			});
			if (rows.length === 0) {
				await window.DGCA_STORAGE.remove(['dgca_queue_user']).catch(() => { });
			}
			refreshToolbar();
		} catch (_) { }
	}

	// Row-status pill vocabulary — owned entirely by this toolbar, the sole
	// queue UI. ROW_STATUS itself comes from shared.js since the EGCA-export
	// injector also writes 'pending' when it queues rows, but the display
	// strings/classes below have exactly one consumer.
	const { ROW_STATUS } = window.DGCA;
	const PILL_CLASS = {
		[ROW_STATUS.PENDING]: 'dgca-ext-pill--pending',
		[ROW_STATUS.FILLING]: 'dgca-ext-pill--filling',
		[ROW_STATUS.SUBMITTED]: 'dgca-ext-pill--submitted',
		[ROW_STATUS.ERROR]: 'dgca-ext-pill--error',
		[ROW_STATUS.SKIPPED]: 'dgca-ext-pill--skipped',
	};
	const PILL_LABEL = {
		[ROW_STATUS.PENDING]: 'Pending',
		[ROW_STATUS.FILLING]: 'Filling…',
		[ROW_STATUS.SUBMITTED]: '✓ Added',
		[ROW_STATUS.ERROR]: '✗ Error',
		[ROW_STATUS.SKIPPED]: '— Skip',
	};
	// Text shown in the expanded detail box for non-error statuses. (Error
	// rows show the actual captured error message instead.)
	const DETAIL_TEXT = {
		[ROW_STATUS.PENDING]: 'Pending',
		[ROW_STATUS.FILLING]: 'In Progress',
		[ROW_STATUS.SUBMITTED]: 'Added Successfully',
		[ROW_STATUS.SKIPPED]: 'Skipped',
	};

	// Rows that were still pending/filling when the last session was
	// aborted read as "Stopped" instead of their normal label — reuses
	// _aborted (set in abortSession(), cleared at the top of runSession())
	// rather than a separate flag, since that's exactly the window we want.
	function displayPillClass(status) {
		if (_aborted && (status === ROW_STATUS.PENDING || status === ROW_STATUS.FILLING)) {
			return PILL_CLASS[ROW_STATUS.PENDING];
		}
		return PILL_CLASS[status] || PILL_CLASS[ROW_STATUS.PENDING];
	}
	function displayPillLabel(status) {
		if (_aborted && (status === ROW_STATUS.PENDING || status === ROW_STATUS.FILLING)) {
			return 'Stopped';
		}
		return PILL_LABEL[status] || PILL_LABEL[ROW_STATUS.PENDING];
	}


	let _lastRenderedRows = [];
	let _lastRenderedStatuses = [];
	let _lastRenderedErrors = {};
	let _lastRenderedTimings = {};

	// Card markup: date/time/ATS/duty/instructor/trainee chips + status
	// pill. Every card is expandable — click anywhere on it (except the
	// delete button) to show a status detail line, with the full error text
	// for error rows.
	function buildRowItemHtml(row, i, status, error, timing, { showDelete, expanded }) {
		const raw = row.egcaRaw || {};
		const pillClass = displayPillClass(status);
		const pillLabel = displayPillLabel(status);

		const atsHtml = row.atsUnit
			? `<span class="dgca-ext-row-item__num" style="color:#4fc3f7;">${escHtml(`${raw.rating} - ${row.atsUnit}`)}</span>` : '';
		const dutyShort = raw.typeOfDuty ? raw.typeOfDuty.split('(')[0].trim() : '';
		const dutyHtml = dutyShort
			? `<span class="dgca-ext-row-item__num" title="${escHtml(raw.typeOfDuty || '')}">${escHtml(dutyShort)}</span>` : '';
		let instrHtml = '';
		if (raw.instructorLicense) {
			instrHtml = `<span class="dgca-ext-row-item__num" style="color:#ba68c8;font-style:italic;" title="Instructor">👤 ${escHtml(raw.instructorName)}</span>`;
		}
		let traineeHtml = '';
		if (raw.traineeLicense) {
			const label = raw.traineeName ? `${raw.traineeName} (${raw.traineeLicense})` : raw.traineeLicense;
			traineeHtml = `<span class="dgca-ext-row-item__num" style="color:#66bb6a;font-style:italic;" title="Trainee">🎓 ${escHtml(label)}</span>`;
		}

		// "Time to add" badge — debugging/perf monitoring. Hidden (empty,
		// display:none) until this row has actually been processed at least
		// once; updateToolbarRowStatus() patches it in place afterwards so
		// a full re-render isn't needed just to show the number.
		const hasTiming = timing != null;
		const durationClass = `dgca-ext-row-item__duration${hasTiming && timing < 10000 ? ' dgca-ext-row-item__duration--fast' : ''}`;
		const timeToAddHtml = `<span class="${durationClass}" id="dgca-ext-time-${i}"
			title="Time to fill + Add this row"${hasTiming ? '' : ' style="display:none;"'}>${hasTiming ? `⏱ ${escHtml(formatDuration(timing))}` : ''}</span>`;

		const pillHtml = `<span id="dgca-ext-pill-${i}" class="dgca-ext-pill ${pillClass}">${pillLabel}</span>`;

		const deleteHtml = showDelete
			? `<button type="button" class="dgca-ext-row-item__delete" data-dgca-delete-idx="${i}" title="Remove from queue">×</button>` : '';

		const detailText = status === 'error' ? (error || 'Unknown error') : (DETAIL_TEXT[status] || '');
		const detailHtml = expanded
			? `<div class="dgca-ext-row-item__detail dgca-ext-row-item__detail--${status}">${escHtml(detailText)}</div>`
			: '';
		const itemClass = `dgca-ext-row-item${expanded ? ' dgca-ext-row-item--expanded' : ''}${status === 'filling' ? ' dgca-ext-row-item--active' : ''}`;

		return `
			<div class="${itemClass}" id="dgca-ext-row-item-${i}" data-dgca-row-idx="${i}">
				<div class="dgca-ext-row-item__main">
					<div class="dgca-ext-row-item__info">
						<span class="dgca-ext-row-item__num">${i + 1}</span>
						<span class="dgca-ext-row-item__date">${escHtml(row.date || raw.fromDate || '')}</span>
						<span class="dgca-ext-row-item__time">${escHtml(row.timeFrom)}–${escHtml(row.timeTo)}</span>
						${atsHtml}${dutyHtml}${instrHtml}${traineeHtml}${timeToAddHtml}
					</div>
					${pillHtml}
					${deleteHtml}
				</div>
				${detailHtml}
			</div>
		`;
	}

	function renderToolbarRowList(rows, statuses, errors, timings) {
		if (!_toolbarEls) return;
		_lastRenderedRows = rows;
		_lastRenderedStatuses = statuses;
		_lastRenderedErrors = errors;
		_lastRenderedTimings = timings || {};

		const { rowList } = _toolbarEls;
		if (rows.length === 0) {
			rowList.innerHTML = '';
			return;
		}

		if (rowList.children.length === rows.length) {
			rows.forEach((row, i) => patchRowItem(i, statuses[i] || 'pending', errors[i], _lastRenderedTimings[i]));
			return;
		}

		rowList.innerHTML = rows.map((row, i) => buildRowItemHtml(row, i, statuses[i] || 'pending', errors[i], _lastRenderedTimings[i], {
			showDelete: !_sessionRunning,
			expanded: _expandedRows.has(i),
		})).join('');
	}

	function patchRowItem(i, status, error, timing) {
		const item = document.getElementById(`dgca-ext-row-item-${i}`);
		if (!item) return;

		const pill = document.getElementById(`dgca-ext-pill-${i}`);
		if (pill) {
			pill.className = `dgca-ext-pill ${displayPillClass(status)}`;
			pill.textContent = displayPillLabel(status);
		}

		item.classList.toggle('dgca-ext-row-item--active', status === 'filling');

		const showDelete = !_sessionRunning;
		const deleteBtn = item.querySelector('.dgca-ext-row-item__delete');
		if (showDelete && !deleteBtn) {
			const btn = document.createElement('button');
			btn.className = 'dgca-ext-row-item__delete';
			btn.dataset.dgcaDeleteIdx = String(i);
			btn.title = 'Remove from queue';
			btn.textContent = '×';
			item.querySelector('.dgca-ext-row-item__main')?.appendChild(btn);
		} else if (!showDelete && deleteBtn) {
			deleteBtn.remove();
		}

		if (_expandedRows.has(i)) {
			item.classList.add('dgca-ext-row-item--expanded');
			const detailText = status === 'error' ? (error || 'Unknown error') : (DETAIL_TEXT[status] || '');
			let detail = item.querySelector('.dgca-ext-row-item__detail');
			if (!detail) {
				detail = document.createElement('div');
				item.appendChild(detail);
			}
			detail.className = `dgca-ext-row-item__detail dgca-ext-row-item__detail--${status}`;
			detail.textContent = detailText;
		} else {
			item.classList.remove('dgca-ext-row-item--expanded');
			item.querySelector('.dgca-ext-row-item__detail')?.remove();
		}

		if (timing != null) {
			const timeEl = document.getElementById(`dgca-ext-time-${i}`);
			if (timeEl) {
				timeEl.textContent = `⏱ ${formatDuration(timing)}`;
				timeEl.classList.toggle('dgca-ext-row-item__duration--fast', timing < 10000);
				timeEl.style.display = '';
			}
		}
	}

	function toggleToolbarRowExpand(index) {
		if (_expandedRows.has(index)) _expandedRows.delete(index);
		else _expandedRows.add(index);

		const status = _lastRenderedStatuses[index] || 'pending';
		const error = _lastRenderedErrors[index];
		patchRowItem(index, status, error, _lastRenderedTimings[index]);
	}


	function updateToolbarRowStatus(index, status, error, elapsedMs) {
		if (!_toolbarEls) return;
		_lastRenderedStatuses[index] = status;
		if (error) _lastRenderedErrors[index] = error;
		else delete _lastRenderedErrors[index];
		if (elapsedMs != null) _lastRenderedTimings[index] = elapsedMs;

		patchRowItem(index, status, error, elapsedMs);

		if (status === 'filling') {
			scrollRowListToItem(index);
		}
	}

	// Scrolls only the toolbar's own row-list container to bring the given
	// row into view — never the page/window. scrollIntoView({block:'nearest'})
	// looks tempting here, but it walks every scrollable ancestor including
	// the page itself, so if the user had scrolled away to check something
	// else, a newly-filling row would yank the whole page back to the
	// toolbar. Comparing bounding rects and adjusting rowList.scrollTop
	// directly keeps the scroll change contained to the queue list.
	function scrollRowListToItem(index) {
		const { rowList } = _toolbarEls || {};
		const itemEl = document.getElementById(`dgca-ext-row-item-${index}`);
		if (!rowList || !itemEl) return;

		const itemRect = itemEl.getBoundingClientRect();
		const listRect = rowList.getBoundingClientRect();

		if (itemRect.top < listRect.top) {
			rowList.scrollTop -= (listRect.top - itemRect.top);
		} else if (itemRect.bottom > listRect.bottom) {
			rowList.scrollTop += (itemRect.bottom - listRect.bottom);
		}
	}

	let _refreshSeq = 0;

	async function refreshToolbar() {
		if (!_toolbarEls) return;
		const mySeq = ++_refreshSeq;
		const {
			btnStart, btnAbort, btnClearDone, btnClearAll, wsoAtsModeAts, wsoAtsModeCustom, wsoCustomText,
			wsoRow, atsIdInfo, atsIdValue, colRightLabel,
		} = _toolbarEls;

		let rows = [], statuses = [], errors = {}, timings = {}, queueUser = null, wsoAtsMode = 'custom', wsoCustom = 'WSO';
		try {
			const data = await window.DGCA_STORAGE.get([
				'dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_row_timings', 'dgca_queue_user',
				'dgca_wso_ats_mode', 'dgca_wso_custom_text',
			]);
			rows = data?.dgca_pending_rows || [];
			statuses = data?.dgca_row_status || [];
			errors = data?.dgca_row_errors || {};
			timings = data?.dgca_row_timings || {};
			queueUser = data?.dgca_queue_user || null;
			wsoAtsMode = data?.dgca_wso_ats_mode || 'custom';
			wsoCustom = data?.dgca_wso_custom_text || 'WSO';
		} catch (_) { }

		if (mySeq !== _refreshSeq || !_toolbarEls) return;

		const total = rows.length;
		const done = statuses.filter(s => s === 'submitted').length;

		// Right column header: "Queue - <name> (IAMATC) - <name> (EGCA) - <n> rows"
		// The IAMATC name is whoever built the queue on the AAI EGCA-export
		// page (dgca_queue_user, set by injector-egcaexport.js); the EGCA
		// name is whoever is logged into *this* DGCA page right now, read
		// live from its own header markup — see getDgcaPageUserName().
		if (colRightLabel) {
			const iamatcWho = queueUser && (queueUser.name || queueUser.loginId);
			const egcaWho = getDgcaPageUserName();
			const rowsSuffix = `${total} row${total === 1 ? '' : 's'}`;
			const parts = ['Queue'];
			if (iamatcWho) parts.push(`${iamatcWho} (IAMATC)`);
			if (egcaWho) parts.push(`${egcaWho} (EGCA)`);
			parts.push(rowsSuffix);
			colRightLabel.textContent = parts.join(' - ');
		}

		if (total === 0) {
			hideToolbarProgress();
			hideToolbarError();
		}

		btnClearDone.disabled = _sessionRunning || !statuses.some(s => s === 'submitted');

		btnStart.disabled = total === 0 || _sessionRunning;
		btnStart.style.display = _sessionRunning ? 'none' : 'inline-block';
		btnAbort.style.display = _sessionRunning ? 'inline-block' : 'none';

		// If every queued row already carries its own EGCA-Id, show that
		// instead of the WSO/ATS toggle — the
		// portal will match by exact text for all of them regardless.
		const allHaveAtsId = total > 0 && rows.every(r => !!((r.egcaRaw || {}).atsEgcaId));
		if (allHaveAtsId) {
			wsoRow.style.display = 'none';
			atsIdValue.textContent = rows[0].egcaRaw.atsEgcaId;
			atsIdInfo.style.display = 'flex';
		} else {
			wsoRow.style.display = 'flex';
			atsIdInfo.style.display = 'none';

			// Don't stomp on a field the user is actively typing in.
			const useAts = wsoAtsMode === 'ats';
			if (document.activeElement !== wsoCustomText) wsoCustomText.value = wsoCustom;
			wsoAtsModeAts.checked = useAts;
			wsoAtsModeCustom.checked = !useAts;

			wsoAtsModeAts.disabled = _sessionRunning;
			wsoAtsModeCustom.disabled = _sessionRunning;
			wsoCustomText.disabled = _sessionRunning || useAts;
		}

		btnClearAll.disabled = total === 0 || _sessionRunning;

		// ── Row list — same card layout whether idle, running, or showing
		// results; rows never disappear, only their pill updates.
		renderToolbarRowList(rows, statuses, errors, timings);
	}

	// Holds the last-found Logbook panel heading so repeat calls (fired by
	// unrelated DOM churn elsewhere in #contWrapper, e.g. DataTables redraws)
	// can skip the document-wide `querySelectorAll('h5.panel-title')` scan
	// entirely when the heading we already have is still attached.
	let _cachedHeading = null;

	function setupInlineToolbar() {
		if (!isOnEntryPage()) {
			document.getElementById('dgca-ext-toolbar')?.remove();
			_toolbarEls = null;
			_cachedHeading = null;
			return false;
		}
		if (_cachedHeading && _cachedHeading.isConnected) {
			if (!_cachedHeading.querySelector('#dgca-ext-toolbar')) {
				buildToolbar(_cachedHeading);
				refreshToolbar();
			}
			return true;
		}
		const heading = findLogbookHeading();
		if (!heading) {
			_cachedHeading = null;
			return false;
		}
		_cachedHeading = heading;
		const alreadyPresent = !!heading.querySelector('#dgca-ext-toolbar');
		buildToolbar(heading);
		if (!alreadyPresent) refreshToolbar();
		return true;
	}

	setupInlineToolbar();
	let _observerScheduled = false;

	// Narrow the observed root: #contWrapper holds the breadcrumb + the whole
	// panel stack (Basic/Medical/Rating/.../Logbook). It excludes the sidebar
	// menu tree, which is static and never contains the Logbook heading, so
	// mutations there are never worth a rescan.
	const _observeRoot = document.getElementById('contWrapper') || document.body;

	// Cheap pre-check run on every raw MutationRecord batch, before scheduling
	// any work. DataTables (search/paging/redraw) and other widgets inside
	// #contWrapper churn the DOM independently of navigation; most of those
	// bursts can't possibly affect the Logbook panel or the toolbar, so we
	// skip straight past them instead of paying for a full setupInlineToolbar()
	// pass on every one.
	function _mutationsLookRelevant(mutations) {
		// If we've already found the heading but it's since been detached
		// (e.g. the panel stack got replaced wholesale on navigation), that's
		// always worth a rescan regardless of what the mutation records say.
		if (_cachedHeading && !_cachedHeading.isConnected) return true;

		for (const m of mutations) {
			for (const n of m.addedNodes) {
				if (n.nodeType !== 1) continue;
				if (n.id === 'dgca-ext-toolbar') return true;
				if (typeof n.matches === 'function' && n.matches('.panel-heading, h5.panel-title')) return true;
				if (typeof n.querySelector === 'function' && n.querySelector('h5.panel-title, #dgca-ext-toolbar')) return true;
			}
		}
		return false;
	}

	const _toolbarObserver = new MutationObserver((mutations) => {
		if (_observerScheduled) return;
		if (!_mutationsLookRelevant(mutations)) return;
		_observerScheduled = true;
		const raf = window.requestAnimationFrame
			? (cb) => window.requestAnimationFrame(cb)
			: (cb) => setTimeout(cb, 16);
		raf(() => {
			_observerScheduled = false;
			setupInlineToolbar();
		});
	});
	_toolbarObserver.observe(_observeRoot, { childList: true, subtree: true });

	// Keeps the toolbar in sync with queue changes made elsewhere: the
	// popup's Clear All, or the EGCA-export injector adding rows or clearing
	// the queue from its own page.
	window.DGCA_STORAGE.onChanged((changes) => {
		if (changes.dgca_pending_rows || changes.dgca_queue_user || (changes.dgca_row_status && !_sessionRunning)) {
			refreshToolbar();
		}
	});

	async function runSession(rows) {
		_sessionRunning = true;
		notifySessionState(true);
		_aborted = false;
		_expandedRows.clear();
		hideToolbarError();

		// Reset every row to 'pending' and clear stale errors/timings from
		// a previous session, and AWAIT that write, before the first
		// refreshToolbar() call below. refreshToolbar() reads status fresh
		// from storage each time it's called — call it before this write
		// lands and it's a race: it can (and, per report, often does) read
		// back last session's still-present 'submitted'/'error' statuses,
		// leaving stale pills showing for every row not yet reached by the
		// loop further down.
		const statuses = rows.map(() => 'pending');
		const errors = {};
		const timings = {};
		await window.DGCA_STORAGE.set({
			dgca_row_status: statuses,
			dgca_row_errors: errors,
			dgca_row_timings: timings,
		});

		showToolbarProgress('Starting…');
		updateToolbarProgressBar(0, 0, rows.length);
		refreshToolbar();

		// The toolbar's own DOM churn during a fill (resetFields, field
		// updates, row-status pills) all happens under #contWrapper and would
		// otherwise get picked up by _toolbarObserver on every row. Nothing
		// during a session needs the observer — all toolbar updates here go
		// through direct refreshToolbar()/updateToolbarRowStatus() calls, not
		// observer-triggered rescans — so disconnect for the duration.
		_toolbarObserver.disconnect();

		try {
			const _wsoAtsData = await window.DGCA_STORAGE.get(['dgca_wso_ats_mode', 'dgca_wso_custom_text']).catch(() => ({}));
			const wsoAtsText = (_wsoAtsData?.dgca_wso_ats_mode === 'ats')
				? 'ATS'
				: (_wsoAtsData?.dgca_wso_custom_text || 'WSO');

			for (let i = 0; i < rows.length; i++) {
				if (_aborted) break;

				const row = rows[i];
				statuses[i] = 'filling';
				await window.DGCA_STORAGE.set({ dgca_row_status: [...statuses] });
				updateToolbarRowStatus(i, 'filling');
				const doneBefore = statuses.filter(s => s === 'submitted').length;
				const errBefore = statuses.filter(s => s === 'error').length;
				showToolbarProgress(`Row ${i + 1} / ${rows.length} — filling — ${doneBefore} success · ${errBefore} error`);
				updateToolbarProgressBar(doneBefore, errBefore, rows.length);

				// Timer starts right after the 'filling' status flip, so it
				// measures the same "in-flight" window the pill/glow shimmer is
				// shown for — reset through to clickAddAndVerify()'s resolve.
				// Used purely for debugging/perf monitoring (surfaced as the
				// ⏱ badge on each row card), not for any control-flow decision.
				const rowStartedAt = performance.now();

				try { await resetFields(); } catch (_) { }

				if (_aborted) break;

				try {
					await fillRow(row, wsoAtsText);
					if (_aborted) break;

					const result = await clickAddAndVerify();
					const elapsedMs = performance.now() - rowStartedAt;
					timings[i] = elapsedMs;

					if (result.ok) {
						statuses[i] = 'submitted';
						updateToolbarRowStatus(i, 'submitted', null, elapsedMs);
					} else {
						statuses[i] = 'error';
						errors[i] = result.error;
						updateToolbarRowStatus(i, 'error', result.error, elapsedMs);
					}
				} catch (err) {
					const elapsedMs = performance.now() - rowStartedAt;
					timings[i] = elapsedMs;
					statuses[i] = 'error';
					errors[i] = err.message;
					updateToolbarRowStatus(i, 'error', err.message, elapsedMs);
				}

				await window.DGCA_STORAGE.set({
					dgca_row_status: [...statuses],
					dgca_row_errors: { ...errors },
					dgca_row_timings: { ...timings },
				});

				const doneSoFar = statuses.filter(s => s === 'submitted').length;
				const errSoFar = statuses.filter(s => s === 'error').length;
				showToolbarProgress(`Row ${i + 1} / ${rows.length} — ${statuses[i]} — ${doneSoFar} success · ${errSoFar} error`);
				updateToolbarProgressBar(doneSoFar, errSoFar, rows.length);
			}

			_sessionRunning = false;
			notifySessionState(false);
			refreshToolbar();

			const done = statuses.filter(s => s === 'submitted').length;
			const errCnt = statuses.filter(s => s === 'error').length;
			updateToolbarProgressBar(done, errCnt, rows.length);
			if (!_aborted) showToolbarProgress(`Done — ${done} success, ${errCnt} error`);
			else showToolbarProgress(`Aborted — ${done} success, ${errCnt} error`);
		} finally {
			// Always resume watching for SPA navigation/re-renders, even if
			// the loop above threw — otherwise a mid-session error would
			// leave the toolbar unable to re-mount itself after navigation.
			_toolbarObserver.observe(_observeRoot, { childList: true, subtree: true });
		}
	}

	async function startSession() {
		if (_sessionRunning) return;
		hideToolbarError();
		let rows = [];
		try {
			const data = await window.DGCA_STORAGE.get(['dgca_pending_rows']);
			rows = data?.dgca_pending_rows || [];
		} catch (err) {
			showToolbarProgress('Start failed');
			showToolbarError(`Storage error: ${err.message}`);
			return;
		}
		if (rows.length === 0) {
			showToolbarProgress('Start failed');
			showToolbarError('No rows queued.');
			return;
		}
		try {
			await runSession(rows);
		} catch (err) {
			_sessionRunning = false;
			notifySessionState(false);
			refreshToolbar();
			showToolbarProgress('Session failed');
			showToolbarError(err.message);
		}
	}

	function abortSession() {
		if (!_sessionRunning) return;
		// Don't hide the progress panel here — runSession's loop notices
		// _aborted on its next iteration and reports the final "Aborted —
		// N success, N error" stats itself, which is what we want to leave
		// on screen. Its own finally block also handles reconnecting
		// _toolbarObserver, so nothing to do for that here.
		_aborted = true;
		_sessionRunning = false;
		notifySessionState(false);
		refreshToolbar();
		hideToolbarError();
	}

	// Announce initial (idle) state so alert-interceptor.js in the MAIN world
	// doesn't have to rely solely on its own default if this script is ever
	// re-injected mid-page-life (e.g. after an SPA navigation).
	notifySessionState(_sessionRunning);

	console.log('[DGCA Filler] Content script loaded on', window.location.href);
})();