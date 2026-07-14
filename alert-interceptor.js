/**
 * alert-interceptor.js
 * Runs in MAIN world at document_start on DGCA portal.
 * Overrides window.alert / window.confirm / Swal.fire BEFORE the page loads.
 * Dispatches CustomEvents that the ISOLATED-world dgca-filler.js can listen to.
 *
 * NOTE: Cannot use chrome.* APIs here — must use CustomEvent.
 */
(function () {
	'use strict';

	const EVENT_NAME = 'dgca_alert_captured'; // must match ALERT_EVENT_NAME in dgca-filler-common.js

	function emit(msg, source) {
		try {
			window.dispatchEvent(new CustomEvent(EVENT_NAME, {
				detail: { msg: String(msg), source: source, ts: Date.now() }
			}));
		} catch (_) { }
	}

	// ── 1. Override native alert ─────────────────────────────────────────────
	const _origAlert = window.alert;
	window.alert = function (msg) {
		emit(msg, 'native-alert');
		// Don't call _origAlert — suppresses the browser dialog entirely
	};

	// ── 2. Override native confirm ───────────────────────────────────────────
	const _origConfirm = window.confirm;
	window.confirm = function (msg) {
		emit(msg, 'native-confirm');
		return true; // auto-accept
	};

	// ── 3. Override native prompt ────────────────────────────────────────────
	const _origPrompt = window.prompt;
	if (_origPrompt) {
		window.prompt = function (msg, defaultVal) {
			emit(msg, 'native-prompt');
			return defaultVal || '';
		};
	}

	// ── 4. Intercept SweetAlert2 (lazy — loads after page) ───────────────────
	let _swalPatched = false;
	function patchSwal() {
		if (_swalPatched) return;
		if (!window.Swal) return;
		try {
			const origFire = window.Swal.fire.bind(window.Swal);
			window.Swal.fire = function (options, ...args) {
				const title = (typeof options === 'object') ? (options.title || '') : String(options || '');
				const html = (typeof options === 'object') ? (options.html || '') : '';
				const text = (typeof options === 'object') ? (options.text || '') : '';
				const msg = String(title + ' ' + html + ' ' + text).replace(/<[^>]*>/g, '').trim();
				if (msg) emit(msg, 'swal');
				return origFire(options, ...args);
			};
			_swalPatched = true;
		} catch (_) { }
	}

	const swalInterval = setInterval(() => {
		patchSwal();
		if (_swalPatched) clearInterval(swalInterval);
	}, 200);
	setTimeout(() => clearInterval(swalInterval), 15000);

	// ── 5. Catch anything that slips through via DOM observation ─────────────
	function startObserver() {
		const observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				for (const node of m.addedNodes) {
					if (node.nodeType !== 1) continue;
					if (node.classList && node.classList.contains('swal2-popup')) {
						const title = node.querySelector('.swal2-title')?.innerText || '';
						const html = node.querySelector('.swal2-html-container')?.innerText || '';
						const msg = (title + ' ' + html).trim();
						if (msg) emit(msg, 'swal-dom');
					}
					if (node.classList && node.classList.contains('modal') && node.classList.contains('show')) {
						const msg = node.innerText?.trim();
						if (msg && msg.length < 500) emit(msg, 'modal-dom');
					}
				}
			}
		});
		observer.observe(document.body, { childList: true, subtree: true });
	}

	if (document.body) startObserver();
	else document.addEventListener('DOMContentLoaded', startObserver);

	console.log('[DGCA Interceptor] MAIN-world alert interception active');
})();