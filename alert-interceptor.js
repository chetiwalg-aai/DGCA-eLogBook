/**
 * alert-interceptor.js
 *
 * Runs in the MAIN world at document_start on the DGCA portal, before the
 * page's own scripts run. Patches window.alert / window.confirm /
 * window.prompt / Swal.fire so their messages can be surfaced to the
 * ISOLATED-world content script (dgca-filler.js), which cannot see or patch
 * MAIN-world globals directly.
 *
 * Interception only changes behavior while a fill session is running
 * (reported in via the SESSION_EVENT_NAME event below):
 *   - alert(): shown to the user as normal when idle; suppressed during a
 *     session so it doesn't block automation.
 *   - confirm()/prompt(): answered by the real user when idle; auto-accepted
 *     during a session.
 * Every call is still reported via EVENT_NAME either way, so dgca-filler.js
 * can react to portal messages (e.g. surfacing errors) regardless of
 * session state.
 *
 * NOTE: chrome.* APIs are not available in the MAIN world — only
 * CustomEvent can cross to the ISOLATED-world listener.
 */
(function () {
	'use strict';

	const EVENT_NAME = 'dgca_alert_captured'; // must match ALERT_EVENT_NAME in dgca-filler.js
	const SESSION_EVENT_NAME = 'dgca_session_state_changed'; // must match SESSION_STATE_EVENT in dgca-filler.js

	// Starts false so a manual alert/confirm on a freshly loaded page (before
	// dgca-filler.js has had a chance to report in) is never accidentally
	// suppressed or auto-accepted.
	let _sessionRunning = false;
	window.addEventListener(SESSION_EVENT_NAME, (e) => {
		try { _sessionRunning = !!(e.detail && e.detail.running); } catch (_) { _sessionRunning = false; }
	});

	function emit(msg, source) {
		try {
			window.dispatchEvent(new CustomEvent(EVENT_NAME, {
				detail: { msg: String(msg), source: source, ts: Date.now() }
			}));
		} catch (_) { }
	}

	// ── Native alert ───────────────────────────────────────────────────────
	const _origAlert = window.alert;
	window.alert = function (msg) {
		emit(msg, 'native-alert');
		if (!_sessionRunning) return _origAlert.call(window, msg);
		// Session running: swallow it so the dialog can't block automation.
	};

	// ── Native confirm ─────────────────────────────────────────────────────
	const _origConfirm = window.confirm;
	window.confirm = function (msg) {
		emit(msg, 'native-confirm');
		if (!_sessionRunning) return _origConfirm.call(window, msg);
		return true; // session running: auto-accept
	};

	// ── Native prompt ──────────────────────────────────────────────────────
	const _origPrompt = window.prompt;
	if (_origPrompt) {
		window.prompt = function (msg, defaultVal) {
			emit(msg, 'native-prompt');
			if (!_sessionRunning) return _origPrompt.call(window, msg, defaultVal);
			return defaultVal || ''; // session running: auto-accept with the default
		};
	}

	// ── SweetAlert2 ─────────────────────────────────────────────────────────
	// Swal loads after this script runs, so patching is retried on an
	// interval until window.Swal actually exists (capped at 15s so a page
	// that never loads SweetAlert2 doesn't poll forever).
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

	// ── DOM fallback ────────────────────────────────────────────────────────
	// Catches messages that reach the page without going through alert/
	// confirm/prompt/Swal.fire (e.g. a popup constructed and shown directly
	// via DOM APIs). Mutation records are batched per animation frame rather
	// than processed one at a time, since this observer watches the entire
	// document.body subtree and the admin theme can add/remove many nodes
	// per SPA navigation.
	function startObserver() {
		let _pending = [];
		let _scheduled = false;

		function processPending() {
			_scheduled = false;
			const mutations = _pending;
			_pending = [];
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
		}

		const observer = new MutationObserver((mutations) => {
			_pending.push(...mutations);
			if (_scheduled) return;
			_scheduled = true;
			// requestAnimationFrame batches with the browser's render cadence;
			// fall back to a short timeout on the rare chance it's unavailable
			// this early in the page lifecycle.
			const raf = window.requestAnimationFrame
				? (cb) => window.requestAnimationFrame(cb)
				: (cb) => setTimeout(cb, 16);
			raf(processPending);
		});
		observer.observe(document.body, { childList: true, subtree: true });
	}

	if (document.body) startObserver();
	else document.addEventListener('DOMContentLoaded', startObserver);

	console.log('[DGCA Interceptor] MAIN-world alert interception active');
})();