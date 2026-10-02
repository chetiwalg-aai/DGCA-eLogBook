/**
 * DGCA e-LogBook queue filler — lean build.
 * Keeps the queue workflow and portal behavior, but removes nonessential UI,
 * animation, timing telemetry, repeated DOM lookup, and repeated station XHRs.
 */
(function () {
	'use strict';

	const { parseDateDMY, formatDDMMYYYY, sleep, addOneDay, namesMatch, escHtml, ROW_STATUS } = window.DGCA;

	const SEL = {
		briefing: '#isbriefingDone',
		fromDate: '#logBookDate',
		toDate: '#logBookEndDate',
		postingStation: '#postingStation',
		icao: '#letterIcaoCode',
		wso: '#atStoEgcaId',
		rating: '#ratingId',
		atsUnit: '#atsUnitId',
		remarks: '#ratingAndAtsRemarks',
		duty: '#typeOfDutyId',
		ojtf: '#ojtFields',
		ojtenv: '#ojtOprEnvSmlation',
		trainer: '#ojtTrainerName',
		trainerName: '#nameOfInstructor',
		examinerDiv: '#examinerLicenseNumberDiv',
		examiner: '#examinerLicenseNumber',
		traineeDiv: '#traineeLicenseNumberDiv',
		trainee: '#traineeLicenseNumber',
		proficiency: '#isProficiencyChecked',
		theory: '#isTheoryClasses',
		skill: '#isSkillTestChecked',
		ojtProvided: '#isOjtProvided',
		startTime: '#ojtStartTime',
		endTime: '#ojtEndTime',
		add: '#btnAddanssTrnTrainingDtlsVOList',
		totalDuration: '#totalDuration',
		isAtsUnitChecked: '#isAtsUnitChecked',
		newlyEstablisAtstsation: '#newlyEstablisAtstsation',
		reset: '#btnResetanssTrnTrainingDtlsVOList',
		resultTable: '#anssELogBookDtlsVOList',
		counter: '#anssELogBookDtlsVOListcounter',
		statusbar: '#statusbar',
	};

	const ALERT_EVENT = 'dgca_alert_captured';
	const SESSION_EVENT = 'dgca_session_state_changed';
	const refs = Object.create(null);
	const stationCache = new Map();
	let alertNodes = null;
	let lastAlert = null;
	let sessionRunning = false;
	let aborted = false;
	let toolbarEls = null;
	let toolbarHeading = null;
	let observerScheduled = false;
	let refreshSeq = 0;
	let rowEls = [];
	let activeRowIndex = -1;

	window.addEventListener(ALERT_EVENT, e => {
		lastAlert = e.detail?.msg || null;
	});

	function syncToolbarSessionState() {
		if (!toolbarEls) return;
		const running = sessionRunning;
		toolbarEls.start.disabled = running;
		toolbarEls.start.style.display = running ? 'none' : '';
		toolbarEls.abort.style.display = running ? 'inline-block' : 'none';
		toolbarEls.clearDone.disabled = running;
		toolbarEls.clearAll.disabled = running;
		toolbarEls.wsoAts.disabled = running;
		toolbarEls.wsoCustom.disabled = running || !toolbarEls.wsoCustomMode.checked;
	}

	function notifySessionState(running) {
		sessionRunning = !!running;
		syncToolbarSessionState();
		try {
			const detail = { running: sessionRunning };
			const d = typeof cloneInto === 'function' ? cloneInto(detail, window) : detail;
			window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: d }));
		} catch (_) { }
		chrome.storage.local.set({ dgca_session_running: sessionRunning }).catch(() => { });
	}

	function detectAlert() {
		const msg = lastAlert;
		lastAlert = null;
		return msg;
	}

	function el(key) {
		const current = refs[key];
		if (current?.isConnected) return current;
		const selector = SEL[key];
		if (!selector) return null;
		const found = document.querySelector(selector);
		if (found) refs[key] = found;
		return found;
	}

	function cacheFormRefs() {
		for (const key of Object.keys(SEL)) el(key);
		if (!alertNodes || (alertNodes.length && !alertNodes[0].isConnected)) alertNodes = document.querySelectorAll('[id^="alert_"]');
	}

	async function pollFor(check, timeout, message) {
		const deadline = Date.now() + timeout;
		let wait = 4;
		for (; ;) {
			const value = check();
			if (value) return value;
			if (Date.now() >= deadline) throw new Error(message);
			await sleep(wait);
			if (wait < 64) wait *= 2;
		}
	}

	async function waitForElement(key, timeout = 10000) {
		return pollFor(() => el(key), timeout, `Timeout waiting for ${key}`);
	}

	async function waitForValue(key, timeout = 10000) {
		return pollFor(() => {
			const node = el(key);
			return node && String(node.value || '').trim() ? node : null;
		}, timeout, `Timeout waiting for value in ${key}`);
	}

	async function waitForVisible(key, timeout = 8000) {
		return pollFor(() => {
			const node = el(key);
			if (!node) return null;
			if (node.offsetParent !== null) return node;
			return getComputedStyle(node).display !== 'none' ? node : null;
		}, timeout, `Timeout waiting for ${key} to become visible`);
	}

	function waitForOptions(key, timeout = 12000) {
		return pollFor(() => {
			const node = el(key);
			if (!node) return null;
			for (const option of node.options) {
				if (option.value && option.value !== '-1') return node;
			}
			return null;
		}, timeout, `Timeout waiting for options in ${key}`);
	}

	function waitForOptionValue(key, value, timeout = 10000) {
		return pollFor(() => {
			const node = el(key);
			if (!node) return null;
			for (const option of node.options) {
				if (option.value === value) return node;
			}
			return null;
		}, timeout, `Option value "${value}" not found in ${key}`);
	}

	function normText(value) {
		return String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();
	}

	function findOptionByText(select, text) {
		const target = normText(text);
		let loose = null;
		for (const option of select.options) {
			if (!option.value || option.value === '-1') continue;
			const label = normText(option.text);
			if (label === target) return option;
			if (!loose && (label.includes(target) || target.includes(label))) loose = option;
		}
		return loose;
	}

	function setSelectValue(node, value, fireChange = true, refresh = false) {
		node.value = value;
		if (window.jQuery) {
			try {
				const jq = window.jQuery(node);
				if (typeof jq.selectpicker === 'function') {
					jq.selectpicker('val', value);
					if (refresh) jq.selectpicker('refresh');
				}
			} catch (_) { }
		}
		node.value = value;
		if (fireChange) {
			node.dispatchEvent(new Event('change', { bubbles: true }));
			node.dispatchEvent(new Event('input', { bubbles: true }));
		}
	}

	function selectOptionText(node, text) {
		const match = findOptionByText(node, text);
		if (!match) throw new Error(`No option matching "${text}"`);
		setSelectValue(node, match.value, true, false);
		return match.value;
	}

	function selectOptionValue(node, value) {
		setSelectValue(node, value, true, false);
	}

	function setOptions(node, options) {
		const html = ['<option value="-1">--- Select ---</option>'];
		for (const [value, text] of options) {
			html.push(`<option value="${escHtml(value)}">${escHtml(text)}</option>`);
		}
		node.innerHTML = html.join('');
		if (window.jQuery) {
			try {
				const jq = window.jQuery(node);
				if (typeof jq.selectpicker === 'function') jq.selectpicker('refresh');
			} catch (_) { }
		}
	}

	function captureStationCache() {
		const station = el('postingStation');
		const wso = el('wso');
		const icao = el('icao');
		if (!station || !wso) return;
		stationCache.set(station.value, {
			icao: icao?.value || '',
			options: Array.from(wso.options, option => [option.value, option.text]),
		});
	}

	async function selectPostingStation(text) {
		const node = await waitForElement('postingStation');
		const match = findOptionByText(node, text);
		if (!match) throw new Error(`No posting station matching "${text}"`);

		const cached = stationCache.get(match.value);
		if (cached) {
			setSelectValue(node, match.value, false, false);
			const icao = el('icao');
			if (icao) icao.value = cached.icao;
			const wso = el('wso');
			if (wso) setOptions(wso, cached.options);
			return;
		}

		setSelectValue(node, match.value, true, false);
		await waitForValue('icao');
		await waitForOptions('wso');
		captureStationCache();
	}

	function setInput(key, value) {
		const node = el(key);
		if (!node) throw new Error(`Missing field: ${key}`);
		const expected = String(value ?? '');
		node.value = expected;
		node.dispatchEvent(new Event('input', { bubbles: true }));
		node.dispatchEvent(new Event('change', { bubbles: true }));
		node.dispatchEvent(new Event('blur', { bubbles: true }));
		if (expected.trim() && !node.value.trim()) {
			const note = document.getElementById(`alert_${node.id}`);
			throw new Error(`${key}: ${note?.textContent?.trim() || 'value rejected by portal'}`);
		}
		return node;
	}

	async function setInputVerified(key, value, attempts = 4) {
		const expected = String(value ?? '');
		const backoff = [0, 60, 180, 400];
		for (let i = 0; i < attempts; i++) {
			setInput(key, expected);
			const wait = backoff[Math.min(i, backoff.length - 1)];
			if (wait) await sleep(wait);
			const node = el(key);
			if (node?.value === expected) return node;
		}
		throw new Error(`${key}: value would not stick`);
	}

	function setDate(key, value) {
		const node = el(key);
		if (!node) throw new Error(`Missing field: ${key}`);
		node.value = value;
		node.dispatchEvent(new Event('input', { bubbles: true }));
		node.dispatchEvent(new Event('change', { bubbles: true }));
		node.dispatchEvent(new Event('blur', { bubbles: true }));
	}

	function ensureCheckbox(key, checked) {
		const node = el(key);
		if (!node) return;
		if (node.offsetParent === null && getComputedStyle(node).display === 'none') return;
		if (node.checked !== checked) node.click();
	}

	function clearValidationMessages() {
		if (!alertNodes || (alertNodes.length && !alertNodes[0].isConnected)) alertNodes = document.querySelectorAll('[id^="alert_"]');
		for (const node of alertNodes) node.textContent = '';
	}

	function collectValidationMessages() {
		if (!alertNodes || (alertNodes.length && !alertNodes[0].isConnected)) alertNodes = document.querySelectorAll('[id^="alert_"]');
		const messages = [];
		for (const node of alertNodes) {
			const text = node.textContent?.trim();
			if (text) messages.push(text);
		}
		return messages;
	}

	function countRows() {
		const counter = el('counter');
		if (counter) {
			const n = Number.parseInt(counter.value, 10);
			if (Number.isFinite(n)) return n;
		}
		const table = el('resultTable');
		return table ? table.querySelectorAll('tr[id^="row"]').length : 0;
	}

	function resetFields() {
		try {
			lastAlert = null;
			const reset = el('reset');
			if (reset) reset.click();
		} catch (_) { }
	}

	function statusbarIdle() {
		const bar = el('statusbar');
		return !bar || (bar.style.visibility || '') !== 'visible';
	}

	function observeStatusbarIdle(timeout) {
		return new Promise(resolve => {
			const bar = el('statusbar');
			if (!bar || statusbarIdle()) return resolve(true);
			let done = false;
			const finish = value => {
				if (done) return;
				done = true;
				observer.disconnect();
				clearTimeout(timer);
				resolve(value);
			};
			const observer = new MutationObserver(() => {
				if (statusbarIdle()) finish(true);
			});
			observer.observe(bar, { attributes: true, attributeFilter: ['style'] });
			const timer = setTimeout(() => finish(false), timeout);
		});
	}

	async function waitForStatusbarIdle(timeout = 10000) {
		return observeStatusbarIdle(timeout);
	}

	function armBusyWatch(timeout = 250) {
		return new Promise(resolve => {
			const bar = el('statusbar');
			if (bar && !statusbarIdle()) return resolve(true);
			if (!bar) return resolve(false);
			let done = false;
			const finish = value => {
				if (done) return;
				done = true;
				observer.disconnect();
				clearTimeout(timer);
				resolve(value);
			};
			const observer = new MutationObserver(() => {
				if (!statusbarIdle()) finish(true);
			});
			observer.observe(bar, { attributes: true, attributeFilter: ['style'] });
			const timer = setTimeout(() => finish(false), timeout);
		});
	}

	async function clickAddAndVerify() {
		const before = countRows();
		const button = await waitForElement('add', 6000);
		lastAlert = null;
		clearValidationMessages();

		const busyWatch = armBusyWatch();
		button.click();
		const wentBusy = statusbarIdle() ? await busyWatch : true;

		if (!wentBusy) {
			const alert = detectAlert();
			if (alert) return { ok: false, error: `Portal validation error: ${alert}` };
			const messages = collectValidationMessages();
			if (messages.length) return { ok: false, error: `Portal rejected: ${messages.join('; ')}` };
		}

		const deadline = Date.now() + 4000;
		let wait = 4;
		for (; ;) {
			const alert = detectAlert();
			if (alert) {
				await waitForStatusbarIdle(10000);
				return { ok: false, error: `Portal validation error: ${alert}` };
			}
			if (statusbarIdle()) {
				const after = countRows();
				if (after > before) return { ok: true };
				const messages = collectValidationMessages();
				if (messages.length) return { ok: false, error: `Portal rejected: ${messages.join('; ')}` };
			}
			if (Date.now() >= deadline) break;
			await sleep(wait);
			if (wait < 64) wait *= 2;
		}

		await waitForStatusbarIdle(10000);
		const after = countRows();
		if (after > before) return { ok: true };
		const alert = detectAlert();
		if (alert) return { ok: false, error: `Portal validation error (late): ${alert}` };
		const messages = collectValidationMessages();
		return {
			ok: false,
			error: messages.length
				? `Portal rejected: ${messages.join('; ')}`
				: `Row was not added to the table (before: ${before}, after: ${after}).`,
		};
	}

	async function fillRow(raw, wsoAtsText) {
		cacheFormRefs();
		clearValidationMessages();

		const timeFrom = raw.START_TIME;
		const timeTo = raw.END_TIME;
		const { d, m, y } = parseDateDMY(raw.FROM_DATE);
		const fromDate = formatDDMMYYYY(d, m, y);
		const toDate = raw.FROM_DATE === raw.TO_DATE && timeTo === '00:00'
			? (() => { const n = addOneDay(d, m, y); return formatDDMMYYYY(n.d, n.m, n.y); })()
			: (() => { const n = parseDateDMY(raw.TO_DATE); return formatDDMMYYYY(n.d, n.m, n.y); })();

		ensureCheckbox('briefing', true);
		setDate('fromDate', fromDate);
		setDate('toDate', toDate);

		await selectPostingStation(raw.POSTING_STATION);

		const wso = await waitForElement('wso');
		await waitForOptions('wso');
		if (raw.ATS_EGCA_ID) {
			try {
				selectOptionText(wso, raw.ATS_EGCA_ID);
			} catch (err) {
				const alt = raw.ATS_EGCA_ID.replace(/_/g, ' ');
				if (alt === raw.ATS_EGCA_ID) throw err;
				selectOptionText(wso, alt);
			}
		} else {
			selectOptionText(wso, wsoAtsText);
		}

		if (raw.RATING) {
			selectOptionText(await waitForElement('rating'), raw.RATING);
			const ats = await waitForOptions('atsUnit');
			selectOptionText(ats, String(raw.ATS_UNIT || '').replace(/-/g, ''));
		}

		selectOptionText(await waitForElement('duty'), raw.TYPE_OF_DUTY);

		switch (raw.TYPE_OF_DUTY) {
			case 'Operation Duty(Control)':
				if (raw.PROFICIENCY_CHECK === 'Y') {
					ensureCheckbox('proficiency', true);
					await waitForVisible('examinerDiv');
					selectOptionText(await waitForElement('ojtenv'), raw.OJT_ENV);
					setInput('examiner', raw.INSTRUCTOR_LICENSE);
					await waitForValue('trainer');
				}
				if (raw.NEWLY_ESTAB_UNIT_CHECK) ensureCheckbox('isAtsUnitChecked', true);
				break;

			case 'Instruction':
				if (raw.KNOWLEDGE_CHECK === 'Y') {
					ensureCheckbox('theory', true);
					if (raw.TRAINEE_LICENSE) setInput('remarks', `${raw.TRAINEE_NAME} (${raw.TRAINEE_LICENSE})`);
				} else if (raw.OJT_PROVIDED_CHECK === 'Y') {
					ensureCheckbox('ojtProvided', true);
					await waitForVisible('traineeDiv');
					selectOptionText(await waitForElement('ojtenv'), raw.OJT_ENV);
					setInput('trainee', raw.TRAINEE_LICENSE);
					const instructor = await waitForValue('trainerName');
					if (raw.TRAINEE_LICEN_TYPE === 'SATCOL' && raw.TRAINEE_NAME) {
						await setInputVerified('trainerName', raw.TRAINEE_NAME.toUpperCase());
					} else if (raw.TRAINEE_NAME && !namesMatch(instructor.value, raw.TRAINEE_NAME)) {
						await setInputVerified('trainerName', raw.TRAINEE_NAME.toUpperCase());
					}
				}
				break;

			case 'OJT (On Job Training)':
				await waitForVisible('examinerDiv');
				selectOptionText(await waitForElement('ojtenv'), raw.OJT_ENV);
				setInput('examiner', raw.INSTRUCTOR_LICENSE);
				await waitForValue('trainer');
				break;

			case 'Examiner Functions':
				if (raw.KNOWLEDGE_CHECK === 'Y') {
					ensureCheckbox('theory', true);
					setInput('trainerName', raw.INSTRUCTOR_NAME);
				} else if (raw.PROFICIENCY_CHECK === 'Y') {
					ensureCheckbox('proficiency', true);
					await waitForVisible('ojtf');
					selectOptionText(await waitForElement('ojtenv'), raw.OJT_ENV);
					setInput('trainee', raw.TRAINEE_LICENSE);
					await waitForValue('trainerName');
				} else if (raw.SKILL_TEST_CHECK === 'Y') {
					ensureCheckbox('skill', true);
					await waitForVisible('ojtf');
					selectOptionText(await waitForElement('ojtenv'), raw.OJT_ENV);
					setInput('trainee', raw.TRAINEE_LICENSE);
					const instructor = await waitForValue('trainerName');
					if (raw.TRAINEE_LICEN_TYPE === 'SATCOL' && raw.TRAINEE_NAME) {
						await setInputVerified('trainerName', raw.TRAINEE_NAME.toUpperCase());
					} else if (raw.TRAINEE_NAME && !namesMatch(instructor.value, raw.TRAINEE_NAME)) {
						await setInputVerified('trainerName', raw.TRAINEE_NAME.toUpperCase());
					}
				}
				break;

			case 'Classroom training/Classroom theory functions':
				await waitForVisible('ojtf');
				await waitForVisible('examinerDiv');
				setInput('examiner', raw.INSTRUCTOR_LICENSE);
				await waitForValue('trainer');
				break;

			case 'Skill test':
				await waitForVisible('ojtf');
				selectOptionText(await waitForElement('ojtenv'), raw.OJT_ENV);
				setInput('trainer', raw.INSTRUCTOR_NAME);
				break;

			case 'Familiarization of ATS Unit':
				await waitForVisible('ojtf');
				selectOptionText(await waitForElement('ojtenv'), raw.OJT_ENV);
				setInput('newlyEstablisAtstsation', raw.NEWLY_ESTAB_STATION);
				break;
		}

		if (raw.REMARKS) setInput('remarks', raw.REMARKS);
		setInput('startTime', timeFrom);
		setInput('endTime', timeTo);

		const timeAlert = detectAlert();
		if (timeAlert) throw new Error(`Portal rejected the times (${timeFrom}–${timeTo}): ${timeAlert}`);
		await waitForValue('totalDuration', 4000);
	}

	const STATUS_CLASS = {
		[ROW_STATUS.PENDING]: 'pending',
		[ROW_STATUS.FILLING]: 'filling',
		[ROW_STATUS.SUBMITTED]: 'submitted',
		[ROW_STATUS.ERROR]: 'error',
		[ROW_STATUS.SKIPPED]: 'skipped',
	};

	function statusLabel(status) {
		if (aborted && (status === ROW_STATUS.PENDING || status === ROW_STATUS.FILLING)) return 'Stopped';
		return ({
			pending: 'Pending', filling: 'Filling…', submitted: '✓ Added', error: '✗ Error', skipped: 'Skipped',
		}[status] || 'Pending');
	}

	function isEntryPage() {
		return document.querySelector('#breadcrumb')?.textContent.includes('Air Traffic Controllers e-Log Book')
			&& !!document.querySelector(SEL.briefing);
	}

	function findHeading() {
		for (const title of document.querySelectorAll('h5.panel-title')) {
			if (title.textContent.trim() === 'Logbook') return title.closest('.panel-heading');
		}
		return null;
	}

	function injectStyle() {
		if (document.getElementById('dgca-ext-toolbar-style')) return;
		const style = document.createElement('style');
		style.id = 'dgca-ext-toolbar-style';
		style.textContent = `
			#dgca-ext-toolbar{
				--bg:#0b0f14;--surface:#11161d;--surface-2:#171d25;--border:#27303b;
				--text:#edf2f7;--muted:#8e9aaa;--accent:#63b3ff;--accent-2:#8f7cff;
				margin-top:8px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);
				border-radius:10px;color:var(--text);font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
				color-scheme:dark;contain:layout paint style;box-shadow:0 4px 14px rgba(0,0,0,.16);
			}
			#dgca-ext-toolbar *{box-sizing:border-box}
			#dgca-ext-toolbar.dgca-ext-toolbar--hidden{display:none}
			#dgca-ext-toolbar.dgca-ext-toolbar--min .dgca-ext-toolbar-body{display:none}
			#dgca-ext-toolbar .dgca-ext-toolbar-header,
			#dgca-ext-toolbar .dgca-ext-toolbar-row,
			#dgca-ext-toolbar .dgca-ext-row{display:flex;align-items:center;gap:7px}
			#dgca-ext-toolbar .dgca-ext-toolbar-header{justify-content:space-between;padding-bottom:8px;border-bottom:1px solid var(--border);font-weight:700;letter-spacing:.01em;color:var(--text)}
			#dgca-ext-toolbar .dgca-ext-toolbar-title{display:flex;align-items:center;gap:7px}
			#dgca-ext-toolbar .dgca-ext-toolbar-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px rgba(99,179,255,.12)}
			#dgca-ext-toolbar .dgca-ext-toolbar-header button,
			#dgca-ext-toolbar .dgca-ext-toolbar-body button{
				border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);
				padding:5px 9px;cursor:pointer;font:inherit;line-height:1.1;transition:background .12s ease,border-color .12s ease,transform .12s ease;
			}
			#dgca-ext-toolbar button:hover:not(:disabled){background:#1c2430;border-color:#344151}
			#dgca-ext-toolbar button:active:not(:disabled){transform:translateY(1px)}
			#dgca-ext-toolbar button:focus-visible,
			#dgca-ext-toolbar input:focus-visible{outline:2px solid rgba(99,179,255,.65);outline-offset:1px}
			#dgca-ext-toolbar button:disabled{opacity:.42;cursor:default}
			#dgca-ext-toolbar #dgca-ext-start{border-color:#315f89;background:#142a3d;font-weight:700;color:#9fd2ff}
			#dgca-ext-toolbar #dgca-ext-start:hover:not(:disabled){background:#18354c;border-color:#407eae}
			#dgca-ext-toolbar #dgca-ext-abort{color:#ff9b9b;border-color:#71353a;background:#32191c;font-weight:700}
			#dgca-ext-toolbar #dgca-ext-abort:hover:not(:disabled){background:#412023;border-color:#884149}
			#dgca-ext-toolbar .dgca-ext-toolbar-body{margin-top:9px;background:transparent;color:var(--text)}
			#dgca-ext-toolbar .dgca-ext-layout{display:grid;grid-template-columns:minmax(235px,.9fr) minmax(320px,1.35fr);gap:10px}
			#dgca-ext-toolbar .dgca-ext-left,
			#dgca-ext-toolbar .dgca-ext-right{min-width:0;padding:9px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text)}
			#dgca-ext-toolbar .dgca-ext-controls{display:flex;flex-wrap:wrap;gap:6px}
			#dgca-ext-toolbar .dgca-ext-wso{margin-top:9px;flex-wrap:wrap;color:var(--text)}
			#dgca-ext-toolbar .dgca-ext-wso label{display:flex;align-items:center;gap:5px;color:var(--muted);font-size:11px}
			#dgca-ext-toolbar .dgca-ext-wso input[type=radio]{accent-color:var(--accent)}
			#dgca-ext-toolbar .dgca-ext-wso input[type=text]{width:88px;padding:5px 7px;border:1px solid var(--border);border-radius:5px;background:#0d1218;color:var(--text);font:inherit}
			#dgca-ext-toolbar .dgca-ext-ids{margin-top:9px;padding:6px 8px;border:1px solid #2b465f;border-radius:6px;background:#10202d;color:#9fd2ff;font-size:10px}
			#dgca-ext-toolbar .dgca-ext-progress{margin-top:10px}
			#dgca-ext-toolbar .dgca-ext-progress-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;color:var(--muted);font-size:10px}
			#dgca-ext-toolbar .dgca-ext-progress-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
			#dgca-ext-toolbar .dgca-ext-progress-percent{font-variant-numeric:tabular-nums;color:#c7d2df;font-weight:700}
			#dgca-ext-toolbar .dgca-ext-progress-track{height:5px;overflow:hidden;border-radius:999px;background:#222a34}
			#dgca-ext-toolbar .dgca-ext-progress-fill{height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent-2));border-radius:inherit;transition:width .16s ease;will-change:width}
			#dgca-ext-toolbar .dgca-ext-error{margin-top:8px;padding:7px 8px;background:#30171b;border:1px solid #6b3038;border-radius:6px;color:#ff9b9b;display:none;cursor:pointer;font-size:10px;line-height:1.35}
			#dgca-ext-toolbar .dgca-ext-queue-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;color:var(--text);font-weight:700}
			#dgca-ext-toolbar .dgca-ext-queue-subtitle{color:var(--muted);font-weight:500;font-size:10px}
			#dgca-ext-toolbar .dgca-ext-row-list{display:flex;flex-direction:column;gap:5px;max-height:220px;overflow:auto;padding-right:2px;scrollbar-width:thin;scrollbar-color:#34404d transparent}
			#dgca-ext-toolbar .dgca-ext-row-list::-webkit-scrollbar{width:7px}
			#dgca-ext-toolbar .dgca-ext-row-list::-webkit-scrollbar-thumb{background:#34404d;border-radius:999px}
			#dgca-ext-toolbar .dgca-ext-row{display:block;padding:7px 8px;background:#0d1218;border:1px solid #202833;border-radius:7px;min-width:0;color:#dce4ed;transition:border-color .12s ease,background .12s ease}
			#dgca-ext-toolbar .dgca-ext-row-mainline{display:flex;align-items:center;gap:7px;min-width:0}
			#dgca-ext-toolbar .dgca-ext-row-main{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;flex:1}
			#dgca-ext-toolbar .dgca-ext-row-main span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
			#dgca-ext-toolbar .dgca-ext-row-num{color:#647080;min-width:18px;font-variant-numeric:tabular-nums}
			#dgca-ext-toolbar .dgca-ext-row-date{color:#8ecbff;font-weight:600}
			#dgca-ext-toolbar .dgca-ext-row-meta{color:#aab5c2}
			#dgca-ext-toolbar .dgca-ext-row-pill{font-size:9px;font-weight:700;padding:3px 7px;border-radius:999px;white-space:nowrap;border:1px solid transparent}
			#dgca-ext-toolbar .dgca-ext-row-pill.pending{background:#202833;color:#aeb8c5;border-color:#2b3440}
			#dgca-ext-toolbar .dgca-ext-row-pill.filling{background:#102b40;color:#76c9ff;border-color:#244e6a}
			#dgca-ext-toolbar .dgca-ext-row-pill.submitted{background:#10281a;color:#79df98;border-color:#244d31}
			#dgca-ext-toolbar .dgca-ext-row-pill.error{background:#39171c;color:#ff8f98;border-color:#69313a}
			#dgca-ext-toolbar .dgca-ext-row-pill.skipped{background:#242830;color:#b4bcc7;border-color:#343a43}
			#dgca-ext-toolbar .dgca-ext-row-delete{border:0!important;background:transparent!important;color:#ff8f98!important;padding:0 2px!important;font-size:14px!important;line-height:1!important}
			#dgca-ext-toolbar .dgca-ext-row-error{display:none;margin:5px 0 0 24px;padding:5px 6px;background:#1d1114;border-left:2px solid #c6535f;color:#ff9ca4;font-size:10px;line-height:1.4;white-space:normal;overflow-wrap:anywhere}
			#dgca-ext-toolbar .dgca-ext-row--active{border-color:#2c5875;background:#101a24}
			#dgca-ext-toolbar .dgca-ext-min{padding:2px 7px!important;color:var(--muted)!important;background:#141a21!important}
			@media(max-width:900px){#dgca-ext-toolbar .dgca-ext-layout{grid-template-columns:1fr}}
			@media(prefers-reduced-motion:reduce){#dgca-ext-toolbar *{transition:none!important}}
		`;

		document.head.appendChild(style);
	}

	function minimizedState() {
		try { return localStorage.getItem('dgca_toolbar_min') === '1'; } catch (_) { return false; }
	}

	function setMinimized(value) {
		const toolbar = toolbarEls?.toolbar;
		if (!toolbar) return;
		toolbar.classList.toggle('dgca-ext-toolbar--min', value);
		toolbarEls.min.textContent = value ? '▢' : '—';
		try { localStorage.setItem('dgca_toolbar_min', value ? '1' : '0'); } catch (_) { }
	}

	function showProgress(text, percent = null) {
		if (!toolbarEls) return;
		toolbarEls.progressText.textContent = text;
		if (percent != null) {
			const safe = Math.max(0, Math.min(100, Number(percent) || 0));
			toolbarEls.progressFill.style.width = `${safe}%`;
			toolbarEls.progressPercent.textContent = `${Math.round(safe)}%`;
		}
	}

	function showError(text) {
		if (!toolbarEls) return;
		toolbarEls.error.textContent = `✗ ${text}`;
		toolbarEls.error.style.display = 'block';
		toolbarEls.error.onclick = () => alert(text);
	}

	function hideError() {
		if (!toolbarEls) return;
		toolbarEls.error.style.display = 'none';
		toolbarEls.error.onclick = null;
	}

	function patchRow(index, status, error) {
		const refs = rowEls[index];
		if (!refs) return;
		refs.pill.className = `dgca-ext-row-pill ${STATUS_CLASS[status] || 'pending'}`;
		refs.pill.textContent = statusLabel(status);
		const message = status === ROW_STATUS.ERROR ? (error || 'Unknown error') : '';
		refs.item.title = message;
		refs.item.classList.toggle('dgca-ext-row--active', status === ROW_STATUS.FILLING);
		if (refs.detail) {
			refs.detail.textContent = message;
			refs.detail.style.display = message ? 'block' : 'none';
		}

		// Keep the queue list itself following the row being filled.
		// Do not use item.scrollIntoView(), because that can also scroll the page.
		if (status === ROW_STATUS.FILLING && activeRowIndex !== index) {
			activeRowIndex = index;
			requestAnimationFrame(() => scrollActiveRowIntoView(index));
		}
	}

	function scrollActiveRowIntoView(index) {
		const list = toolbarEls?.list;
		const item = rowEls[index]?.item;
		if (!list || !item) return;
		const listRect = list.getBoundingClientRect();
		const itemRect = item.getBoundingClientRect();
		if (itemRect.top < listRect.top) {
			list.scrollTop -= listRect.top - itemRect.top;
		} else if (itemRect.bottom > listRect.bottom) {
			list.scrollTop += itemRect.bottom - listRect.bottom;
		}
	}

	function renderRows(rows, statuses, errors) {
		if (!toolbarEls) return;
		const list = toolbarEls.list;
		rowEls = [];
		activeRowIndex = -1;
		list.innerHTML = rows.map((row, i) => {
			const status = statuses[i] || ROW_STATUS.PENDING;
			const duty = String(row.TYPE_OF_DUTY || '').split('(')[0].trim();
			const station = row.ATS_UNIT ? `${row.RATING || ''} - ${row.ATS_UNIT}`.replace(/^ - | - $/g, '') : '';
			const error = errors[i] || '';
			return `<div class="dgca-ext-row" data-row="${i}" title="${escHtml(error)}">
				<div class="dgca-ext-row-mainline">
					<div class="dgca-ext-row-main">
						<span class="dgca-ext-row-num">${i + 1}</span>
						<span class="dgca-ext-row-date">${escHtml(row.date || row.FROM_DATE || '')}</span>
						<span class="dgca-ext-row-meta">${escHtml(`${row.START_TIME || ''}–${row.END_TIME || ''}`)}</span>
						${station ? `<span class="dgca-ext-row-meta">${escHtml(station)}</span>` : ''}
						${duty ? `<span class="dgca-ext-row-meta">${escHtml(duty)}</span>` : ''}
					</div>
					<span class="dgca-ext-row-pill ${STATUS_CLASS[status] || 'pending'}">${statusLabel(status)}</span>
					${sessionRunning ? '' : `<button type="button" class="dgca-ext-row-delete" data-delete="${i}" title="Remove">×</button>`}
				</div>
				<div class="dgca-ext-row-error" style="${status === ROW_STATUS.ERROR && error ? 'display:block' : 'display:none'}">${escHtml(error)}</div>
			</div>`;
		}).join('');

		for (const item of list.children) {
			const index = Number(item.dataset.row);
			rowEls[index] = {
				item,
				pill: item.querySelector('.dgca-ext-row-pill'),
				detail: item.querySelector('.dgca-ext-row-error'),
			};
		}
	}

	async function readQueue() {
		try {
			return await chrome.storage.local.get([
				'dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_queue_user',
				'dgca_wso_ats_mode', 'dgca_wso_custom_text',
			]);
		} catch (_) {
			return {};
		}
	}

	async function refreshToolbar(forceRows = true) {
		if (!toolbarEls) return;
		const seq = ++refreshSeq;
		const data = await readQueue();
		if (seq !== refreshSeq || !toolbarEls) return;

		const rows = data.dgca_pending_rows || [];
		const statuses = data.dgca_row_status || [];
		const errors = data.dgca_row_errors || {};
		const mode = data.dgca_wso_ats_mode || 'custom';
		const custom = data.dgca_wso_custom_text || 'WSO';
		const total = rows.length;
		const done = statuses.reduce((n, s) => n + (s === ROW_STATUS.SUBMITTED ? 1 : 0), 0);
		const err = statuses.reduce((n, s) => n + (s === ROW_STATUS.ERROR ? 1 : 0), 0);
		const skipped = statuses.reduce((n, s) => n + (s === ROW_STATUS.SKIPPED ? 1 : 0), 0);
		const processed = Math.min(total, done + err + skipped);
		const percent = total ? (processed / total) * 100 : 0;

		toolbarEls.toolbar.classList.toggle('dgca-ext-toolbar--hidden', total === 0);
		toolbarEls.start.disabled = total === 0 || sessionRunning;
		toolbarEls.start.style.display = sessionRunning ? 'none' : '';
		toolbarEls.abort.style.display = sessionRunning ? 'inline-block' : 'none';
		toolbarEls.clearDone.disabled = sessionRunning || done === 0;
		toolbarEls.clearAll.disabled = sessionRunning || total === 0;
		toolbarEls.wsoAts.disabled = sessionRunning;
		toolbarEls.wsoCustom.disabled = sessionRunning || mode === 'ats';
		toolbarEls.wsoAts.checked = mode === 'ats';
		toolbarEls.wsoCustomMode.checked = mode !== 'ats';
		if (document.activeElement !== toolbarEls.wsoCustom) toolbarEls.wsoCustom.value = custom;
		toolbarEls.queueTitle.querySelector('span:first-child').textContent = `Queue · ${total} row${total === 1 ? '' : 's'}`;
		toolbarEls.queueSubtitle.textContent = sessionRunning ? 'Running' : (total ? 'Ready' : 'Waiting');
		showProgress(total ? `${processed} of ${total} processed · ${done} added · ${err} error${err === 1 ? '' : 's'}` : 'Waiting for queue', percent);

		if (total && rows.every(row => !!row.ATS_EGCA_ID)) {
			toolbarEls.wsoRow.style.display = 'none';
			toolbarEls.ids.style.display = '';
		} else {
			toolbarEls.wsoRow.style.display = '';
			toolbarEls.ids.style.display = 'none';
		}

		if (forceRows) renderRows(rows, statuses, errors);
	}

	async function deleteRow(index) {
		if (sessionRunning) return;
		const data = await readQueue();
		const rows = data.dgca_pending_rows || [];
		const statuses = data.dgca_row_status || [];
		const errors = data.dgca_row_errors || {};
		if (index < 0 || index >= rows.length) return;
		if (!confirm(`Remove row ${index + 1} from queue?`)) return;
		rows.splice(index, 1);
		statuses.splice(index, 1);
		const nextErrors = {};
		for (const [key, value] of Object.entries(errors)) {
			const n = Number(key);
			if (n < index) nextErrors[n] = value;
			else if (n > index) nextErrors[n - 1] = value;
		}
		await chrome.storage.local.set({
			dgca_pending_rows: rows,
			dgca_row_status: statuses,
			dgca_row_errors: nextErrors,
		});
		if (!rows.length) await chrome.storage.local.remove(['dgca_queue_user']).catch(() => { });
		refreshToolbar(true);
	}

	async function clearDone() {
		if (sessionRunning) return;
		const data = await readQueue();
		const rows = data.dgca_pending_rows || [];
		const statuses = data.dgca_row_status || [];
		const errors = data.dgca_row_errors || {};
		const keep = [];
		const nextStatuses = [];
		const nextErrors = {};
		for (let i = 0; i < rows.length; i++) {
			if (statuses[i] === ROW_STATUS.SUBMITTED) continue;
			const next = keep.length;
			keep.push(rows[i]);
			nextStatuses.push(statuses[i] || ROW_STATUS.PENDING);
			if (errors[i]) nextErrors[next] = errors[i];
		}
		if (keep.length === rows.length) return;
		await chrome.storage.local.set({
			dgca_pending_rows: keep,
			dgca_row_status: nextStatuses,
			dgca_row_errors: nextErrors,
		});
		if (!keep.length) await chrome.storage.local.remove(['dgca_queue_user']).catch(() => { });
		refreshToolbar(true);
	}

	async function clearAll() {
		if (sessionRunning || !confirm('Clear the entire queue?')) return;
		await chrome.storage.local.remove([
			'dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_row_timings', 'dgca_session_ts', 'dgca_queue_user',
		]).catch(() => { });
		refreshToolbar(true);
	}

	function persistMode() {
		if (!toolbarEls) return;
		window.clearTimeout(persistMode.timer);
		persistMode.timer = window.setTimeout(() => {
			chrome.storage.local.set({
				dgca_wso_ats_mode: toolbarEls.wsoAts.checked ? 'ats' : 'custom',
				dgca_wso_custom_text: toolbarEls.wsoCustom.value,
			}).catch(() => { });
		}, 200);
	}

	function buildToolbar(heading) {
		if (heading.querySelector('#dgca-ext-toolbar')) return;
		injectStyle();
		const toolbar = document.createElement('div');
		toolbar.id = 'dgca-ext-toolbar';
		toolbar.innerHTML = `
			<div class="dgca-ext-toolbar-header">
				<div class="dgca-ext-toolbar-title"><span class="dgca-ext-toolbar-dot"></span><span>eLogBook Filler</span></div>
				<button type="button" class="dgca-ext-min" aria-label="Minimize toolbar">—</button>
			</div>
			<div class="dgca-ext-toolbar-body">
				<div class="dgca-ext-layout">
					<div class="dgca-ext-left">
						<div class="dgca-ext-controls">
							<button type="button" id="dgca-ext-start">▶ Start</button>
							<button type="button" id="dgca-ext-abort" style="display:none">■ Abort</button>
							<button type="button" id="dgca-ext-clear-done">✓ Clear Done</button>
							<button type="button" id="dgca-ext-clear-all">🗑 Clear All</button>
						</div>
						<div class="dgca-ext-wso dgca-ext-toolbar-row" id="dgca-ext-wso-row">
							<label><input type="radio" name="dgca-ext-wso-mode" id="dgca-ext-wso-ats" value="ats"> ATS</label>
							<label><input type="radio" name="dgca-ext-wso-mode" id="dgca-ext-wso-custom-mode" value="custom"> <input id="dgca-ext-wso-custom" type="text" value="WSO"></label>
						</div>
						<div id="dgca-ext-ids" class="dgca-ext-ids" style="display:none">Using imported EGCA IDs</div>
						<div id="dgca-ext-progress" class="dgca-ext-progress" role="status" aria-live="polite">
							<div class="dgca-ext-progress-head">
								<span id="dgca-ext-progress-text" class="dgca-ext-progress-text">Ready</span>
								<span id="dgca-ext-progress-percent" class="dgca-ext-progress-percent">0%</span>
							</div>
							<div class="dgca-ext-progress-track" aria-hidden="true">
								<div id="dgca-ext-progress-fill" class="dgca-ext-progress-fill"></div>
							</div>
						</div>
						<div id="dgca-ext-error" class="dgca-ext-error"></div>
					</div>
					<div class="dgca-ext-right">
						<div id="dgca-ext-queue-title" class="dgca-ext-queue-title">
							<span>Queue</span>
							<span id="dgca-ext-queue-subtitle" class="dgca-ext-queue-subtitle">Waiting</span>
						</div>
						<div id="dgca-ext-row-list" class="dgca-ext-row-list"></div>
					</div>
				</div>
			</div>`;
		heading.appendChild(toolbar);

		toolbarEls = {
			toolbar,
			min: toolbar.querySelector('.dgca-ext-min'),
			start: toolbar.querySelector('#dgca-ext-start'),
			abort: toolbar.querySelector('#dgca-ext-abort'),
			clearDone: toolbar.querySelector('#dgca-ext-clear-done'),
			clearAll: toolbar.querySelector('#dgca-ext-clear-all'),
			wsoRow: toolbar.querySelector('#dgca-ext-wso-row'),
			wsoAts: toolbar.querySelector('#dgca-ext-wso-ats'),
			wsoCustomMode: toolbar.querySelector('#dgca-ext-wso-custom-mode'),
			wsoCustom: toolbar.querySelector('#dgca-ext-wso-custom'),
			ids: toolbar.querySelector('#dgca-ext-ids'),
			progress: toolbar.querySelector('#dgca-ext-progress'),
			progressText: toolbar.querySelector('#dgca-ext-progress-text'),
			progressFill: toolbar.querySelector('#dgca-ext-progress-fill'),
			progressPercent: toolbar.querySelector('#dgca-ext-progress-percent'),
			error: toolbar.querySelector('#dgca-ext-error'),
			queueTitle: toolbar.querySelector('#dgca-ext-queue-title'),
			queueSubtitle: toolbar.querySelector('#dgca-ext-queue-subtitle'),
			list: toolbar.querySelector('#dgca-ext-row-list'),
		};

		setMinimized(minimizedState());
		toolbarEls.min.addEventListener('click', () => setMinimized(!toolbar.classList.contains('dgca-ext-toolbar--min')));
		toolbarEls.start.addEventListener('click', startSession);
		toolbarEls.abort.addEventListener('click', () => {
			if (confirm('Abort the current session?')) abortSession();
		});
		toolbarEls.clearDone.addEventListener('click', clearDone);
		toolbarEls.clearAll.addEventListener('click', clearAll);
		toolbarEls.list.addEventListener('click', e => {
			const button = e.target.closest('[data-delete]');
			if (button) deleteRow(Number(button.dataset.delete));
		});
		toolbarEls.wsoAts.addEventListener('change', persistMode);
		toolbarEls.wsoCustomMode.addEventListener('change', persistMode);
		toolbarEls.wsoCustom.addEventListener('focus', () => {
			if (!toolbarEls.wsoCustomMode.checked) toolbarEls.wsoCustomMode.click();
		});
		toolbarEls.wsoCustom.addEventListener('input', persistMode);
		syncToolbarSessionState();
	}

	async function confirmNamesMatch() {
		let queueUser = null;
		try {
			const data = await chrome.storage.local.get(['dgca_queue_user']);
			queueUser = data.dgca_queue_user || null;
		} catch (_) { }
		const source = queueUser && (queueUser.name || queueUser.loginId);
		const target = document.querySelector('#viewRoleDiv span:not(.sub-text)')?.textContent.trim() || '';
		if (!source || !target || namesMatch(source, target)) return true;
		return confirm(`Queue user: "${source}"\nDGCA user: "${target}"\n\nContinue filling anyway?`);
	}

	async function runSession(rows) {
		notifySessionState(true);
		aborted = false;
		stationCache.clear();
		hideError();
		const statuses = rows.map(() => ROW_STATUS.PENDING);
		const errors = {};
		let done = 0;
		let errCount = 0;

		await chrome.storage.local.set({ dgca_row_status: statuses, dgca_row_errors: errors }).catch(() => { });
		showProgress(`0 of ${rows.length} processed · 0 added · 0 errors`, 0);

		const data = await chrome.storage.local.get(['dgca_wso_ats_mode', 'dgca_wso_custom_text']).catch(() => ({}));
		const wsoAtsText = data.dgca_wso_ats_mode === 'ats' ? 'ATS' : (data.dgca_wso_custom_text || 'WSO');

		for (let i = 0; i < rows.length; i++) {
			if (aborted) break;
			if (i === 0 || statuses[i - 1] !== ROW_STATUS.SUBMITTED) resetFields();
			statuses[i] = ROW_STATUS.FILLING;
			patchRow(i, ROW_STATUS.FILLING);
			showProgress(`Row ${i + 1}/${rows.length} · ${done} added · ${errCount} errors`, (i / rows.length) * 100);

			try {
				await fillRow(rows[i], wsoAtsText);
				if (aborted) break;
				const result = await clickAddAndVerify();
				if (result.ok) {
					statuses[i] = ROW_STATUS.SUBMITTED;
					done++;
					patchRow(i, ROW_STATUS.SUBMITTED);
				} else {
					statuses[i] = ROW_STATUS.ERROR;
					errors[i] = result.error;
					errCount++;
					patchRow(i, ROW_STATUS.ERROR, result.error);
				}
			} catch (error) {
				statuses[i] = ROW_STATUS.ERROR;
				errors[i] = error?.message || String(error);
				errCount++;
				patchRow(i, ROW_STATUS.ERROR, errors[i]);
			}

			await chrome.storage.local.set({
				dgca_row_status: statuses.slice(),
				dgca_row_errors: { ...errors },
			}).catch(() => { });
			showProgress(`Row ${i + 1}/${rows.length} · ${done} added · ${errCount} errors`, ((i + 1) / rows.length) * 100);
		}

		notifySessionState(false);
		await refreshToolbar(true);
		showProgress(aborted ? `Aborted · ${done} added · ${errCount} errors` : `Done · ${done} added · ${errCount} errors`, aborted ? ((done + errCount) / rows.length) * 100 : 100);
	}

	async function startSession() {
		if (sessionRunning) return;
		hideError();
		const data = await chrome.storage.local.get(['dgca_pending_rows']).catch(() => ({}));
		const rows = data.dgca_pending_rows || [];
		if (!rows.length) {
			showError('No rows queued.');
			return;
		}
		if (!(await confirmNamesMatch())) return;
		try {
			await runSession(rows);
		} catch (error) {
			notifySessionState(false);
			showError(error?.message || String(error));
			refreshToolbar(true);
		}
	}

	function abortSession() {
		if (!sessionRunning) return;
		aborted = true;
		showProgress('Stopping after current step…');
	}

	function setupToolbar() {
		if (!isEntryPage()) {
			document.getElementById('dgca-ext-toolbar')?.remove();
			toolbarEls = null;
			toolbarHeading = null;
			return false;
		}
		if (toolbarHeading?.isConnected) {
			if (!toolbarHeading.querySelector('#dgca-ext-toolbar')) buildToolbar(toolbarHeading);
			return true;
		}
		const heading = findHeading();
		if (!heading) return false;
		toolbarHeading = heading;
		if (!heading.querySelector('#dgca-ext-toolbar')) buildToolbar(heading);
		refreshToolbar(true);
		return true;
	}

	setupToolbar();

	const root = document.getElementById('contWrapper') || document.body;
	const observer = new MutationObserver(mutations => {
		if (observerScheduled || sessionRunning) return;
		let relevant = false;
		if (toolbarHeading && !toolbarHeading.isConnected) relevant = true;
		if (!relevant) {
			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) {
					if (node.nodeType !== 1) continue;
					if (node.matches?.('.panel-heading,h5.panel-title,#dgca-ext-toolbar') || node.querySelector?.('.panel-heading,h5.panel-title,#dgca-ext-toolbar')) {
						relevant = true;
						break;
					}
				}
				if (relevant) break;
			}
		}
		if (!relevant) return;
		observerScheduled = true;
		const raf = fn => (typeof window.requestAnimationFrame === 'function'
			? window.requestAnimationFrame(fn)
			: setTimeout(fn, 16));
		raf(() => {
			try { setupToolbar(); }
			finally { observerScheduled = false; }
		});
	});
	observer.observe(root, { childList: true, subtree: true });

	chrome.storage.local.onChanged.addListener(changes => {
		if (changes.dgca_pending_rows || changes.dgca_queue_user || (changes.dgca_row_status && !sessionRunning)) {
			refreshToolbar(true);
		}
	});

	notifySessionState(false);
})();
