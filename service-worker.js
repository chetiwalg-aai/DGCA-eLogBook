// ── Allow content scripts to access session storage directly ─────────────────
chrome.storage.session.setAccessLevel({
  accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
}).catch((err) => {
  console.warn('[DGCA SW] Could not set session access level:', err);
});

// ── Open side panel when extension icon is clicked ───────────────────────────
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Source page queued rows → notify side panel if open
  if (msg.type === 'ROWS_QUEUED') {
    chrome.runtime.sendMessage({ type: 'ROWS_READY', count: msg.count })
      .catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  // Side panel wants to start filling → find DGCA tab and relay rows
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

        chrome.tabs.sendMessage(dgcaTab.id, { type: 'START_FILLING', rows }, (resp) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: 'Could not reach DGCA tab. Make sure you are on the entry page.' });
          } else {
            sendResponse(resp);
          }
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
    chrome.runtime.sendMessage(msg).catch(() => {});
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
          sendResponse({ ok: true, url: resp?.url });
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
  queued:  '#e53935', // red
  running: '#2196f3', // blue
  error:   '#ef5350', // red
  done:    '#4caf50', // green
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
        await chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => {});
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