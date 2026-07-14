/**
dgca-filler.js
Runs on: https://www.dgca.gov.in/*
Fills the DGCA eLogBook entry form from rows scraped off the AAI EGcAexport
page. All dropdowns are matched by their exact visible text against the raw
values captured from the EGCA export table — no static value maps needed.
*/
(function () {
	'use strict';
	const { parseDateDMY, formatDDMMYYYY, sleep, addOneDay } = window.DGCA;
	const {
		SEL, waitForSelector, waitForSelectOptions, waitForVisible,
		waitForFieldValue, selectByText, selectByValue, setDatePickerValue, typeIntoField,
		ensureCheckbox, resetFields, clickAddAndVerify, sendProgress
	} = window.DGCA_FILLER;

	async function selectWsoOrAts(selector, useAts) {
		const el = await waitForSelector(selector);
		const searchStr = useAts ? 'ats' : 'wso';
		const match = Array.from(el.options).find(o =>
			o.value.toLowerCase().includes(searchStr) ||
			o.text.toLowerCase().includes(searchStr)
		);
		if (match) {
			await selectByValue(selector, match.value);
		}
	}

	async function fillRow(row, useAts = false) {
		// console.log('[DGCA Filler] Processing row:', row);

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
			await selectByText(SEL.wsoEgcaId, raw.atsEgcaId);
		} else {
			await selectWsoOrAts(SEL.wsoEgcaId, useAts);
		}

		// ── Rating (by text) ─────────────────────────────────────────────────
		await selectByText(SEL.ratingId, raw.rating);

		// ── ATS Unit (by text) ───────────────────────────────────────────────
		await waitForSelectOptions(SEL.atsUnitId);
		await selectByText(SEL.atsUnitId, raw.atsUnit);

		// ── Type of Duty (by text) ───────────────────────────────────────────
		await selectByText(SEL.typeOfDutyId, raw.typeOfDuty);

		if (raw.typeOfDuty === 'Operation Duty(Control)') {
			if (raw.proficiencyCheck === 'Y') {
				await ensureCheckbox('#isProficiencyChecked', true);
				await waitForVisible(SEL.examinerLicNumDiv);
				await selectByText(SEL.ojtEnv, raw.ojtEnv);
				await typeIntoField(SEL.examinerAtcol, raw.instructorLicense);
				await waitForFieldValue('#ojtTrainerName');
			}
			if (raw.newlyEstabStation === 'Y') {
				await ensureCheckbox('#isAtsUnitChecked', true);
			}

		} else if (raw.typeOfDuty === 'Instruction') {
			if (raw.knowledgeCheck === 'Y') {
				await ensureCheckbox(SEL.isTheoryClasses, true);
				await typeIntoField(SEL.remarksField, `${raw.ojtiName} (${raw.traineeLicense})`);
			} else if (raw.ojtProvidedCheck === 'Y') {
				await ensureCheckbox(SEL.isOjtProvided, true);
				await waitForVisible(SEL.traineeLicNumDiv);
				await selectByText(SEL.ojtEnv, raw.ojtEnv);
				await typeIntoField(SEL.traineeAtcol, raw.traineeLicense);
				await waitForFieldValue('#nameOfInstructor');
			}

		} else if (raw.typeOfDuty === 'OJT (On Job Training)') {
			await waitForVisible(SEL.examinerLicNumDiv);
			await selectByText(SEL.ojtEnv, raw.ojtEnv);
			await typeIntoField(SEL.examinerAtcol, raw.instructorLicense);
			await waitForFieldValue('#ojtTrainerName');

		} else if (raw.typeOfDuty === 'Examiner Functions') {
			if (raw.knowledgeCheck === 'Y') {
				await ensureCheckbox(SEL.isTheoryClasses, true);
				await typeIntoField('#nameOfInstructor', raw.ojtiName);
			} else if (raw.proficiencyCheck === 'Y') {
				await ensureCheckbox('#isProficiencyChecked', true);
				await waitForVisible(SEL.ojtFieldsDiv);
				await selectByText(SEL.ojtEnv, raw.ojtEnv);
				await typeIntoField(SEL.traineeAtcol, raw.traineeLicense);
				await waitForFieldValue('#nameOfInstructor');
			} else if (raw.skillTestCheck === 'Y') {
				await ensureCheckbox('#isSkillTestChecked', true);
				await waitForVisible(SEL.ojtFieldsDiv);
				await selectByText(SEL.ojtEnv, raw.ojtEnv);
				await typeIntoField(SEL.traineeAtcol, raw.traineeLicense);
				await waitForFieldValue('#nameOfInstructor');
			}

		} else if (raw.typeOfDuty === 'Classroom training/Classroom theory functions') {
			await waitForVisible(SEL.ojtFieldsDiv);
			await waitForVisible(SEL.examinerLicNumDiv);
			await typeIntoField(SEL.examinerAtcol, raw.instructorLicense);
			await waitForFieldValue('#ojtTrainerName');

		} else if (raw.typeOfDuty === 'Skill test') {
			await waitForVisible(SEL.ojtFieldsDiv);
			await selectByText(SEL.ojtEnv, raw.ojtEnv);
			await typeIntoField('#ojtTrainerName', raw.instructorName);

		} else if (raw.typeOfDuty === 'Familiarization of ATS Unit') {
			await waitForVisible(SEL.ojtFieldsDiv);
			await selectByText(SEL.ojtEnv, raw.ojtEnv);
			await typeIntoField('#newlyEstablisAtstsation', raw.postingStation);

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

	async function runSession(rows) {
		_sessionRunning = true;
		_aborted = false;

		const statuses = rows.map(() => 'pending');
		const errors = {};
		const _atsData = await window.DGCA_STORAGE.get(['dgca_use_ats']).catch(() => ({}));
		const useAts = !!(_atsData?.dgca_use_ats);

		await window.DGCA_STORAGE.set({ dgca_row_status: statuses });

		for (let i = 0; i < rows.length; i++) {
			if (_aborted) break;

			const row = rows[i];
			statuses[i] = 'filling';
			await window.DGCA_STORAGE.set({ dgca_row_status: [...statuses] });
			sendProgress({ index: i, total: rows.length, status: 'filling', row });

			try { await resetFields(); } catch (_) { }

			if (_aborted) break;

			try {
				await fillRow(row, useAts);
				if (_aborted) break;

				const result = await clickAddAndVerify();
				if (result.ok) {
					statuses[i] = 'submitted';
					sendProgress({ index: i, total: rows.length, status: 'submitted' });
				} else {
					statuses[i] = 'error';
					errors[i] = result.error;
					sendProgress({ index: i, total: rows.length, status: 'error', error: result.error });
				}
			} catch (err) {
				statuses[i] = 'error';
				errors[i] = err.message;
				sendProgress({ index: i, total: rows.length, status: 'error', error: err.message });
			}

			await window.DGCA_STORAGE.set({ dgca_row_status: [...statuses], dgca_row_errors: { ...errors } });
		}

		_sessionRunning = false;

		const done = statuses.filter(s => s === 'submitted').length;
		const errCnt = statuses.filter(s => s === 'error').length;
		sendProgress({ status: 'session-complete', total: rows.length, done, errors: errCnt });
	}

	chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
		if (msg.type === 'START_FILLING') {
			if (_sessionRunning) { sendResponse({ ok: false, error: 'Session already running' }); return; }
			runSession(msg.rows).catch(err => sendProgress({ status: 'session-error', error: err.message }));
			sendResponse({ ok: true });
		} else if (msg.type === 'ABORT_SESSION') {
			_aborted = true;
			_sessionRunning = false;
			sendResponse({ ok: true });
		} else if (msg.type === 'PING') {
			sendResponse({
				ok: true,
				url: window.location.href,
				onEntryPage: !!document.querySelector(SEL.briefingCheckbox),
			});
		}
	});

	console.log('[DGCA Filler] Content script loaded on', window.location.href);
})();