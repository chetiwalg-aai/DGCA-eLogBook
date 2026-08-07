// Background service worker.
//
// Responsibilities:
//   1. Storage bridge — content scripts (dgca-filler.js on the DGCA portal,
//      injector-egcaexport.js on the EGCA-export page) go through
//      window.DGCA_STORAGE, which relays get/set/remove here via
//      chrome.runtime messages and gets live-update notifications relayed
//      back out via chrome.tabs.sendMessage. Extension pages (the popup)
//      read/write chrome.storage.session directly and don't need this
//      relay — they're already a trusted extension context.
//   2. Toolbar-icon badge — mirrors queue size/status.
//   3. Update check — GitHub-release polling on Chrome, native update flow
//      on Firefox.
//
// There is no message routing between different UI surfaces here (e.g. no
// popup-to-content-script relay for starting/aborting a fill): the queue
// and the fill session both live entirely inside dgca-filler.js's in-page
// toolbar, so those are local calls within that one content script.

// Used only by the update-check logic below, which differs between the two
// browsers (Chrome has no store listing here, so it self-checks GitHub;
// Firefox uses its own built-in update flow).
const IS_FIREFOX = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');

// ── Storage bridge for content scripts ────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'session') return;
	// Both the DGCA portal (toolbar's own queue view) and the EGCA-export
	// page (queue-mismatch banner, Clear Queue / Add to Queue button state)
	// need to react live to storage changes made from the other tab or from
	// the popup.
	chrome.tabs.query({ url: ['https://www.dgca.gov.in/*', 'https://iamatc.aai.aero/*'] }).then((tabs) => {
		for (const tab of tabs) {
			chrome.tabs.sendMessage(tab.id, { type: 'DGCA_STORAGE_CHANGED', changes, area }).catch(() => { });
		}
	}).catch(() => { });
});

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
});

// ── Extension icon badge: queue count, color-coded by status ─────────────
// Colors mirror the toolbar's own pill states:
//   queued  (rows waiting, nothing running/erroring yet) → red   (draws the eye)
//   running (a row currently 'filling')                  → blue
//   error   (at least one row 'error', nothing running)  → red
//   done    (every row 'submitted')                       → green
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
			// Only available on newer Chrome — feature-detect before calling.
			if (typeof chrome.action.setBadgeTextColor === 'function') {
				await chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => { });
			}
		}
	} catch (err) {
		console.warn('[DGCA SW] Could not refresh badge:', err);
	}
}

// Recompute whenever the queue or row statuses change — covers session
// start, per-row progress, abort, clear, and clear-done, since all of those
// write to one of these two keys.
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'session') return;
	if (changes.dgca_pending_rows || changes.dgca_row_status) refreshBadge();
});

// Recompute on service-worker startup/install so the badge is correct even
// if the worker was reloaded mid-session.
chrome.runtime.onStartup?.addListener(refreshBadge);
chrome.runtime.onInstalled?.addListener(refreshBadge);
refreshBadge();

// ── Update check (browser-dependent) ──────────────────────────────────────
// Firefox has a standard update_url, so requestUpdateCheck handles it end to
// end. Chrome isn't on the Web Store, so this diffs the installed manifest
// version against the latest GitHub release tag and stores the result for
// popup.js to show an Update button.
const GITHUB_REPO = 'chetiwalg-aai/DGCA-eLogBook';
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

// Returns > 0 if a > b, < 0 if a < b, 0 if equal. Handles "v" prefixes and
// differing segment counts (e.g. "1.2" vs "1.2.0").
function compareVersions(a, b) {
	const clean = (v) => String(v).trim().replace(/^v/i, '').split(/[.-]/).map(Number);
	const pa = clean(a), pb = clean(b);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const x = pa[i] || 0, y = pb[i] || 0;
		if (x !== y) return x - y;
	}
	return 0;
}

async function checkForUpdatesChrome() {
	try {
		const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
		if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
		const data = await res.json();
		const latestTag = data?.tag_name || '';
		const currentVersion = chrome.runtime.getManifest().version;
		if (latestTag && compareVersions(latestTag, currentVersion) > 0) {
			await chrome.storage.session.set({
				dgca_update_available: {
					version: latestTag.replace(/^v/i, ''),
					url: data.html_url || GITHUB_RELEASES_URL,
				}
			});
		}
	} catch (err) {
		console.warn('[DGCA SW] GitHub update check failed:', err);
	}
}

function checkForUpdatesFirefox() {
	try {
		chrome.runtime.requestUpdateCheck((status, details) => {
			console.log('[DGCA SW] Firefox update check:', status, details);
			// Firefox handles the actual download/install itself, so there's
			// nothing to show a popup button for — no storage write here.
		});
	} catch (err) {
		console.warn('[DGCA SW] requestUpdateCheck failed:', err);
	}
}

function checkForUpdates() {
	if (IS_FIREFOX) checkForUpdatesFirefox();
	else checkForUpdatesChrome();
}

// Startup/install only — no periodic alarm.
chrome.runtime.onStartup?.addListener(checkForUpdates);
chrome.runtime.onInstalled?.addListener(checkForUpdates);
checkForUpdates();