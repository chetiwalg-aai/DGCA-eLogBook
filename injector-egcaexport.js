// Runs on https://iamatc.aai.aero/atc/EGcAexport* — adds a single "Import
// Data to Queue" button next to the portal's native "Generate Preview"
// button, pushing every data row currently in the preview table into the
// shared queue that dgca-filler.js's toolbar reads on the DGCA portal.
//
// CHANGED: Each row has a checkbox (inside the FROM_DATE cell, which is
// already contenteditable="true", Only checked rows are imported.
(function () {
    'use strict';

    const { sortQueue } = window.DGCA;

    function normaliseEgcaDate(dateStr) {
        const s = String(dateStr || '').trim();
        if (/^\d{2}-\d{2}-\d{4}$/.test(s)) return s;
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s.replace(/\//g, '-');
        return s;
    }

    function rowId(date, station, timeFrom, timeTo, dutyType) {
        return `${date}|${station}|${timeFrom}|${timeTo}|${dutyType}`;
    }

    // readCellValue is UNCHANGED — <input type="checkbox"> has no
    // textContent, so td.textContent.trim() still returns just the
    // cell's data text even with our checkbox inside the <td>.
    function readCellValue(td) {
        const select = td.querySelector('select');
        if (select) return select.value;
        return td.textContent.trim();
    }

    // CHANGED: skip the native checkbox column (<th> containing the
    // #selectAllRows checkbox) so headers stay aligned with the real data
    // columns, matching how downloadEgcaCsv() reads the table.
    function getTableHeaders(table) {
        const thead = table.querySelector('thead');
        if (!thead) return [];
        const headerRow = thead.querySelector('tr');
        if (!headerRow) return [];
        return Array.from(headerRow.querySelectorAll('th'))
            .filter(th => !th.querySelector('input[type="checkbox"]'))
            .map(th => th.textContent.trim());
    }

    // CHANGED: skip the native checkbox <td> so cells stay aligned with
    // the headers returned by getTableHeaders above.
    function readRowByHeaders(tr, headers) {
        const cells = Array.from(tr.children)
            .filter(el => el.tagName === 'TD' && !el.querySelector('input.row-select-cb'));
        const raw = {};
        headers.forEach((name, i) => {
            const td = cells[i];
            raw[name] = td ? readCellValue(td) : '';
        });
        return raw;
    }

    // ── NEW: native checkbox helpers ───────────────────────────────────
    function hasNativeCheckboxes(table) {
        return !!table.querySelector('tbody input.row-select-cb');
    }

    function getRowCheckbox(tr) {
        return tr.querySelector('td input.row-select-cb');
    }

    function syncSelectAllHeaderCheckbox(table) {
        const headerCb = table.querySelector('thead input#selectAllRows');
        if (!headerCb) return;
        const rowCbs = Array.from(table.querySelectorAll('tbody input.row-select-cb'));
        headerCb.checked = rowCbs.length > 0 && rowCbs.every(cb => cb.checked);
    }

    function parseRow(tr, headers) {
        const raw = readRowByHeaders(tr, headers);
        const rawFromDate = raw['FROM_DATE'] || '';
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(rawFromDate)) return null;
        const date = normaliseEgcaDate(rawFromDate);
        const station = (raw['ICAO_CODE'] || '').trim().toUpperCase();
        const timeFrom = raw['START_TIME'] || '';
        const timeTo = raw['END_TIME'] || '';
        const dutyType = raw['TYPE_OF_DUTY'] || '';
        raw['FROM_DATE'] = date;
        if (raw['TO_DATE']) raw['TO_DATE'] = normaliseEgcaDate(raw['TO_DATE']);
        return { id: rowId(date, station, timeFrom, timeTo, dutyType), date, ...raw };
    }

    function getDataRowsFromTable(table) {
        const headers = getTableHeaders(table);
        if (headers.length === 0) return [];
        const rows = [];
        table.querySelectorAll('tbody tr').forEach(tr => {
            const row = parseRow(tr, headers);
            if (row) rows.push(row);
        });
        return rows;
    }

    // ══════════════════════════════════════════════════════════════════
    //  NEW — Row selection state & checkbox injection
    // ══════════════════════════════════════════════════════════════════

    const _rowSelection = new Map(); // rowId → boolean

    function getSelectedCount() {
        let n = 0;
        _rowSelection.forEach(v => { if (v) n++; });
        return n;
    }

    function pruneStaleSelection(currentRowIds) {
        const live = new Set(currentRowIds);
        for (const id of _rowSelection.keys()) {
            if (!live.has(id)) _rowSelection.delete(id);
        }
    }

    // ── Checkbox CSS ──────────────────────────────────────────────────
    function injectCheckboxStyle() {
        if (document.getElementById('dgca-checkbox-style')) return;
        const style = document.createElement('style');
        style.id = 'dgca-checkbox-style';
        style.textContent = `
            /* Click-to-select mode */
            tr.dgca-row-clickable { cursor: pointer; }
            tr.dgca-row-clickable.dgca-row-selected > td.editable {
                background-color: rgba(76, 175, 80, 0.16) !important;
            }
            tr.dgca-row-clickable.dgca-row-selected > td.editable:first-of-type {
                border-left: 3px solid #4caf50 !important;
            }
            /* Panel Select All / Deselect All */
            .dgca-sel-actions { display: flex; gap: 5px; }
            .dgca-selall-btn {
                flex: 1; border: none; border-radius: 5px;
                padding: 4px 6px; font-size: 10px; font-weight: 600;
                cursor: pointer; background: #23233a;
                border: 1px solid #4a4a6e !important; color: #cfd3e0;
                transition: opacity .15s, filter .15s;
            }
            .dgca-selall-btn:hover { filter: brightness(1.15); }
        `;
        document.head.appendChild(style);
    }

    // Sync panel badge + import button label with selection count.
    function updateSelectionDisplay() {
        const table = document.querySelector('table');
        const total = table ? getDataRowsFromTable(table).length : 0;
        const selected = getSelectedCount();

        document.querySelectorAll('.dgca-row-count').forEach(badge => {
            if (total > 0) {
                badge.textContent = `${selected} of ${total} selected`;
            } else {
                badge.textContent = '';
            }
        });

        document.querySelectorAll('.dgca-select-hint').forEach(hint => {
            hint.classList.toggle('dgca-select-hint--visible', total > 0);
            hint.textContent = (table && hasNativeCheckboxes(table))
                ? '⚠ Untick the checkboxes for rows you don\'t want to import.'
                : '⚠ Click rows to select/deselect for import.';
        });

        document.querySelectorAll('.dgca-send-btn').forEach(btn => {
            btn.textContent = selected > 0
                ? `📥 Import ${selected}`
                : '📥 Import';
        });
    }

    // ── Lock cell editing ────────────────────────────────────────────
    // The page marks most <td class="editable"> as contenteditable="true",
    // but users should not actually be able to type into them — only the
    // dropdown (<select>) cells, where present, remain interactive.
    function lockEditableCells(table) {
        table.querySelectorAll('tbody td.editable').forEach(td => {
            if (td.querySelector('select')) return; // leave dropdown cells alone
            if (td.getAttribute('contenteditable') === 'false') return; // already locked
            td.setAttribute('contenteditable', 'false');
            td.style.userSelect = 'none';
            td.style.cursor = 'default';
        });
    }

    // ── NEW: wire up the site's native per-row checkboxes ──────────────
    // Preferred path now that the portal renders its own <input
    // type="checkbox" class="row-select-cb"> in each row (plus a
    // #selectAllRows header checkbox). We just lock the editable cells
    // (unrelated to selection) and mirror checkbox state into
    // _rowSelection so the rest of the code (getSelectedCount,
    // onImportClick, etc.) keeps working unchanged.
    function enableNativeSelection(table) {
        lockEditableCells(table);
        const headers = getTableHeaders(table);
        const trs = Array.from(table.querySelectorAll('tbody tr'));

        for (const tr of trs) {
            const row = parseRow(tr, headers);
            if (!row) continue;
            const cb = getRowCheckbox(tr);
            if (!cb) continue;

            _rowSelection.set(row.id, cb.checked);
            // Never leave stale click-to-select styling behind if the
            // page previously rendered without native checkboxes.
            tr.classList.remove('dgca-row-clickable', 'dgca-row-selected');

            if (cb.dataset.dgcaChangeBound) continue;
            cb.dataset.dgcaChangeBound = '1';

            cb.addEventListener('change', function () {
                _rowSelection.set(row.id, cb.checked);
                syncSelectAllHeaderCheckbox(table);
                updateSelectionDisplay();
            });
        }

        syncSelectAllHeaderCheckbox(table);
        updateSelectionDisplay();
    }

    // ── Click-to-select on <tr> (CSS fallback) ──────────────────────────
    // Kept as a backup for cases where the portal doesn't render its own
    // checkboxes (e.g. an older page version). Only used when
    // hasNativeCheckboxes(table) is false.
    function enableFallbackSelection(table) {
        if (hasNativeCheckboxes(table)) {
            enableNativeSelection(table);
            return;
        }

        lockEditableCells(table);
        const headers = getTableHeaders(table);
        const trs = Array.from(table.querySelectorAll('tbody tr'));

        for (const tr of trs) {
            const row = parseRow(tr, headers);
            if (!row) continue;
            if (!_rowSelection.has(row.id)) _rowSelection.set(row.id, false);

            tr.classList.add('dgca-row-clickable');
            tr.classList.toggle('dgca-row-selected', _rowSelection.get(row.id));

            // Guard against re-binding the click listener if this same
            // <tr> is re-processed (e.g. by the repeat-run in the observer).
            if (tr.dataset.dgcaClickBound) continue;
            tr.dataset.dgcaClickBound = '1';

            tr.addEventListener('click', function (e) {
                if (e.target.closest('select, input, a, button, textarea')) return;
                const current = _rowSelection.get(row.id) ?? false;
                _rowSelection.set(row.id, !current);
                this.classList.toggle('dgca-row-selected', !current);
                updateSelectionDisplay();
            }, true);
        }

        updateSelectionDisplay();
    }

    // ── Panel-level Select All / Deselect All ─────────────────────────
    function selectAllRows() {
        const table = document.querySelector('table');
        if (table && hasNativeCheckboxes(table)) {
            table.querySelectorAll('tbody input.row-select-cb').forEach(cb => { cb.checked = true; });
            const headerCb = table.querySelector('thead input#selectAllRows');
            if (headerCb) headerCb.checked = true;
        }
        _rowSelection.forEach((_, id) => _rowSelection.set(id, true));
        if (!table) { updateSelectionDisplay(); return; }

        table.querySelectorAll('tbody tr.dgca-row-clickable')
            .forEach(tr => tr.classList.add('dgca-row-selected'));
        updateSelectionDisplay();
    }

    function deselectAllRows() {
        const table = document.querySelector('table');
        if (table && hasNativeCheckboxes(table)) {
            table.querySelectorAll('tbody input.row-select-cb').forEach(cb => { cb.checked = false; });
            const headerCb = table.querySelector('thead input#selectAllRows');
            if (headerCb) headerCb.checked = false;
        }
        _rowSelection.forEach((_, id) => _rowSelection.set(id, false));
        if (!table) { updateSelectionDisplay(); return; }

        table.querySelectorAll('tbody tr.dgca-row-clickable')
            .forEach(tr => tr.classList.remove('dgca-row-selected'));
        updateSelectionDisplay();
    }

    // ══════════════════════════════════════════════════════════════════
    //  Existing helpers (unchanged except where noted)
    // ══════════════════════════════════════════════════════════════════

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
        return !!(existingRowCount > 0 && queueUser && currentUser &&
            queueUser.loginId && currentUser.loginId &&
            queueUser.loginId !== currentUser.loginId);
    }

    let _queuedRowCount = 0;
    let _previewRowCount = 0;
    let _previewRowsEverSeen = false;

    function updatePanelVisibility() {
        const panel = document.getElementById('dgca-panel');
        if (!panel) return;
        const hasData = _queuedRowCount > 0 || _previewRowCount > 0;
        panel.classList.toggle('dgca-panel--hidden', !hasData);
    }

    // ── injects click-to-select behaviour, shows selection count ───────
    function refreshRowCountBadge() {
        const table = document.querySelector('table');
        const count = table ? getDataRowsFromTable(table).length : 0;
        _previewRowCount = count;

        if (table && count > 0) {
            const allRows = getDataRowsFromTable(table);
            allRows.forEach(r => {
                if (!_rowSelection.has(r.id)) _rowSelection.set(r.id, false);
            });
            pruneStaleSelection(allRows.map(r => r.id));

            enableFallbackSelection(table);
        }

        updateSelectionDisplay();
        updatePanelVisibility();

        if (count > 0 && !_previewRowsEverSeen) {
            _previewRowsEverSeen = true;
            const panel = document.getElementById('dgca-panel');
            if (panel) setPanelMinimized(panel, false);
        }
    }

    async function refreshUserMismatchIndicator() {
        try {
            const warnEls = document.querySelectorAll('.dgca-user-warn');
            const clearBtns = document.querySelectorAll('.dgca-clear-queue-btn');
            const sendBtns = document.querySelectorAll('.dgca-send-btn');
            if (warnEls.length === 0 && clearBtns.length === 0 && sendBtns.length === 0) return;

            const data = await window.DGCA_STORAGE.get([
                'dgca_pending_rows', 'dgca_queue_user', 'dgca_session_running'
            ]);
            const existing = data?.dgca_pending_rows || [];
            const queueUser = data?.dgca_queue_user || null;
            const sessionRunning = !!data?.dgca_session_running;
            const current = getAaiUser();
            _queuedRowCount = existing.length;

            const mismatch = isUserMismatch(current, queueUser, existing.length);
            warnEls.forEach(warnEl => {
                if (mismatch) {
                    warnEl.textContent =
                        `⚠ Queue is for ${queueUser.name} — clear it before adding as ${current.name}`;
                    warnEl.style.display = 'inline-block';
                } else {
                    warnEl.style.display = 'none';
                }
            });
            clearBtns.forEach(btn => {
                btn.style.display = 'inline-block';
                btn.disabled = existing.length === 0 || sessionRunning;
                btn.title = sessionRunning
                    ? 'Cannot clear while a fill session is running on the DGCA tab' : '';
            });
            sendBtns.forEach(btn => {
                btn.disabled = sessionRunning;
                btn.title = sessionRunning
                    ? 'Cannot add to queue while a fill session is running on the DGCA tab' : '';
            });
            updatePanelVisibility();
        } catch (_) { }
    }

    async function clearQueue() {
        try {
            const data = await window.DGCA_STORAGE.get(['dgca_session_running']);
            if (data?.dgca_session_running) {
                showStatus(
                    'A fill session is running on the DGCA tab — wait for it to finish ' +
                    'or abort it there before clearing the queue.', 'error');
                refreshUserMismatchIndicator();
                return;
            }
        } catch (_) { }
        if (!confirm('Clear the entire DGCA queue?')) return;
        try {
            await window.DGCA_STORAGE.remove([
                'dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors',
                'dgca_row_timings', 'dgca_session_ts', 'dgca_queue_user',
            ]);
        } catch (err) {
            console.error('[DGCA] Failed to clear queue:', err);
            showStatus('Failed to clear queue. Please try again.', 'error');
        }
    }

    async function importRowsToQueue(newRows) {
        if (!newRows || newRows.length === 0) return { status: 'no_rows' };
        const currentUser = getAaiUser();
        const data = await window.DGCA_STORAGE.get([
            'dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors',
            'dgca_queue_user', 'dgca_session_running'
        ]);
        const existing = data?.dgca_pending_rows || [];
        const existingStatus = data?.dgca_row_status || [];
        const existingErrors = data?.dgca_row_errors || {};
        const queueUser = data?.dgca_queue_user || null;

        if (data?.dgca_session_running) {
            refreshUserMismatchIndicator();
            return { status: 'session_running' };
        }
        if (isUserMismatch(currentUser, queueUser, existing.length)) {
            refreshUserMismatchIndicator();
            return {
                status: 'user_mismatch',
                queueUserName: queueUser.name,
                currentUserName: currentUser.name
            };
        }

        const existingMap = {};
        existing.forEach((r, i) => { existingMap[r.id] = { row: r, index: i }; });
        const toAdd = newRows.filter(r => !existingMap[r.id]);
        if (toAdd.length === 0) return { status: 'already_queued', total: newRows.length };

        const rawMerged = [...existing, ...toAdd];
        const rawStatuses = [...existingStatus, ...toAdd.map(() => 'pending')];
        const { rows: merged, statuses: mergedStatus, errors: mergedErrors } =
            sortQueue(rawMerged, rawStatuses, existingErrors);
        const nextQueueUser = currentUser || queueUser || null;

        await window.DGCA_STORAGE.set({
            dgca_pending_rows: merged,
            dgca_row_status: mergedStatus,
            dgca_row_errors: mergedErrors,
            dgca_session_ts: Date.now(),
            dgca_queue_user: nextQueueUser,
        });
        return { status: 'ok', added: toAdd.length, total: merged.length };
    }

    function applyImportResultUI(result) {
        switch (result.status) {
            case 'no_rows':
                showStatus('No data rows found in the preview table. Click "Generate Preview" first.', 'error');
                return;
            case 'session_running':
                showStatus('A fill session is running on the DGCA tab — wait for it to finish or abort it there before adding more rows.', 'error');
                return;
            case 'user_mismatch':
                showStatus(`Queue is for ${result.queueUserName} — clear it before adding as ${result.currentUserName}.`, 'error');
                return;
            case 'already_queued':
                showStatus(`All ${result.total} rows are already in the queue.`, 'success');
                return;
            case 'ok':
                showStatus(`✓ ${result.added} added (${result.total} total). Open the DGCA Entry Page to fill the entries.`, 'success');
                return;
        }
    }

    // ── CHANGED: Only imports SELECTED rows. ──────────────────────────
    function onImportClick() {
        const table = document.querySelector('table');
        if (!table) {
            showStatus('No preview table found. Click "Generate Preview" first.', 'error');
            return;
        }

        const allRows = getDataRowsFromTable(table);
        const selectedRows = allRows.filter(r => _rowSelection.get(r.id) === true);

        if (selectedRows.length === 0) {
            showStatus('No rows selected — check the rows you want to import.', 'error');
            return;
        }

        importRowsToQueue(selectedRows)
            .then(applyImportResultUI)
            .catch(err => {
                console.error('[DGCA] Failed to queue rows:', err);
                showStatus('Failed to save rows to queue. Please try again.', 'error');
            });
    }

    // ── Shimmer (unchanged) ───────────────────────────────────────────
    function injectShimmerStyle() {
        if (document.getElementById('dgca-ext-shimmer-style')) return;
        const style = document.createElement('style');
        style.id = 'dgca-ext-shimmer-style';
        style.textContent = `
            .dgca-ext-shimmer-btn { position: relative; overflow: hidden; }
            .dgca-ext-shimmer-btn:not(:disabled)::after {
                content: '';
                position: absolute; top: 0; left: 0; height: 100%; width: 50%;
                background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.65) 50%, rgba(255,255,255,0) 100%);
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

    function findGeneratePreviewButton() {
        const candidates = Array.from(
            document.querySelectorAll('button[type="submit"], button.btn-min'));
        return candidates.find(el =>
            el.textContent.trim().toLowerCase().includes('generate preview')) || null;
    }

    function ensurePreviewButtonShimmer() {
        const btn = findGeneratePreviewButton();
        if (btn && !btn.classList.contains('dgca-ext-shimmer-btn')) {
            btn.classList.add('dgca-ext-shimmer-btn');
        }
    }

    // ── Floating panel ────────────────────────────────────────────────
    const PANEL_POS_KEY = 'dgca_panel_pos';
    const PANEL_MIN_KEY = 'dgca_panel_min';

    function injectPanelStyle() {
        if (document.getElementById('dgca-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'dgca-panel-style';
        style.textContent = `
            .dgca-panel {
                position: fixed; z-index: 999997;
                width: 210px; max-width: calc(100vw - 16px);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 11px; background: #16213e; color: #e0e0e0;
                border: 1px solid #2a3a5e; border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0,0,0,.35); overflow: hidden;
            }
            .dgca-panel-header {
                display: flex; align-items: center; justify-content: space-between;
                gap: 6px; padding: 5px 5px 5px 8px;
                background: #1a2748; cursor: move; user-select: none;
                border-bottom: 1px solid #2a3a5e;
            }
            .dgca-panel.dgca-panel--min .dgca-panel-header { border-bottom: none; }
            .dgca-panel-title {
                font-weight: 700; font-size: 11px; white-space: nowrap;
                overflow: hidden; text-overflow: ellipsis;
            }
            .dgca-panel-controls { display: flex; align-items: center; gap: 2px; }
            .dgca-panel-iconbtn {
                width: 17px; height: 17px; border: none; background: transparent;
                color: #aab0c0; font-size: 11px; line-height: 1; border-radius: 4px;
                cursor: pointer; display: flex; align-items: center; justify-content: center;
            }
            .dgca-panel-iconbtn:hover { background: #2a3a5e; color: #fff; }
            .dgca-panel-body { padding: 7px; display: flex; flex-direction: column; gap: 6px; }
            .dgca-panel.dgca-panel--min .dgca-panel-body { display: none; }
            .dgca-panel-row-count { font-size: 10px; color: #8bc34a; font-weight: 600; }
            .dgca-select-hint {
                font-size: 10px; color: #cfa93a; font-weight: 600;
                display: none; line-height: 1.3;
            }
            .dgca-select-hint--visible { display: block; }
            .dgca-user-warn { font-size: 10px; color: #f28b82; font-weight: 600; display: none; }
            .dgca-panel-actions { display: flex; gap: 5px; }
            .dgca-panel-actions .dgca-send-btn,
            .dgca-panel-actions .dgca-clear-queue-btn {
                flex: 1; border: none; border-radius: 5px; padding: 5px 6px;
                font-size: 10px; font-weight: 600; cursor: pointer;
                transition: opacity .15s, filter .15s;
            }
            .dgca-panel-actions button:disabled { opacity: .4; cursor: not-allowed; }
            .dgca-panel-actions button:not(:disabled):hover { filter: brightness(1.15); }
            .dgca-send-btn { background: #4fc3f7; color: #0a0a14; }
            .dgca-clear-queue-btn {
                background: #23233a; border: 1px solid #4a4a6e !important; color: #cfd3e0;
            }
            .dgca-status-msg {
                font-size: 10px; font-weight: 600; line-height: 1.3;
                padding: 5px 6px; border-radius: 6px; display: none;
            }
            .dgca-status-msg--success {
                background: #1a3320; border: 1px solid #2e6b3e;
                color: #8ee6a0; display: block;
            }
            .dgca-status-msg--error {
                background: #3a1f1f; border: 1px solid #6b2e2e;
                color: #f28b82; display: block;
            }
            .dgca-panel--dragging { opacity: .9; }
            .dgca-panel--hidden { display: none !important; }

            /* Info (ⓘ) popover — appended to <body> (not the panel) so it
               isn't clipped by the panel's overflow:hidden, and positioned
               in JS relative to the info button. */
            .dgca-panel-info-popover {
                position: fixed; z-index: 999999;
                width: 220px; max-width: calc(100vw - 16px);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                background: #16213e; color: #cfd3e0;
                border: 1px solid #2a3a5e; border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0,0,0,.4);
                padding: 10px 12px; font-size: 11px; line-height: 1.5;
                display: none;
            }
            .dgca-panel-info-popover--open { display: block; }
            .dgca-panel-info-notice {
                display: flex; gap: 6px; align-items: flex-start;
                color: #f0c674; font-weight: 600; margin-bottom: 8px;
            }
            .dgca-panel-info-links a {
                display: flex; align-items: center; justify-content: center;
                gap: 6px;
                padding: 7px 10px;
                background: rgba(79, 195, 247, 0.12);
                border: 1px solid rgba(79, 195, 247, 0.45);
                border-radius: 6px;
                color: #7fd4ff; font-weight: 600; font-size: 11px;
                text-decoration: none; text-align: center;
                transition: background .15s, border-color .15s, color .15s;
            }
            .dgca-panel-info-links a:hover {
                background: rgba(79, 195, 247, 0.22);
                border-color: #4fc3f7;
                color: #fff;
            }
            .dgca-panel-info-links a .dgca-panel-info-arrow {
                transition: transform .15s;
            }
            .dgca-panel-info-links a:hover .dgca-panel-info-arrow {
                transform: translateX(2px);
            }
            .dgca-panel-info-credit {
                margin-top: 9px; padding-top: 8px; border-top: 1px solid #2a3a5e;
                text-align: center; font-size: 10px; color: #bdbdd7;
            }
            /* Same shimmer technique as the popup footer credit
               (popup.css .shimmer-text / .shimmer-text--footer). */
            .dgca-panel-info-credit .shimmer-text {
                --shimmer-base: #4fc3f7; --shimmer-hi: #ffffff;
                background-image: linear-gradient(90deg,
                    var(--shimmer-base) 0%, var(--shimmer-base) 40%,
                    var(--shimmer-hi) 50%,
                    var(--shimmer-base) 60%, var(--shimmer-base) 100%);
                background-size: 300% 100%;
                background-repeat: no-repeat;
                -webkit-background-clip: text;
                background-clip: text;
                -webkit-text-fill-color: transparent;
                color: transparent;
                display: inline-block;
                font-weight: 600;
                animation: dgca-panel-shimmer-text 7s linear infinite;
            }
            @keyframes dgca-panel-shimmer-text {
                from { background-position: 100% 0; }
                to   { background-position: 0% 0; }
            }
        `;
        document.head.appendChild(style);
    }

    function loadPanelPos() {
        try { return JSON.parse(sessionStorage.getItem(PANEL_POS_KEY) || 'null'); }
        catch (_) { return null; }
    }
    function savePanelPos(pos) {
        try { sessionStorage.setItem(PANEL_POS_KEY, JSON.stringify(pos)); } catch (_) { }
    }
    function loadPanelMinimized() {
        try {
            const v = localStorage.getItem(PANEL_MIN_KEY);
            return v === null ? true : v === '1';
        } catch (_) { return true; }
    }
    function savePanelMinimized(min) {
        try { localStorage.setItem(PANEL_MIN_KEY, min ? '1' : '0'); } catch (_) { }
    }

    function clampPanelPos(panel, left, top) {
        const margin = 8;
        const maxLeft = window.innerWidth - Math.min(panel.offsetWidth, 120) - margin;
        const maxTop = window.innerHeight - 40 - margin;
        return {
            left: Math.min(Math.max(left, margin), Math.max(maxLeft, margin)),
            top: Math.min(Math.max(top, margin), Math.max(maxTop, margin)),
        };
    }

    function makePanelDraggable(panel, header) {
        let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
        header.addEventListener('pointerdown', e => {
            if (e.target.closest('.dgca-panel-iconbtn')) return;
            dragging = true;
            panel.classList.add('dgca-panel--dragging');
            startX = e.clientX; startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startLeft = rect.left; startTop = rect.top;
            header.setPointerCapture(e.pointerId);
        });
        header.addEventListener('pointermove', e => {
            if (!dragging) return;
            const { left, top } = clampPanelPos(panel,
                startLeft + (e.clientX - startX), startTop + (e.clientY - startY));
            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });
        const stopDrag = () => {
            if (!dragging) return;
            dragging = false;
            panel.classList.remove('dgca-panel--dragging');
            savePanelPos({
                left: parseFloat(panel.style.left) || 0,
                top: parseFloat(panel.style.top) || 0
            });
        };
        header.addEventListener('pointerup', stopDrag);
        header.addEventListener('pointercancel', stopDrag);
    }

    function setPanelMinimized(panel, min) {
        panel.classList.toggle('dgca-panel--min', min);
        const btn = panel.querySelector('.dgca-panel-min-btn');
        if (btn) { btn.textContent = min ? '▢' : '—'; btn.title = min ? 'Expand' : 'Minimize'; }
        savePanelMinimized(min);
    }

    // ── NEW: "ⓘ" info popover — unofficial-extension notice + credit ──
    // PLACEHOLDER: swap in the real Chrome Web Store URL once the official
    // extension is published.
    const OFFICIAL_EXTENSION_URL = 'https://chromewebstore.google.com/detail/egca-atc-logbook-autofill/fdhkbilacfkbfgghadoeefcblipnlhgd';

    function buildInfoPopover() {
        const existing = document.getElementById('dgca-info-popover');
        if (existing) return existing;

        const pop = document.createElement('div');
        pop.id = 'dgca-info-popover';
        pop.className = 'dgca-panel-info-popover';
        pop.innerHTML = `
            <div class="dgca-panel-info-notice">⚠ This is <strong>not</strong> the official extension.</div>
            <div class="dgca-panel-info-links">
                <a href="${OFFICIAL_EXTENSION_URL}" target="_blank" rel="noopener noreferrer">
                    🔗 Official eLogBook Extension <span class="dgca-panel-info-arrow">→</span>
                </a>
            </div>
            <div class="dgca-panel-info-credit">
                Made with ❤️ by <span class="shimmer-text">Gaurav Chetiwal</span>
            </div>
        `;
        document.body.appendChild(pop);
        return pop;
    }

    function positionInfoPopover(pop, anchorBtn) {
        const margin = 8;
        const rect = anchorBtn.getBoundingClientRect();
        pop.style.visibility = 'hidden';
        pop.style.display = 'block';
        const popRect = pop.getBoundingClientRect();

        let left = rect.right - popRect.width;
        left = Math.min(Math.max(left, margin), window.innerWidth - popRect.width - margin);

        let top = rect.bottom + 6;
        if (top + popRect.height > window.innerHeight - margin) {
            top = rect.top - popRect.height - 6; // flip above if no room below
        }
        top = Math.max(top, margin);

        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
        pop.style.visibility = 'visible';
    }

    function closeInfoPopover(pop) {
        pop.classList.remove('dgca-panel-info-popover--open');
        pop.style.display = 'none';
    }

    function toggleInfoPopover(pop, anchorBtn) {
        if (pop.classList.contains('dgca-panel-info-popover--open')) {
            closeInfoPopover(pop);
            return;
        }
        positionInfoPopover(pop, anchorBtn);
        pop.classList.add('dgca-panel-info-popover--open');
    }

    function showStatus(text, kind) {
        const el = document.getElementById('dgca-status');
        if (!el) return;
        el.textContent = text;
        el.style.display = '';
        el.className = `dgca-status-msg dgca-status-msg--${kind}`;
        clearTimeout(showStatus._hideTimer);
        showStatus._hideTimer = setTimeout(() => {
            el.style.display = 'none';
        }, kind === 'success' ? 6000 : 8000);
        const panel = document.getElementById('dgca-panel');
        if (panel) {
            panel.classList.remove('dgca-panel--hidden');
            if (panel.classList.contains('dgca-panel--min'))
                setPanelMinimized(panel, false);
        }
    }

    // ── CHANGED: Panel includes ☑ All / ☐ None buttons ───────────────
    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'dgca-panel';
        panel.className = 'dgca-panel dgca-panel--hidden';

        panel.innerHTML = `
            <div class="dgca-panel-header" id="dgca-panel-header">
                <span class="dgca-panel-title">✈ eLogBook Assist Extension</span>
                <div class="dgca-panel-controls">
                    <button type="button" class="dgca-panel-iconbtn dgca-panel-info-btn"
                        title="About this extension">ⓘ</button>
                    <button type="button" class="dgca-panel-iconbtn dgca-panel-min-btn"
                        title="Minimize">—</button>
                </div>
            </div>
            <div class="dgca-panel-body">
                <span id="dgca-row-count" class="dgca-row-count dgca-panel-row-count"></span>
                <span id="dgca-select-hint" class="dgca-select-hint">⚠ Click rows to select/deselect for import.</span>
                <span id="dgca-user-warn" class="dgca-user-warn"></span>
                <div class="dgca-sel-actions">
                    <button type="button" id="dgca-sel-all-btn"
                        class="dgca-selall-btn">☑ All</button>
                    <button type="button" id="dgca-desel-all-btn"
                        class="dgca-selall-btn">☐ None</button>
                </div>
                <div class="dgca-panel-actions">
                    <button type="button" id="dgca-send-btn"
                        class="dgca-send-btn dgca-ext-shimmer-btn">📥 Import</button>
                    <button type="button" id="dgca-clear-queue-btn"
                        class="dgca-clear-queue-btn" disabled>🗑 Clear</button>
                </div>
                <span id="dgca-status" class="dgca-status-msg"></span>
            </div>
        `;

        document.body.appendChild(panel);

        const savedPos = loadPanelPos();
        if (savedPos) {
            panel.style.left = `${savedPos.left}px`;
            panel.style.top = `${savedPos.top}px`;
        } else {
            panel.style.top = '90px';
            panel.style.right = '16px';
        }

        const header = panel.querySelector('#dgca-panel-header');
        makePanelDraggable(panel, header);

        panel.querySelector('.dgca-panel-min-btn').addEventListener('click', () => {
            setPanelMinimized(panel, !panel.classList.contains('dgca-panel--min'));
        });
        setPanelMinimized(panel, loadPanelMinimized());

        // Info popover — lives outside the panel (appended to <body>) so
        // its overflow isn't clipped by .dgca-panel { overflow: hidden }.
        const infoBtn = panel.querySelector('.dgca-panel-info-btn');
        const infoPopover = buildInfoPopover();
        infoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleInfoPopover(infoPopover, infoBtn);
        });
        document.addEventListener('click', (e) => {
            if (!infoPopover.classList.contains('dgca-panel-info-popover--open')) return;
            if (e.target.closest('#dgca-info-popover') || e.target.closest('.dgca-panel-info-btn')) return;
            closeInfoPopover(infoPopover);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeInfoPopover(infoPopover);
        });

        panel.querySelector('#dgca-send-btn').addEventListener('click', onImportClick);
        panel.querySelector('#dgca-clear-queue-btn').addEventListener('click', clearQueue);
        panel.querySelector('#dgca-sel-all-btn').addEventListener('click', selectAllRows);
        panel.querySelector('#dgca-desel-all-btn').addEventListener('click', deselectAllRows);

        window.addEventListener('resize', () => {
            const rect = panel.getBoundingClientRect();
            const { left, top } = clampPanelPos(panel, rect.left, rect.top);
            if (panel.style.left) {
                panel.style.left = `${left}px`;
                panel.style.top = `${top}px`;
            }
            if (infoPopover.classList.contains('dgca-panel-info-popover--open')) {
                positionInfoPopover(infoPopover, infoBtn);
            }
        });

        return panel;
    }

    let _panelInjected = false;

    function ensurePanelInjected() {
        if (_panelInjected) return;
        if (document.getElementById('dgca-panel')) { _panelInjected = true; return; }
        buildPanel();
        _panelInjected = true;
        refreshUserMismatchIndicator();
        refreshRowCountBadge();

        window.DGCA_STORAGE.onChanged((changes, area) => {
            if (area === 'session' &&
                (changes.dgca_pending_rows || changes.dgca_queue_user || changes.dgca_session_running)) {
                refreshUserMismatchIndicator();
            }
        });
    }

    function showBlockedNotice() {
        if (document.getElementById('dgca-blocked-notice')) return;
        const notice = document.createElement('div');
        notice.id = 'dgca-blocked-notice';
        notice.style.cssText =
            'position:fixed; top:12px; right:12px; z-index:999999; max-width:360px;' +
            'background:#fff3cd; color:#664d03; border:1px solid #ffe69c; border-radius:6px;' +
            'padding:10px 28px 10px 14px; font-size:13px; font-family:sans-serif;' +
            'box-shadow:0 2px 8px rgba(0,0,0,.15);';
        notice.innerHTML = `
            <button type="button" id="dgca-blocked-notice-close" title="Dismiss"
                aria-label="Dismiss"
                style="position:absolute;top:2px;right:4px;width:22px;height:22px;
                background:none;border:none;font-size:16px;line-height:1;color:#664d03;
                cursor:pointer;padding:0;">×</button>
            <strong>⚠ DGCA Injector Blocked</strong><br>
            The site is removing extension elements from the page.
            Please try the official IAMATC Extension if this continues.`;
        document.body.appendChild(notice);
        notice.querySelector('#dgca-blocked-notice-close')
            .addEventListener('click', () => notice.remove());
    }

    function checkInjectionSurvived() {
        setTimeout(() => {
            if (!document.getElementById('dgca-panel')) showBlockedNotice();
        }, 500);
    }

    // ── CHANGED: Enhanced table observer ──────────────────────────────
    function setup() {
        injectShimmerStyle();
        injectPanelStyle();
        injectCheckboxStyle();
        ensurePreviewButtonShimmer();
        ensurePanelInjected();
        checkInjectionSurvived();

        // Debounced observer: detects the table appearing or its rows
        // changing (e.g. after "Generate Preview"), and re-applies
        // click-to-select behaviour, including to any rows that lost
        // their .dgca-row-clickable class/listener.
        let _tableObsTimer = null;
        let _lastTbodySig = '';

        const obs = new MutationObserver(() => {
            clearTimeout(_tableObsTimer);
            _tableObsTimer = setTimeout(() => {
                ensurePreviewButtonShimmer();
                const table = document.querySelector('table');
                if (!table) return;

                const tbody = table.querySelector('tbody');
                const rowCount = tbody ? tbody.querySelectorAll('tr').length : 0;
                const firstCell = tbody?.querySelector('tr td');
                const sig = `${rowCount}|${firstCell?.textContent?.slice(0, 20) || ''}`;

                if (sig !== _lastTbodySig) {
                    // Table content changed (new rows after "Generate Preview")
                    _lastTbodySig = sig;
                    refreshRowCountBadge();
                } else {
                    // Same rows — re-wire any rows missing the clickable class
                    // (e.g. DOM was partially re-rendered by the page).
                    enableFallbackSelection(table);
                }
            }, 150);
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', setup);
    else setup();
})();