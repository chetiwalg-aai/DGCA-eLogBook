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

	window.DGCA = {
		parseDateDMY, formatDDMMYYYY, addOneDay, sleep,
	};
})();