/**
shared.js
Helpers genuinely shared across more than one content-script context:
injector-egcaexport.js (AAI page) and dgca-filler.js (DGCA page). Anything
used by only one of them lives in that file instead — e.g. the row-status
pill labels/classes are now defined directly in dgca-filler.js, since it's
the only queue UI left (the old side panel that used to duplicate them is
gone).
*/
(function () {
	'use strict';
	function parseDateDMY(dateStr) {
		const [d, m, y] = String(dateStr).trim().split('-').map(Number);
		return { d, m, y };
	}

	function formatDDMMYYYY(d, m, y) {
		return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
	}

	function addOneDay(d, m, y) {
		const date = new Date(y, m - 1, d);
		date.setDate(date.getDate() + 1);
		return { d: date.getDate(), m: date.getMonth() + 1, y: date.getFullYear() };
	}

	function sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	// Honorifics commonly prefixed/suffixed to names on the DGCA portal or in
	// the EGCA export, which shouldn't cause a false "mismatch" against the
	// bare name we intend to type.
	const HONORIFICS = [
		'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'capt', 'captain',
		'shri', 'smt', 'sri', 'kumari', 'er', 'eng'
	];

	function normalizeName(name) {
		return String(name || '')
			.toLowerCase()
			.replace(/[.,]/g, ' ')
			.split(/\s+/)
			.filter(Boolean)
			.filter(word => !HONORIFICS.includes(word))
			.sort()
			.join(' ');
	}

	// Loose equality check: same set of (non-honorific) words, regardless of
	// order, case, spacing, or punctuation.
	function namesMatch(a, b) {
		return normalizeName(a) === normalizeName(b);
	}

	// ── Row status vocabulary — the canonical status *values* are shared
	// (injector-egcaexport.js writes 'pending' when queuing; dgca-filler.js
	// writes/reads all five as a session runs), but their display labels,
	// CSS classes, and detail text are not — only dgca-filler.js's toolbar
	// renders them, so those maps live there now.
	const ROW_STATUS = {
		PENDING: 'pending',
		FILLING: 'filling',
		SUBMITTED: 'submitted',
		ERROR: 'error',
		SKIPPED: 'skipped',
	};

	// ── Queue sorting — by date then start time. Used by injector-egcaexport
	// (when merging newly-selected rows into the existing queue) and
	// dgca-filler.js's toolbar (when loading the queue from storage). Keeps
	// statuses/errors aligned to rows after reordering.
	function rowSortKey(row) {
		const [d, m, y] = String(row.date || '').split('-');
		const dateKey = `${y || '0000'}${m || '00'}${d || '00'}`;
		const timeKey = String(row.timeFrom || '00:00').replace(':', '');
		return `${dateKey}${timeKey}`;
	}

	function sortQueue(rows, statuses, errors) {
		const indexed = rows.map((row, i) => ({
			row, status: statuses[i] || ROW_STATUS.PENDING, error: errors[i] || null, key: rowSortKey(row),
		}));
		indexed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		const sortedRows = indexed.map(x => x.row);
		const sortedStatuses = indexed.map(x => x.status);
		const sortedErrors = {};
		indexed.forEach((x, i) => { if (x.error) sortedErrors[i] = x.error; });
		return { rows: sortedRows, statuses: sortedStatuses, errors: sortedErrors };
	}

	// ── HTML escaping — used anywhere row data (which ultimately comes from
	// the EGCA-export table) is interpolated into innerHTML, by both the
	// injector and the toolbar. Escapes quotes too, not just &/</>, since
	// both use this inside title="..." attributes as well as element text
	// content — an attribute context needs the quote escaped or a value
	// containing a `"` breaks out of the attribute.
	function escHtml(str) {
		return String(str ?? '').replace(/[&<>"']/g, (c) => ({
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
		}[c]));
	}

	function escAttr(str) {
		return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	window.DGCA = {
		parseDateDMY, formatDDMMYYYY, addOneDay, sleep, normalizeName, namesMatch,
		ROW_STATUS, rowSortKey, sortQueue, escHtml, escAttr,
	};
})();
