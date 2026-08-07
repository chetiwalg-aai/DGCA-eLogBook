// Popup UI logic.
//
// This popup is intentionally minimal: it shows how many rows are queued
// (and for whom), an update banner, a Clear All action, and the footer
// credit/version. Everything else — viewing/managing individual rows,
// starting a fill session, aborting — happens in the in-page toolbar that
// dgca-filler.js injects on the DGCA e-Log Book entry page.
const { escHtml } = window.DGCA;

const $ = id => document.getElementById(id);
const badge = $('badge');
const queueCount = $('queue-count');
const queueUserInfo = $('queue-user-info');
const updateBanner = $('update-banner');
const updateBannerText = $('update-banner-text');
const btnUpdate = $('btn-update');
const btnClear = $('btn-clear');

function setBadge(label, cls) {
	badge.textContent = label;
	badge.className = `badge badge--${cls}`;
}

function renderUpdateBanner(info) {
	if (info && info.url) {
		updateBannerText.textContent = info.version
			? `Version ${info.version} is available`
			: 'A new version is available';
		updateBanner.style.display = 'flex';
		btnUpdate.onclick = () => chrome.tabs.create({ url: info.url });
	} else {
		updateBanner.style.display = 'none';
		btnUpdate.onclick = null;
	}
}

function renderQueueUser(user) {
	if (!user || (!user.name && !user.loginId)) {
		queueUserInfo.style.display = 'none';
		return;
	}
	const name = user.name || user.loginId;
	const loginBadge = (user.loginId && user.loginId !== name)
		? `<span class="queue-user-login">(${escHtml(user.loginId)})</span>` : '';
	queueUserInfo.innerHTML = `👤 Queued for <strong>${escHtml(name)}</strong>${loginBadge}`;
	queueUserInfo.style.display = 'flex';
}

function render(rows, queueUser, sessionRunning) {
	queueCount.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} queued`;
	setBadge(rows.length > 0 ? 'Queued' : 'Idle', rows.length > 0 ? 'queued' : 'idle');
	renderQueueUser(queueUser);
	// Clear All is locked out while the DGCA-page toolbar is mid-session:
	// the toolbar is the source of truth for the queue while a fill is
	// running, and clearing it out from under an in-flight row would desync
	// indices with no clean recovery. The toolbar disables its own Clear
	// All / row-delete for the same reason.
	btnClear.disabled = rows.length === 0 || !!sessionRunning;
	btnClear.title = sessionRunning ? 'Cannot clear while a fill session is running' : '';
}

function loadFromStorage() {
	chrome.storage.session
		.get(['dgca_pending_rows', 'dgca_queue_user', 'dgca_update_available', 'dgca_session_running'])
		.then((data) => {
			renderUpdateBanner(data?.dgca_update_available || null);
			render(data?.dgca_pending_rows || [], data?.dgca_queue_user || null, data?.dgca_session_running);
		}).catch(() => { });
}

btnClear.addEventListener('click', async () => {
	if (btnClear.disabled) return;
	// Re-check right before acting: the button's disabled state can be a
	// moment stale if a session started between the last render and click.
	try {
		const data = await chrome.storage.session.get(['dgca_session_running']);
		if (data?.dgca_session_running) { loadFromStorage(); return; }
	} catch (_) { }
	if (!confirm('Clear the entire queue?')) return;
	chrome.storage.session
		.remove(['dgca_pending_rows', 'dgca_row_status', 'dgca_row_errors', 'dgca_row_timings', 'dgca_session_ts', 'dgca_queue_user'])
		.then(loadFromStorage)
		.catch(() => { });
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'session') return;
	if (changes.dgca_pending_rows || changes.dgca_queue_user || changes.dgca_update_available || changes.dgca_session_running) {
		loadFromStorage();
	}
});

loadFromStorage();

(function showAppVersion() {
	const versionEl = document.getElementById('app-version');
	if (!versionEl) return;
	try {
		versionEl.textContent = chrome.runtime.getManifest().version;
	} catch (err) {
		console.warn('[DGCA Popup] Could not read manifest version:', err);
	}
})();