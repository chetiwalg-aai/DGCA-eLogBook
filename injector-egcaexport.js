// Runs on https://iamatc.aai.aero/atc/EGcAexport*. Adds an "Import Data to
// Queue" button next to the portal's "Generate Preview" button. Only rows
// selected in the preview are written to the shared queue used by the DGCA
// e-LogBook toolbar.
(function () {
    'use strict';

    // ── Column mapping ──────────────────────────────────────────────────
    // Source of truth is the site's OWN "Send to Extension" script block
    // (inline on this page), which declares its own
    //   var HEADER_TO_INTERNAL = { "From Date": "FROM_DATE", ... };
    // We scrape and parse that literal at runtime instead of hardcoding a
    // duplicate copy here, so if the portal ever adds/renames/reorders
    // columns, this extension picks up the change automatically without
    // needing a new release. The list below is kept ONLY as a fallback for
    // the rare case the site's script is missing, renamed, or the literal
    // can't be parsed (e.g. the portal ships a minified/obfuscated bundle).
    var FALLBACK_HEADER_TO_INTERNAL = {
        "Schema Version": "CSV_SCHEMA_VERSION",
        "New ATS Unit?": "NEWLY_ESTAB_UNIT_CHECK",
        "From Date": "FROM_DATE",
        "To Date": "TO_DATE",
        "Posting Station": "POSTING_STATION",
        "ICAO Code": "ICAO_CODE",
        "ATS eGCA ID": "ATS_EGCA_ID",
        "Rating": "RATING",
        "ATS Unit": "ATS_UNIT",
        "Briefing Done": "BRIEFING_DONE",
        "Type of Duty": "TYPE_OF_DUTY",
        "Start Time": "START_TIME",
        "End Time": "END_TIME",
        "Total Duration": "TOTAL_DURATION",
        "Remarks": "REMARKS",
        "Knowledge Check": "KNOWLEDGE_CHECK",
        "Skill Test Check": "SKILL_TEST_CHECK",
        "OJT Provided": "OJT_PROVIDED_CHECK",
        "OJT Environment": "OJT_ENV",
        "Trainee License": "TRAINEE_LICENSE",
        "Trainee Name": "TRAINEE_NAME",
        "Instructor License": "INSTRUCTOR_LICENSE",
        "Instructor Name": "INSTRUCTOR_NAME",
        "Proficiency Check": "PROFICIENCY_CHECK",
    };

    // Scrapes every inline <script> on the page for a
    // "HEADER_TO_INTERNAL = { ... };" object-literal assignment and parses
    // it. This works even though the site's copy of the variable is closed
    // over inside its own IIFE (and never attached to window) — we only
    // need the raw *source text* of the <script> tag, which the DOM always
    // exposes via .textContent regardless of what the page's JS does with
    // the variable at runtime. Only ever asked to parse a plain object
    // literal of string:string pairs, never executed as page code.
    function extractSiteHeaderMap() {
        const scripts = document.querySelectorAll('script:not([src])');
        for (const script of scripts) {
            const text = script.textContent;
            if (!text || text.indexOf('HEADER_TO_INTERNAL') === -1) continue;
            const match = text.match(/HEADER_TO_INTERNAL\s*=\s*(\{[\s\S]*?\})\s*;/);
            if (!match) continue;
            try {
                // CSP-safe parser: the site's mapping is a simple object literal
                // containing only quoted string keys and quoted string values.
                // Never use eval()/Function() here — Chrome blocks string-to-JS
                // evaluation under the site's CSP.
                const obj = {};
                const pairRe = /(["\'])(.*?)\1\s*:\s*(["\'])(.*?)\3\s*,?/g;
                let pair;
                let count = 0;
                while ((pair = pairRe.exec(match[1])) !== null) {
                    const key = pair[2].replace(/\\(["\'])/g, '$1');
                    const value = pair[4].replace(/\\(["\'])/g, '$1');
                    obj[key] = value;
                    count++;
                }
                if (count > 0 && Object.keys(obj).length === count) return obj;
            } catch (e) {
                console.warn('[dgca-injector] Failed to parse site HEADER_TO_INTERNAL, ' +
                    'falling back to built-in column mapping.', e);
            }
        }
        return null;
    }

    const siteHeaderMap = extractSiteHeaderMap();
    if (siteHeaderMap) {
        console.log('[dgca-injector] Using column mapping read from the site\'s own script ' +
            '(' + Object.keys(siteHeaderMap).length + ' columns).');
    } else {
        console.warn('[dgca-injector] Could not find/parse the site\'s HEADER_TO_INTERNAL ' +
            'mapping — using the extension\'s built-in fallback mapping instead.');
    }
    // Merge so a partial/stale site map still gets filled in by the
    // fallback rather than silently dropping columns.
    var HEADER_TO_INTERNAL = Object.assign({}, FALLBACK_HEADER_TO_INTERNAL, siteHeaderMap || {});

    // The portal's <th> text sometimes has no whitespace between words
    // ("FromDate" instead of "From Date"), so match on a whitespace- and
    // case-normalised key instead of an exact string.
    function normaliseHeaderKey(s) {
        return String(s || '').replace(/\s+/g, '').toLowerCase();
    }
    const NORMALISED_HEADER_TO_INTERNAL = {};
    Object.keys(HEADER_TO_INTERNAL).forEach(k => {
        NORMALISED_HEADER_TO_INTERNAL[normaliseHeaderKey(k)] = HEADER_TO_INTERNAL[k];
    });

    if (!window.DGCA) {
        console.error('[dgca-injector] window.DGCA is not defined — this script must load ' +
            'AFTER the shared DGCA content script on this page. Check manifest.json load order ' +
            'and that both scripts are matched to this URL. Aborting to avoid a silent crash.');
        return;
    }
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

    // Checkboxes live inside data cells; textContent still returns the
    // cell's data text, while selects use their current value.
    function readCellValue(td) {
        const select = td.querySelector('select');
        if (select) return select.value;
        return td.textContent.trim();
    }

    // STEP 1 — read the table exactly as it is on the page, no mapping yet.
    // Skips the native checkbox column (<th> containing the #selectAllRows
    // checkbox) so headers stay aligned with the real data columns,
    // matching how downloadEgcaCsv() reads the table. Returns the RAW
    // visible header labels (e.g. "From Date"), untouched.
    function getTableHeaders(table) {
        const thead = table.querySelector('thead');
        if (!thead) return [];
        const headerRow = thead.querySelector('tr');
        if (!headerRow) return [];
        return Array.from(headerRow.querySelectorAll('th'))
            .filter(th => {
                if (th.querySelector('input[type="checkbox"]')) return false;
                const norm = normaliseHeaderKey(th.textContent);
                if (norm === 'select' || norm === '') return false; // select/blank column, no data cell to match
                return true;
            })
            .map(th => th.textContent.trim());
    }

    // STEP 1 (cont.) — read a row's cell values keyed by those SAME raw
    // header labels. Skips the native checkbox <td> so cells stay aligned
    // with the headers returned by getTableHeaders above. Still no mapping
    // to internal names at this point — just table_label -> value.
    function readRowByHeaders(tr, rawHeaders) {
        const cells = Array.from(tr.children)
            .filter(el => el.tagName === 'TD' && !el.querySelector('input.row-select-cb'));
        const raw = {};
        rawHeaders.forEach((label, i) => {
            const td = cells[i];
            raw[label] = td ? readCellValue(td) : '';
        });
        return raw;
    }

    // STEP 2 — now apply the column mapping. Takes a row keyed by raw
    // table labels (from readRowByHeaders) and returns a new object keyed
    // by internal names, via NORMALISED_HEADER_TO_INTERNAL. Any label the
    // map doesn't recognise is passed through unchanged (better to keep
    // the data under its raw label than to silently drop it).
    function mapRowToInternal(rawRow) {
        const mapped = {};
        Object.keys(rawRow).forEach(label => {
            const norm = normaliseHeaderKey(label);
            const internalKey = NORMALISED_HEADER_TO_INTERNAL[norm] || label;
            mapped[internalKey] = rawRow[label];
        });
        return mapped;
    }

    // ── Native checkbox helpers ────────────────────────────────────────
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

    function parseRow(tr, rawHeaders) {
        // Read the row from the preview table.
        const rawByLabel = readRowByHeaders(tr, rawHeaders);
        // Map the preview headers to the internal field names.
        const raw = mapRowToInternal(rawByLabel);
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

    let _tableCache = { table: null, headers: null, rows: null, tbody: null };

    function invalidateTableCache(table = null) {
        if (!table || _tableCache.table === table) {
            _tableCache.rows = null;
            _tableCache.headers = null;
            if (table) _tableCache.table = table;
        }
    }

    function getDataRowsFromTable(table, force = false) {
        if (!table) return [];
        const tbody = table.querySelector('tbody');
        if (!tbody) return [];
        if (!force &&
            _tableCache.table === table &&
            _tableCache.tbody === tbody &&
            _tableCache.rows) {
            return _tableCache.rows;
        }

        const headers = (!force &&
            _tableCache.table === table &&
            _tableCache.tbody === tbody &&
            _tableCache.headers) ? _tableCache.headers : getTableHeaders(table);

        if (headers.length === 0) return [];
        const rows = [];
        tbody.querySelectorAll('tr').forEach(tr => {
            const row = parseRow(tr, headers);
            if (row) rows.push(row);
        });
        _tableCache = { table, headers, rows, tbody };
        return rows;
    }

    // ══════════════════════════════════════════════════════════════════
    //  Row selection state and checkbox handling
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
        const table = document.getElementById('csvPreviewTable') || document.querySelector('table');
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

    // ── Wire up the site's native per-row checkboxes ─────────────────
    // Preferred path now that the portal renders its own <input
    // type="checkbox" class="row-select-cb"> in each row (plus a
    // #selectAllRows header checkbox). We just lock the editable cells
    // (unrelated to selection) and mirror checkbox state into
    // _rowSelection so the rest of the code (getSelectedCount,
    // onImportClick, etc.) can use the same selection state.
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

            // Avoid binding the same row more than once when the observer
            // processes the table again.
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
        const table = document.getElementById('csvPreviewTable') || document.querySelector('table');
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
        const table = document.getElementById('csvPreviewTable') || document.querySelector('table');
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
    //  Portal and queue helpers
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

    // ── Update preview selection state and panel counts ───────────────
    function refreshRowCountBadge() {
        const table = document.getElementById('csvPreviewTable') || document.querySelector('table');
        const allRows = table ? getDataRowsFromTable(table) : [];
        const count = allRows.length;
        _previewRowCount = count;

        if (table && count > 0) {
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

            const data = await chrome.storage.local.get([
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
            const data = await chrome.storage.local.get(['dgca_session_running']);
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
            await chrome.storage.local.remove([
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
        const data = await chrome.storage.local.get([
            'dgca_pending_rows', 'dgca_queue_user', 'dgca_session_running'
        ]);
        const existing = data?.dgca_pending_rows || [];
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

        // Overwrite: each Import replaces the whole queue with the newly
        // selected rows, instead of merging into whatever was queued before.
        const rawStatuses = newRows.map(() => 'pending');
        const { rows: sorted, statuses: sortedStatus, errors: sortedErrors } =
            sortQueue(newRows, rawStatuses, {});
        const nextQueueUser = currentUser || queueUser || null;

        await chrome.storage.local.set({
            dgca_pending_rows: sorted,
            dgca_row_status: sortedStatus,
            dgca_row_errors: sortedErrors,
            dgca_row_timings: {},
            dgca_session_ts: Date.now(),
            dgca_queue_user: nextQueueUser,
        });
        return { status: 'ok', added: sorted.length, total: sorted.length };
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
            case 'ok':
                showStatus(`✓ Queue replaced with ${result.total} row${result.total === 1 ? '' : 's'}. Open the DGCA Entry Page to fill the entries.`, 'success');
                return;
        }
    }

    // ── Import selected rows ─────────────────────────────────────────
    function onImportClick() {
        const table = document.getElementById('csvPreviewTable') || document.querySelector('table');
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

    // ── Shimmer effect ───────────────────────────────────────────────
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
            :root {
                --dgca-ease: cubic-bezier(0.16, 1, 0.3, 1);
                --dgca-ease-in: cubic-bezier(0.4, 0, 0.2, 1);
            }
            @keyframes dgca-panel-pop-in {
                from { opacity: 0; transform: translateY(8px) scale(0.96); }
                to   { opacity: 1; transform: translateY(0) scale(1); }
            }
            @media (prefers-reduced-motion: reduce) {
                .dgca-panel, .dgca-panel-body, .shimmer-text { animation: none !important; transition: none !important; }
            }
            .dgca-panel {
                position: fixed; z-index: 999997;
                width: 210px; max-width: calc(100vw - 16px);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 11px; color: #e0e0e0;
                background: linear-gradient(165deg, #1c2a4f, #131b34);
                border: 1px solid #2a3a5e; border-radius: 12px;
                box-shadow: 0 12px 32px rgba(0,0,0,.4), 0 0 0 1px rgba(79,195,247,.08) inset;
                overflow: hidden;
                /* No fill-mode here (default: none) deliberately — the panel
                   is draggable via an inline transform style (see
                   makePanelDraggable below), and an animation with
                   fill: both/forwards would keep re-asserting its own end-
                   state transform over that inline style after the entrance
                   plays, silently breaking drag the first time it's tried
                   right after the panel mounts. Without fill, the animation
                   only owns the transform property for its .3s runtime and
                   hands control back to the normal cascade afterward. */
                animation: dgca-panel-pop-in .3s var(--dgca-ease);
                transition: box-shadow .2s ease;
                /* Panel repaints on drag (position) and on every queue/status
                   update; containment keeps that from forcing layout checks
                   on the much larger host page around it. */
                contain: layout paint style;
            }
            .dgca-panel--dragging { box-shadow: 0 18px 40px rgba(0,0,0,.5); }
            .dgca-panel-header {
                display: flex; align-items: center; justify-content: space-between;
                gap: 6px; padding: 6px 6px 6px 9px;
                background: #16213e; cursor: move; user-select: none;
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
            .dgca-panel-iconbtn {
                transition: background .18s var(--dgca-ease-in), color .18s ease, transform .18s var(--dgca-ease);
            }
            .dgca-panel-iconbtn:hover { background: #2a3a5e; color: #fff; transform: scale(1.12); }
            .dgca-panel-iconbtn:active { transform: scale(0.92); }
            /* Same max-height/opacity collapse technique used by the DGCA
               toolbar (dgca-filler.js) — display:none can't be animated, so
               this is what makes minimize/expand feel intentional. */
            .dgca-panel-body {
                padding: 8px; display: flex; flex-direction: column; gap: 6px;
                max-height: 600px; opacity: 1; overflow: hidden;
                transition: max-height .35s var(--dgca-ease), opacity .2s ease .05s, padding .35s var(--dgca-ease);
            }
            .dgca-panel.dgca-panel--min .dgca-panel-body {
                max-height: 0; opacity: 0; padding-top: 0; padding-bottom: 0;
                transition: max-height .26s var(--dgca-ease-in), opacity .12s ease, padding .26s var(--dgca-ease-in);
            }
            .dgca-panel-min-btn {
                transition: transform .28s var(--dgca-ease);
            }
            .dgca-panel.dgca-panel--min .dgca-panel-min-btn {
                transform: rotate(-180deg);
            }
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
                flex: 1; border: none; border-radius: 6px; padding: 5px 6px;
                font-size: 10px; font-weight: 600; cursor: pointer;
                transition: opacity .15s, filter .15s, transform .15s var(--dgca-ease), box-shadow .15s ease;
            }
            .dgca-panel-actions button:disabled { opacity: .4; cursor: not-allowed; }
            .dgca-panel-actions button:not(:disabled):hover {
                filter: brightness(1.15); transform: translateY(-1px);
                box-shadow: 0 3px 10px rgba(0,0,0,.3);
            }
            .dgca-panel-actions button:not(:disabled):active { transform: translateY(0) scale(.96); }
            .dgca-send-btn { background: linear-gradient(135deg, #4fc3f7, #29b6f6); color: #0a0a14; }
            .dgca-clear-queue-btn {
                background: #23233a; border: 1px solid #4a4a6e !important; color: #cfd3e0;
            }
            @keyframes dgca-panel-status-in {
                from { opacity: 0; transform: translateY(-4px); }
                to   { opacity: 1; transform: translateY(0); }
            }
            .dgca-status-msg {
                font-size: 10px; font-weight: 600; line-height: 1.3;
                padding: 5px 6px; border-radius: 6px; display: none;
            }
            .dgca-status-msg--success {
                background: #1a3320; border: 1px solid #2e6b3e;
                color: #8ee6a0; display: block;
                animation: dgca-panel-status-in .22s var(--dgca-ease);
            }
            .dgca-status-msg--error {
                background: #3a1f1f; border: 1px solid #6b2e2e;
                color: #f28b82; display: block;
                animation: dgca-panel-status-in .22s var(--dgca-ease);
            }
            .dgca-panel--hidden { display: none !important; }
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

    // Dragging used to write panel.style.left/top on every pointermove,
    // which forces a synchronous layout recalculation each frame (left/top
    // on a position:fixed element are layout-affecting properties). Instead,
    // the panel is left pinned at its last committed left/top and dragging
    // moves it purely via `transform: translate3d(...)`, a compositor-only
    // property that doesn't trigger layout or paint — smoother motion with
    // far less main-thread work while the pointer is down, at any queue
    // size. The transform delta is folded back into left/top exactly once,
    // on pointerup, so the rest of the panel's logic (clampPanelPos,
    // savePanelPos, initial positioning) keeps working in plain px terms.
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
            panel.style.transform = `translate3d(${left - startLeft}px, ${top - startTop}px, 0)`;
        });
        const stopDrag = () => {
            if (!dragging) return;
            dragging = false;
            panel.classList.remove('dgca-panel--dragging');
            // Fold the transform offset back into left/top once, then clear
            // the transform, so the panel's resting state is expressed the
            // same way it always was (and clampPanelPos/positioning on the
            // next load keep working unchanged).
            const rect = panel.getBoundingClientRect();
            panel.style.transform = '';
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            savePanelPos({ left: rect.left, top: rect.top });
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

    // ── Floating panel ───────────────────────────────────────────────
    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'dgca-panel';
        panel.className = 'dgca-panel dgca-panel--hidden';

        panel.innerHTML = `
            <div class="dgca-panel-header" id="dgca-panel-header">
                <span class="dgca-panel-title">✈ eLogBook Assist Extension</span>
                <div class="dgca-panel-controls">
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

        chrome.storage.local.onChanged.addListener((changes, area) => {
            if (area === 'local' &&
                (changes.dgca_pending_rows || changes.dgca_queue_user || changes.dgca_session_running)) {
                refreshUserMismatchIndicator();
            }
        });
    }

    // ── Preview table observer ─────────────────────────────────────────
    // Watch the table for portal re-renders and use a small parent observer
    // to detect when the table element itself is replaced or removed.
    function setupTableObserver() {
        let table = null;
        let tableObs = null;
        let parentObs = null;
        let timer = null;
        let lastSig = '';

        const scheduleRefresh = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const current = document.getElementById('csvPreviewTable') || document.querySelector('table');
                if (!current) return;
                if (current !== table) attach(current);

                const tbody = current.tBodies?.[0];
                const rowCount = tbody?.rows?.length || 0;
                const firstCell = tbody?.rows?.[0]?.cells?.[0];
                const sig = `${rowCount}|${firstCell?.textContent?.slice(0, 20) || ''}`;

                ensurePreviewButtonShimmer();
                if (sig !== lastSig) {
                    lastSig = sig;
                    invalidateTableCache(current);
                    refreshRowCountBadge();
                } else {
                    enableFallbackSelection(current);
                }
            }, 60);
        };

        const attach = (nextTable) => {
            if (!nextTable || nextTable === table) return;
            if (tableObs) tableObs.disconnect();
            if (parentObs) parentObs.disconnect();

            table = nextTable;
            invalidateTableCache(table);
            lastSig = '';

            tableObs = new MutationObserver(() => scheduleRefresh());
            tableObs.observe(table, { childList: true, subtree: true });

            const parent = table.parentElement;
            if (parent) {
                parentObs = new MutationObserver(() => {
                    const current = document.getElementById('csvPreviewTable') || document.querySelector('table');
                    if (current !== table) {
                        attach(current);
                        scheduleRefresh();
                    }
                });
                parentObs.observe(parent, { childList: true });
            }
        };

        const initial = document.getElementById('csvPreviewTable') || document.querySelector('table');
        if (initial) attach(initial);
        scheduleRefresh();
    }

    // ── Setup ─────────────────────────────────────────────────────────
    function setup() {
        injectShimmerStyle();
        injectPanelStyle();
        injectCheckboxStyle();
        ensurePreviewButtonShimmer();
        ensurePanelInjected();
        setupTableObserver();
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', setup);
    else setup();
})();