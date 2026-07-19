// ── Cross-browser panel abstraction ───────────────────────────────────────────
// Chrome: chrome.sidePanel (per-tab, needs an explicit open({tabId}) call).
// Firefox: chrome.sidebarAction / browser.sidebarAction (per-window, no tabId,
// and has no setAccessLevel-style restriction on storage.session — content
// scripts there already have full read/write access by default).
const IS_FIREFOX = typeof chrome.sidePanel === 'undefined' && typeof chrome.sidebarAction !== 'undefined';

function openPanel(tabId) {
	if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
		// Chrome: must be called synchronously within a user-gesture-carrying
		// listener (onClicked, or the onMessage handler below), with a tabId.
		return chrome.sidePanel.open({ tabId }).catch((err) => {
			console.warn('[DGCA SW] Could not open side panel (Chrome):', err);
		});
	}
	if (chrome.sidebarAction && typeof chrome.sidebarAction.open === 'function') {
		// Firefox: no tabId — sidebarAction is per-window, not per-tab.
		try {
			return Promise.resolve(chrome.sidebarAction.open());
		} catch (err) {
			console.warn('[DGCA SW] Could not open sidebar (Firefox):', err);
			return Promise.resolve();
		}
	}
	return Promise.resolve();
}

// NOTE: content scripts do NOT get direct access to chrome.storage.session on
// either browser — Chrome blocks it unless setAccessLevel is called, and
// Firefox has no such escape hatch at all. Rather than rely on that, content
// scripts go through storage-bridge.js, which relays get/set/remove calls to
// this background script (see the DGCA_STORAGE_* handlers below).

// ── Open side panel / sidebar when extension icon is clicked ─────────────────
chrome.action.onClicked.addListener((tab) => {
	openPanel(tab.id);
});

// ── Storage bridge for content scripts ────────────────────────────────────────
// Content scripts can't reliably use chrome.storage.session directly on
// either browser (see storage-bridge.js). The background script is a
// trusted context on both, so it does the actual reads/writes and relays
// storage.onChanged out to any listening content scripts.
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'session') return;
	chrome.runtime.sendMessage({ type: 'DGCA_STORAGE_CHANGED', changes, area }).catch(() => { });
});

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

	if (msg.type === 'DGCA_STORAGE_GET') {
		chrome.storage.session.get(msg.keys)
			.then((value) => sendResponse({ ok: true, value }))
			.catch((err) => sendResponse({ ok: false, error: err.message }));
		return true; // async
	}

	if (msg.type === 'DGCA_STORAGE_SET') {
		chrome.storage.session.set(msg.items)
			.then(() => sendResponse({ ok: true }))
			.catch((err) => sendResponse({ ok: false, error: err.message }));
		return true; // async
	}

	if (msg.type === 'DGCA_STORAGE_REMOVE') {
		chrome.storage.session.remove(msg.keys)
			.then(() => sendResponse({ ok: true }))
			.catch((err) => sendResponse({ ok: false, error: err.message }));
		return true; // async
	}


	// Content script asking to open the side panel (e.g. "Add to Queue" click
	// on the AAI page) — must be called synchronously here, off the incoming
	// user-gesture-carrying message, or Chrome will reject it.
	if (msg.type === 'OPEN_SIDE_PANEL') {
		// Must be triggered synchronously here, off the incoming message that
		// itself came from a user-gesture click on the AAI page — both Chrome's
		// sidePanel.open and Firefox's sidebarAction.open require this.
		const tabId = sender?.tab?.id;
		openPanel(tabId);
		sendResponse({ ok: true });
		return;
	}

	// Source page queued rows → notify side panel if open
	if (msg.type === 'ROWS_QUEUED') {
		chrome.runtime.sendMessage({ type: 'ROWS_READY', count: msg.count })
			.catch(() => { });
		sendResponse({ ok: true });
		return;
	}

	// Side panel wants to start filling → find DGCA tab and relay rows.
	// Only the EGCA-export source/filler exists today, so no routing needed.
	if (msg.type === 'REQUEST_START_FILLING') {
		chrome.storage.session.get(['dgca_pending_rows'])
			.then(async (data) => {
				const rows = data?.dgca_pending_rows || [];
				if (rows.length === 0) {
					sendResponse({ ok: false, error: 'No rows queued.' });
					return;
				}
				const dgcaTab = await findDgcaTab();
				if (!dgcaTab) {
					sendResponse({ ok: false, error: 'DGCA portal tab not found. Please open it.' });
					return;
				}

				chrome.tabs.sendMessage(dgcaTab.id, { type: 'PING' }, (pingResp) => {
					if (chrome.runtime.lastError || !pingResp?.breadcrumbOk) {
						sendResponse({ ok: false, error: 'DGCA tab is not on the e-Log Book page (breadcrumb check failed). Please navigate there and try again.' });
						return;
					}

					chrome.tabs.sendMessage(dgcaTab.id, { type: 'START_FILLING', rows }, (resp) => {
						if (chrome.runtime.lastError) {
							sendResponse({ ok: false, error: 'Could not reach DGCA tab. Make sure you are on the entry page.' });
						} else {
							sendResponse(resp);
						}
					});
				});
			})
			.catch((err) => {
				sendResponse({ ok: false, error: `Storage error: ${err.message}` });
			});
		return true; // async
	}

	// Side panel wants to abort
	if (msg.type === 'REQUEST_ABORT') {
		findDgcaTab().then(tab => {
			if (tab) chrome.tabs.sendMessage(tab.id, { type: 'ABORT_SESSION' });
		});
		sendResponse({ ok: true });
		return;
	}

	// DGCA filler sending progress → forward to side panel
	if (msg.type === 'FILL_PROGRESS') {
		chrome.runtime.sendMessage(msg).catch(() => { });
		sendResponse({ ok: true });
		return;
	}

	// Side panel pinging DGCA tab to check readiness
	if (msg.type === 'PING_DGCA_TAB') {
		findDgcaTab().then(tab => {
			if (!tab) {
				sendResponse({ ok: false, error: 'No DGCA tab found.' });
				return;
			}
			chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (resp) => {
				if (chrome.runtime.lastError) {
					sendResponse({ ok: false, error: 'DGCA content script not responding.' });
				} else {
					sendResponse({ ok: true, url: resp?.url, onEntryPage: !!resp?.onEntryPage, breadcrumbOk: !!resp?.breadcrumbOk });
				}
			});
		});
		return true;
	}
});

