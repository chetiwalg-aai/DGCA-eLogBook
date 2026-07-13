/**
dgca-filler.js
Runs on: https://www.dgca.gov.in/*
Handles filling for rows where source === 'mylogbook' (or undefined)
*/
(function () {
'use strict';
const {
  getStationValue, getRatingValue, getWsoValue,
  getTypeOfDuty, resolveAtsUnit, resolveOjtEnv,
  parseDateDMY, formatDDMMYYYY, addOneDay, sleep,
  DUTY_TYPE,
} = window.DGCA;
const {
  SEL, waitForSelector, waitForSelectOptions, waitForVisible,
  waitForFieldValue, selectByValue, setDatePickerValue, typeIntoField,
  ensureCheckbox, resetFields, clickAddAndVerify, sendProgress
} = window.DGCA_FILLER;

async function selectWsoOrAts(selector, stationCode, useAts) {
  const entry = window.DGCA.WSO_MAP[String(stationCode || '').trim().toUpperCase()];
  const el = await waitForSelector(selector);
  if (entry) {
    const targetVal = useAts ? entry.ATS : entry.WSO;
    const exactMatch = Array.from(el.options).find(o => o.value === targetVal);
    if (exactMatch) {
      await selectByValue(selector, targetVal);
      return;
    }
  }
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
  const { date, station, atsUnit, remarks, timeFrom, timeTo, dutyType, nameOjti } = row;
  const instructorAtcol = row.instructorAtcol || window.DGCA.getAtcol(nameOjti);
  const stationCode = String(station || 'VIJP').trim().toUpperCase();
  const postingStationVal = getStationValue(stationCode);
  const ratingVal = getRatingValue(atsUnit);
  const atsUnitVal = resolveAtsUnit(remarks, stationCode);
  const ojtEnvVal = resolveOjtEnv(remarks);
  const typeOfDutyVal = getTypeOfDuty(dutyType);
  const { d, m, y } = parseDateDMY(date);
  const fromDateStr = formatDDMMYYYY(d, m, y);
  const toDateStr = (timeTo === '00:00')
    ? (() => { const n = addOneDay(d, m, y); return formatDDMMYYYY(n.d, n.m, n.y); })()
    : fromDateStr;

  await ensureCheckbox(SEL.briefingCheckbox, true);
  await setDatePickerValue(SEL.fromDate, fromDateStr);
  await setDatePickerValue(SEL.toDate, toDateStr);
  await selectByValue(SEL.postingStation, postingStationVal);
  await waitForFieldValue('#letterIcaoCode');
  await waitForSelectOptions(SEL.wsoEgcaId);
  await selectWsoOrAts(SEL.wsoEgcaId, stationCode, useAts);
  await selectByValue(SEL.ratingId, ratingVal);
  await waitForSelectOptions(SEL.atsUnitId);
  await selectByValue(SEL.atsUnitId, atsUnitVal);
  await selectByValue(SEL.typeOfDutyId, typeOfDutyVal);

  const needsOjtFields = !['1', '7'].includes(typeOfDutyVal);
  
  if (dutyType === DUTY_TYPE.OJT_TRAINING_PRACTICAL) {
    if (needsOjtFields) await waitForVisible(SEL.ojtFieldsDiv);
    await selectByValue(SEL.ojtEnv, ojtEnvVal);
    if (instructorAtcol) {
      await waitForVisible(SEL.examinerLicNumDiv);
      await typeIntoField(SEL.examinerAtcol, instructorAtcol);
      await waitForFieldValue('#ojtTrainerName');
    }
  }
  if (dutyType === DUTY_TYPE.OJT_TRAINING_THEORY) {
    if (needsOjtFields) await waitForVisible(SEL.ojtFieldsDiv);
    if (instructorAtcol) {
      await waitForVisible(SEL.examinerLicNumDiv);
      await typeIntoField(SEL.examinerAtcol, instructorAtcol);
      await waitForFieldValue('#ojtTrainerName');
    }
  }
  if (dutyType === DUTY_TYPE.OJT_INSTR_PRACTICAL) {
    await ensureCheckbox(SEL.isOjtProvided, true);
    if (needsOjtFields) await waitForVisible(SEL.ojtFieldsDiv);
    await selectByValue(SEL.ojtEnv, ojtEnvVal);
    const traineeAtcol = row.practicalTraineeAtcol || window.DGCA.getAtcol(row.pNameTrainee);
    if (traineeAtcol) {
      await waitForVisible(SEL.traineeLicNumDiv);
      await typeIntoField(SEL.traineeAtcol, traineeAtcol);
      await waitForFieldValue('#nameOfInstructor');
    }
  }
  if (dutyType === DUTY_TYPE.OJT_INSTR_THEORY) {
    await ensureCheckbox(SEL.isTheoryClasses, true);
    const traineeAtcol = row.theoryTraineeAtcol || window.DGCA.getAtcol(row.tNameTrainee);
    await typeIntoField(SEL.remarksField, `${row.tNameTrainee} (${traineeAtcol})`);
  }
  if (dutyType === DUTY_TYPE.EXAMINER_SKILL_TEST || dutyType === DUTY_TYPE.SKILL_ASSESSMENT) {
    const stDiv = document.querySelector('#isSkillTestCheckedfields');
    if (stDiv && getComputedStyle(stDiv).display !== 'none') {
      await ensureCheckbox(SEL.isSkillTest, true);
    }
    if (instructorAtcol) {
      await waitForVisible(SEL.examinerLicNumDiv);
      await typeIntoField(SEL.examinerAtcol, instructorAtcol);
    }
  }
  if (dutyType === DUTY_TYPE.EXAMINER_PROF_CHECK) {
    const pfDiv = document.querySelector('#opretionalFields');
    if (pfDiv && getComputedStyle(pfDiv).display !== 'none') {
      await ensureCheckbox(SEL.isProficiency, true);
    }
    if (instructorAtcol) {
      await waitForVisible(SEL.examinerLicNumDiv);
      await typeIntoField(SEL.examinerAtcol, instructorAtcol);
    }
  }
  if (dutyType === DUTY_TYPE.EXAMINER_KNOWLEDGE) {
    await ensureCheckbox(SEL.isTheoryClasses, true);
    if (instructorAtcol) {
      await waitForVisible(SEL.examinerLicNumDiv);
      await typeIntoField(SEL.examinerAtcol, instructorAtcol);
    }
  }

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
  const _atsData = await chrome.storage.session.get(['dgca_use_ats']).catch(() => ({}));
  const useAts = !!(_atsData?.dgca_use_ats);
  await chrome.storage.session.set({ dgca_row_status: statuses });

  for (let i = 0; i < rows.length; i++) {
    if (_aborted) break;
    const row = rows[i];
    statuses[i] = 'filling';
    await chrome.storage.session.set({ dgca_row_status: [...statuses] });
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
    await chrome.storage.session.set({ dgca_row_status: [...statuses], dgca_row_errors: { ...errors } });
  }
  
  _sessionRunning = false;
  const done = statuses.filter(s => s === 'submitted').length;
  const errCnt = statuses.filter(s => s === 'error').length;
  sendProgress({ status: 'session-complete', total: rows.length, done, errors: errCnt });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_FILLING_MYLOGBOOK') {
    if (_sessionRunning) { sendResponse({ ok: false, error: 'Session already running' }); return; }
    runSession(msg.rows).catch(err => sendProgress({ status: 'session-error', error: err.message }));
    sendResponse({ ok: true });
  } else if (msg.type === 'ABORT_SESSION') {
    _aborted = true;
    _sessionRunning = false;
    sendResponse({ ok: true });
  } else if (msg.type === 'PING') {
    sendResponse({ ok: true, url: window.location.href });
  }
});
console.log('[DGCA Filler (MyLogBook)] Content script loaded on', window.location.href);
})();