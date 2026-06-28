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

// ── Find the DGCA portal tab ──────────────────────────────────────────────────
async function findDgcaTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.dgca.gov.in/*' });
  return tabs.length > 0 ? tabs[tabs.length - 1] : null;
}