// ── Extension icon badge: queue count, color-coded by status ─────────────────
// Colors mirror the side panel's badge states (panel.css .badge--*):
//   queued (rows waiting, nothing running/erroring yet) → red   (draws the eye)
//   running (a row currently 'filling')                → blue
//   error (at least one row 'error', nothing running)   → red
//   done (every row 'submitted')                        → green
const BADGE_COLOR = {
	queued: '#e53935', // red
	running: '#2196f3', // blue
	error: '#ef5350', // red
	done: '#4caf50', // green
};

function computeBadgeState(rows, statuses) {
	const count = rows.length;
	if (count === 0) return { text: '', color: null };

	let status;
	if (statuses.includes('filling')) status = 'running';
	else if (statuses.includes('error')) status = 'error';
	else if (statuses.length > 0 && statuses.every(s => s === 'submitted')) status = 'done';
	else status = 'queued';

	const text = count > 99 ? '99+' : String(count);
	return { text, color: BADGE_COLOR[status] };
}

async function refreshBadge() {
	try {
		const data = await chrome.storage.session.get(['dgca_pending_rows', 'dgca_row_status']);
		const rows = data?.dgca_pending_rows || [];
		const statuses = data?.dgca_row_status || [];
		const { text, color } = computeBadgeState(rows, statuses);

		await chrome.action.setBadgeText({ text });
		if (color) {
			await chrome.action.setBadgeBackgroundColor({ color });
			// setBadgeTextColor is only available on newer Chrome — feature-detect.
			if (typeof chrome.action.setBadgeTextColor === 'function') {
				await chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => { });
			}
		}
	} catch (err) {
		console.warn('[DGCA SW] Could not refresh badge:', err);
	}
}

// Recompute whenever the queue or row statuses change (covers session start,
// per-row progress, abort, clear, and clear-done — all of which write to
// these same storage keys).
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'session') return;
	if (changes.dgca_pending_rows || changes.dgca_row_status) refreshBadge();
});

// Recompute on service-worker startup / extension install so the badge is
// correct even if it was reloaded mid-session.
chrome.runtime.onStartup?.addListener(refreshBadge);
chrome.runtime.onInstalled?.addListener(refreshBadge);
refreshBadge();

// ── Find the DGCA portal tab ──────────────────────────────────────────────────
async function findDgcaTab() {
	const tabs = await chrome.tabs.query({ url: 'https://www.dgca.gov.in/*' });
	return tabs.length > 0 ? tabs[tabs.length - 1] : null;
}