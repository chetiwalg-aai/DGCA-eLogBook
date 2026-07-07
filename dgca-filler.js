/**
 * dgca-filler.js  (v2.2.0)
 * Runs on: https://www.dgca.gov.in/*
 */
(function () {
  'use strict';

  const {
    getStationValue, getRatingValue, getWsoValue,
    getTypeOfDuty, resolveAtsUnit, resolveOjtEnv,
    parseDateDMY, formatDDMMYYYY, addOneDay, sleep,
    DUTY_TYPE,
  } = window.__DGCA__;

  // ── Selectors (all verified against portal HTML) ─────────────────────────────
  const SEL = {
    briefingCheckbox: '#isbriefingDone',
    fromDate: '#logBookDate',
    toDate: '#logBookEndDate',
    postingStation: '#postingStation',
    wsoEgcaId: '#atStoEgcaId',
    ratingId: '#ratingId',
    atsUnitId: '#atsUnitId',
    remarksField: '#ratingAndAtsRemarks',     // Remarks
    typeOfDutyId: '#typeOfDutyId',
    // Sub-fields inside #ojtFields (visible only for duty types 2,3,4,5,6)
    ojtFieldsDiv: '#ojtFields',
    ojtEnv: '#ojtOprEnvSmlation',       // Operational Environment/Simulation
    ojtTrainerName: '#ojtTrainerName',           // Name of OJTI/Trainer/Examiner (text)
    // Inside #examinerLicenseNumberDiv (shown when examiner ATCOL is required)
    examinerLicNumDiv: '#examinerLicenseNumberDiv',
    examinerAtcol: '#examinerLicenseNumber',    // Instructor/Examiner ATCOL No.
    // Inside #traineeLicenseNumberDiv
    traineeLicNumDiv: '#traineeLicenseNumberDiv',
    traineeAtcol: '#traineeLicenseNumber',     // Trainee ATCOL No.
    // Checkboxes inside ojtFields
    isProficiency: '#isProficiencyChecked',     // Proficiency Check (Examiner)
    isTheoryClasses: '#isTheoryClasses',          // Knowledge (Instruction theory)
    isSkillTest: '#isSkillTestChecked',        // Skill Test (Examiner)
    isOjtProvided: '#isOjtProvided',            // OJT Provided (Instruction practical)
    // Times
    startTime: '#ojtStartTime',
    endTime: '#ojtEndTime',
    // Add button & result table
    addButton: '#btnAddanssTrnTrainingDtlsVOList',
    resultTable: '#anssELogBookDtlsVOList',
  };

  // ── Alert detection ──────────────────────────────────────────────────────────
  const ALERT_EVENT_NAME = '__dgca_alert_captured__';
  let _lastCapturedAlert = null;

  window.addEventListener(ALERT_EVENT_NAME, (e) => {
    console.log('[DGCA Filler] Alert captured:', e.detail);
    _lastCapturedAlert = e.detail.msg;
  });

  async function detectAlert() {
    if (_lastCapturedAlert) {
      const msg = _lastCapturedAlert;
      _lastCapturedAlert = null;
      return msg;
    }
    const selectors = [
      '.swal2-popup:not(.swal2-toast)',
      '.modal.show',
      '.alertmsg:not([id^="alert_"]):not(:empty)',
      '.alert-danger:not(:empty)',
      '.error-msg:not(:empty)',
    ];
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
    document.querySelectorAll('.modal.show, .modal[style*="display: block"]')
      .forEach(m => { m.style.display = 'none'; m.classList.remove('show'); });
    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
    // Don't hide inline alertmsg spans — they may carry validation info
    await sleep(200);
  }

  // ── Core wait helpers ────────────────────────────────────────────────────────

  function $(sel) { return document.querySelector(sel); }

  /**
   * Wait for a DOM element to appear.
   */
  async function waitForSelector(sel, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(sel);
      if (el) return el;
      await sleep(80);
    }
    throw new Error(`Timeout waiting for element: ${sel}`);
  }

  /**
   * Wait for a <select> to have at least one non-placeholder option loaded.
   * Cascading dropdowns (WSO, Rating, ATS Unit) are populated via AJAX after
   * Posting Station changes — we must NOT set them until their options arrive.
   */
  async function waitForSelectOptions(sel, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(sel);
      if (el) {
        // Count real options (skip the "-1 / Please select" placeholder)
        const real = Array.from(el.options).filter(o => o.value && o.value !== '-1');
        if (real.length > 0) return el;
      }
      await sleep(120);
    }
    throw new Error(`Timeout waiting for options in: ${sel}`);
  }

  /**
   * Wait for a specific value to be available inside a <select>.
   * This guards against selecting a value that doesn't exist in the dropdown,
   * which would silently leave the field empty.
   */
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

  /**
   * Wait for a container div to become visible (display != none).
   * Used for #ojtFields, #examinerLicenseNumberDiv, etc., which are
   * shown/hidden by the portal's fnShowOjTFields() JS.
   */
  async function waitForVisible(sel, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(sel);
      if (el && getComputedStyle(el).display !== 'none') return el;
      await sleep(80);
    }
    throw new Error(`Timeout waiting for element to become visible: ${sel}`);
  }

  // ── Helper: wait for a readonly text input to have a non-empty value ──────────
  async function waitForFieldValue(selector, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = document.querySelector(selector);
      if (el && el.value && el.value.trim() !== '') return el;
      await sleep(100);
    }
    throw new Error(`Timeout waiting for value in: ${selector}`);
  }

  // ── Selectpicker-aware set ───────────────────────────────────────────────────
  /**
   * Set a <select> value and update the Bootstrap selectpicker widget.
   * The portal uses selectpicker heavily; setting .value alone is NOT enough —
   * the underlying jQuery widget won't update and the page validation will
   * see the old value.
   */
  async function selectByValue(selector, value) {
    // Wait for the option to actually be present in the DOM
    const el = await waitForOptionValue(selector, value);

    el.value = value;
    // Fire native events first
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));

    // Then update the selectpicker widget
    if (window.jQuery) {
      try {
        const $el = window.jQuery(el);
        if (typeof $el.selectpicker === 'function') {
          $el.selectpicker('val', value);
          $el.selectpicker('refresh');
        }
      } catch (_) { }
    }
    // Small pause to allow the portal's onChange handler to run
    await sleep(150);
  }

  /**
   * Set a date picker. The portal uses a lightweight single-date picker
   * (not daterangepicker in this form). We set the value and fire events.
   */
  async function setDatePickerValue(selector, dateStr) {
    const el = await waitForSelector(selector);
    el.value = dateStr;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    // Run onblur handler if present (portal uses inline onblur="checkdate(…)")
    if (el.onblur) {
      try { el.onblur(); } catch (_) { }
    }
    await sleep(100);
  }

  /**
   * Type into a plain text field (time, ATCOL, etc.).
   * The portal's time fields have onblur validation; we must fire blur.
   */
  async function typeIntoField(selector, text) {
    const el = await waitForSelector(selector);
    el.value = '';
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    await sleep(30);
    el.value = String(text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    // Trigger the inline onblur (checkTime / setTotalTimeDuration)
    if (el.onblur) {
      try { el.onblur(); } catch (_) { }
    }
    await sleep(80);
  }

  /**
   * Click a checkbox only if it is not already in the desired state,
   * and only if it is visible (the portal hides/shows sub-checkboxes).
   */
  async function ensureCheckbox(selector, shouldBeChecked) {
    const el = await waitForSelector(selector);
    if (getComputedStyle(el).display === 'none') return; // not applicable
    if (el.checked !== shouldBeChecked) {
      el.click();
      await sleep(100);
    }
  }

  /**
   * Return the number of rows the portal has accepted into the logbook table.
   *
   * The portal does NOT use a <tbody> — added rows are injected directly into
   * <thead> as <tr id="rowN">, so querySelectorAll('tbody tr') always returns 0.
   * This was the root cause of the false-error bug.
   *
   * The authoritative count is the hidden input #anssELogBookDtlsVOListcounter
   * whose integer value is incremented by fnAddanssTrnTrainingDtlsVOList() on
   * every successful add (e.g. value="1" after the first row is accepted).
   *
   * Falls back to counting <tr id="rowN"> elements inside the table in case
   * the counter field is missing from the page.
   */
  function countResultTableRows() {
    const counter = document.querySelector('#anssELogBookDtlsVOListcounter');
    if (counter) {
      const n = parseInt(counter.value, 10);
      return isNaN(n) ? 0 : n;
    }
    // Fallback: count <tr id="rowN"> directly inside the table
    const tbl = document.querySelector(SEL.resultTable);
    if (!tbl) return 0;
    return tbl.querySelectorAll('tr[id^="row"]').length;
  }

  // ── Reset form between rows ──────────────────────────────────────────────────
  async function resetFields() {
    try {
      _lastCapturedAlert = null;   // discard any stale alert before resetting
      await dismissModals();
      // Click the portal's own Reset button — most reliable way to clear all state
      const resetBtn = document.querySelector('#btnResetanssTrnTrainingDtlsVOList');
      if (resetBtn) {
        resetBtn.click();
        await sleep(400);
      } else {
        // Fallback: clear date and time fields manually
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

  // ── Fill a single row ────────────────────────────────────────────────────────
  async function fillRow(row, useAts = false) {
    const {
      date, station, atsUnit, remarks,
      timeFrom, timeTo, dutyType, nameOjti,
    } = row;

    const instructorAtcol = row.instructorAtcol || window.__DGCA__.getAtcol(nameOjti);

    const stationCode = String(station || 'VIJP').trim().toUpperCase();
    const atsUnitRaw = String(atsUnit || 'ADC').trim().toUpperCase();
    const postingStationVal = getStationValue(stationCode);
    const ratingVal = getRatingValue(atsUnitRaw);
    const wsoVal = getWsoValue(stationCode, useAts);
    const atsUnitVal = resolveAtsUnit(remarks, stationCode);
    const ojtEnvVal = resolveOjtEnv(remarks);
    const typeOfDutyVal = getTypeOfDuty(dutyType);

    const { d, m, y } = parseDateDMY(date);
    const fromDateStr = formatDDMMYYYY(d, m, y);
    const toDateStr = (timeTo === '00:00')
      ? (() => { const n = addOneDay(d, m, y); return formatDDMMYYYY(n.d, n.m, n.y); })()
      : fromDateStr;

    // ── 1. Briefing checkbox ─────────────────────────────────────────────────
    await ensureCheckbox(SEL.briefingCheckbox, true);

    // ── 2–3. Dates ───────────────────────────────────────────────────────────
    await setDatePickerValue(SEL.fromDate, fromDateStr);
    await setDatePickerValue(SEL.toDate, toDateStr);

    // ── 4. Posting Station → triggers AJAX to populate WSO + Rating + ATS Unit
    await selectByValue(SEL.postingStation, postingStationVal);
    await waitForFieldValue('#letterIcaoCode');
    // Wait for WSO dropdown to receive its options (AJAX-loaded)
    await waitForSelectOptions(SEL.wsoEgcaId);

    // ── 5. WSO / EGCA-Id ────────────────────────────────────────────────────
    await selectByValue(SEL.wsoEgcaId, wsoVal);

    // ── 6. Rating → triggers AJAX to populate ATS Unit options ──────────────
    await selectByValue(SEL.ratingId, ratingVal);
    // ATS Unit options depend on the selected Rating (changeAtsUnitIdOptions)
    await waitForSelectOptions(SEL.atsUnitId);

    // ── 7. ATS Unit ──────────────────────────────────────────────────────────
    await selectByValue(SEL.atsUnitId, atsUnitVal);

    // ── 8. Type of Duty → triggers fnShowOjTFields() to show/hide #ojtFields
    await selectByValue(SEL.typeOfDutyId, typeOfDutyVal);

    // ── 9. Duty-type-specific sub-fields ────────────────────────────────────
    //
    // The portal renders ALL sub-fields inside #ojtFields which is shown/hidden
    // by fnShowOjTFields() based on typeOfDutyId value.
    //
    // Duty type → portal value → sub-fields required:
    //   1 = Operation Duty (Control)    → no ojtFields shown
    //   2 = Instruction                 → ojtFields shown
    //                                     isOjtProvided checkbox (OJT Practical)
    //                                     isTheoryClasses checkbox (Knowledge/Theory)
    //                                     examinerAtcol (if practical)
    //   3 = OJT (On Job Training)       → ojtFields shown
    //                                     ojtEnv (Operational Env/Simulation)
    //                                     examinerAtcol (Instructor's ATCOL)
    //   4 = Examiner Functions          → ojtFields shown
    //                                     isProficiency or isSkillTest checkbox
    //                                     examinerAtcol
    //   5 = Classroom Training/Theory   → no additional sub-fields
    //   6 = Skill test                  → ojtFields shown
    //                                     examinerAtcol
    //   7 = Familiarisation             → ojtFields shown
    //   8 = ART                         → ojtFields shown

    const needsOjtFields = !['1', '5'].includes(typeOfDutyVal);



    if (dutyType === DUTY_TYPE.OJT_TRAINING_PRACTICAL) {
      // Trainee doing OJT in Operational Environment
      // duty='3', must set environment dropdown AND instructor's ATCOL
      if (needsOjtFields) {
        // Wait for the ojtFields div to become visible — fnShowOjTFields() runs async
        await waitForVisible(SEL.ojtFieldsDiv);
      }
      await selectByValue(SEL.ojtEnv, ojtEnvVal);
      if (instructorAtcol) {
        // examinerLicenseNumberDiv must be visible
        await waitForVisible(SEL.examinerLicNumDiv);
        await typeIntoField(SEL.examinerAtcol, instructorAtcol);
        await waitForFieldValue('#ojtTrainerName');
      }
    }

    if (dutyType === DUTY_TYPE.OJT_INSTR_PRACTICAL) {
      await ensureCheckbox(SEL.isOjtProvided, true);
      if (needsOjtFields) {
        await waitForVisible(SEL.ojtFieldsDiv);
      }
      await selectByValue(SEL.ojtEnv, ojtEnvVal);

      if (needsOjtFields) {
        await waitForVisible(SEL.ojtFieldsDiv);
      }
      const traineeAtcol = row.practicalTraineeAtcol || window.__DGCA__.getAtcol(row.pNameTrainee);

      if (traineeAtcol) {
        await waitForVisible(SEL.traineeLicNumDiv);
        await typeIntoField(SEL.traineeAtcol, traineeAtcol);
        await waitForFieldValue('#nameOfInstructor');
      }
    }

    if (dutyType === DUTY_TYPE.OJT_INSTR_THEORY) {
      await ensureCheckbox(SEL.isTheoryClasses, true);
      const traineeAtcol = row.theoryTraineeAtcol || window.__DGCA__.getAtcol(row.tNameTrainee);
      await typeIntoField(SEL.remarksField, `${row.tNameTrainee} (${traineeAtcol})`);
    }

    if (dutyType === DUTY_TYPE.EXAMINER_SKILL_TEST || dutyType === DUTY_TYPE.SKILL_ASSESSMENT) {
      // Examiner conducting Skill Test — duty='4' or '6'
      // Tick isSkillTestChecked; it's inside #isSkillTestCheckedfields
      // Note: #isSkillTestCheckedfields has display:none by default;
      // fnShowOjTFields() should show it for duty=4. For duty=6 it may differ.
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
      // Examiner conducting Proficiency Check — duty='4'
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
      // Examiner conducting Knowledge test — duty='4'
      // Tick isTheoryClasses as the "Knowledge" indicator
      await ensureCheckbox(SEL.isTheoryClasses, true);
      if (instructorAtcol) {
        await waitForVisible(SEL.examinerLicNumDiv);
        await typeIntoField(SEL.examinerAtcol, instructorAtcol);
      }
    }

    // ── 10. Times (always required) ──────────────────────────────────────────
    await typeIntoField(SEL.startTime, timeFrom);
    await typeIntoField(SEL.endTime, timeTo);

    // Small pause to let setTotalTimeDuration() fire
    await sleep(300);
  }

  // ── Click Add + dual verification ────────────────────────────────────────────
  /**
   * Two-layer success check:
   *   Layer 1 — alert interception (catches validation errors from the portal)
   *   Layer 2 — row count in #anssELogBookDtlsVOList (confirms the row was added)
   *
   * If the row count does not increase after Add, we treat it as an error even
   * if no alert was emitted (handles silent failures).
   */
  async function clickAddAndVerify() {
    const rowsBefore = countResultTableRows();

    const addBtn = await waitForSelector(SEL.addButton, 6000);
    _lastCapturedAlert = null; // clear any stale alert before clicking

    addBtn.click();

    // Phase 1: watch for alerts (portal fires these on validation failure)
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

    // Phase 2: verify the row was actually added to the table
    // Give the portal up to 3 s to append the new row
    const VERIFY_TIMEOUT_MS = 3000;
    const verifyDeadline = Date.now() + VERIFY_TIMEOUT_MS;
    let rowsAfter = rowsBefore;

    while (Date.now() < verifyDeadline) {
      rowsAfter = countResultTableRows();
      if (rowsAfter > rowsBefore) break;
      await sleep(150);
    }

    if (rowsAfter <= rowsBefore) {
      // Check once more for a delayed alert
      const lateAlert = await detectAlert();
      if (lateAlert) {
        await dismissModals();
        return { ok: false, error: `Portal validation error (late): ${lateAlert}` };
      }
      return {
        ok: false,
        error: `Row was not added to the table (before: ${rowsBefore}, after: ${rowsAfter}). The portal may have silently rejected it.`,
      };
    }

    console.log(`[DGCA Filler] Row added ✓ (table: ${rowsBefore} → ${rowsAfter})`);
    return { ok: true };
  }

  // ── Main session loop ────────────────────────────────────────────────────────
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

      // Reset the form before filling so we always start from a clean slate.
      // This also clears _lastCapturedAlert so no stale alert from the
      // previous row's success/failure bleeds into this row's verification.
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

      await chrome.storage.session.set({
        dgca_row_status: [...statuses],
        dgca_row_errors: { ...errors },
      });
    }

    _sessionRunning = false;
    const done = statuses.filter(s => s === 'submitted').length;
    const errCnt = statuses.filter(s => s === 'error').length;
    sendProgress({ type: 'session-complete', total: rows.length, done, errors: errCnt });
  }

  function sendProgress(payload) {
    chrome.runtime.sendMessage({ type: 'FILL_PROGRESS', ...payload });
  }

  // ── Message listener ─────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START_FILLING') {
      if (_sessionRunning) {
        sendResponse({ ok: false, error: 'Session already running' });
        return;
      }
      runSession(msg.rows)
        .catch(err => sendProgress({ type: 'session-error', error: err.message }));
      sendResponse({ ok: true });
    } else if (msg.type === 'ABORT_SESSION') {
      _aborted = true;
      _sessionRunning = false;
      sendResponse({ ok: true });
    } else if (msg.type === 'PING') {
      sendResponse({ ok: true, url: window.location.href });
    }
  });

  console.log('[DGCA Filler v2.2.0] Content script loaded on', window.location.href);
})();