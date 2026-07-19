/**
shared.js
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

	window.DGCA = {
		parseDateDMY, formatDDMMYYYY, addOneDay, sleep, normalizeName, namesMatch,
	};
})();