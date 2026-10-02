/**
 * alert-interceptor.js
 *
 * Runs in the MAIN world at document_start on the DGCA portal, before the
 * page's own scripts run. Patches window.alert / window.confirm /
 * window.prompt so their messages can be surfaced to the ISOLATED-world
 * content script (dgca-filler.js), which cannot see or patch MAIN-world
 * globals directly.
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

	console.log('[DGCA Interceptor] MAIN-world alert interception active');
})();