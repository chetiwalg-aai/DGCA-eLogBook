/**
dgca-filler-common.js
Shared helpers for DGCA portal filling.
*/
(function () {
'use strict';
const { sleep } = window.DGCA;

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
};

const ALERT_EVENT_NAME = 'dgca_alert_captured';
let _lastCapturedAlert = null;

window.addEventListener(ALERT_EVENT_NAME, (e) => {
  _lastCapturedAlert = e.detail.msg;
});

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

function $(sel) { return document.querySelector(sel); }

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

async function clickAddAndVerify() {
  const rowsBefore = countResultTableRows();
  const addBtn = await waitForSelector(SEL.addButton, 6000);
  _lastCapturedAlert = null;
  addBtn.click();

  const ALERT_WINDOW_MS = 4000;
  const ALERT_POLL_MS = 150;
  const alertDeadline = Date.now() + ALERT_WINDOW_MS;
  let alertText = null;
  while (Date.now() < alertDeadline) {
    await sleep(ALERT_POLL_MS);
    alertText = await detectAlert();
    if (alertText) break;
  }
  if (alertText) {
    await dismissModals();
    return { ok: false, error: `Portal validation error: ${alertText}` };
  }

  const VERIFY_TIMEOUT_MS = 3000;
  const verifyDeadline = Date.now() + VERIFY_TIMEOUT_MS;
  let rowsAfter = rowsBefore;
  while (Date.now() < verifyDeadline) {
    rowsAfter = countResultTableRows();
    if (rowsAfter > rowsBefore) break;
    await sleep(150);
  }
  if (rowsAfter <= rowsBefore) {
    const lateAlert = await detectAlert();
    if (lateAlert) {
      await dismissModals();
      return { ok: false, error: `Portal validation error (late): ${lateAlert}` };
    }
    return { ok: false, error: `Row was not added to the table (before: ${rowsBefore}, after: ${rowsAfter}).` };
  }
  return { ok: true };
}

function sendProgress(payload) {
  chrome.runtime.sendMessage({ type: 'FILL_PROGRESS', ...payload });
}

window.DGCA_FILLER = {
  SEL,
  detectAlert, dismissModals, waitForSelector, waitForSelectOptions,
  waitForOptionValue, waitForVisible, waitForFieldValue, selectByValue, selectByText,
  setDatePickerValue, typeIntoField, ensureCheckbox, countResultTableRows,
  resetFields, clickAddAndVerify, sendProgress
};
})();