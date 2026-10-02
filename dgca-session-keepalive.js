/**
 * DGCA session keep-alive (MAIN world).
 *
 * The portal's PHPMaker timer normally starts a logout countdown because
 * SESSION_KEEP_ALIVE_INTERVAL is 0 in blueBook.html. During an extension fill
 * session we temporarily disable that client-side countdown and ping the
 * portal's own session endpoint. On completion/abort, the original timer
 * configuration is restored.
 */
(function () {
    'use strict';

    const EVENT = 'dgca_session_state_changed';
    const INTERVAL_MS = 60 * 1000;
    let running = false;
    let timer = null;
    let originals = null;

    function stopHeartbeat() {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    }

    async function pingSession() {
        if (!running || !window.ew) return;
        try {
            const url = new URL('api/session', window.location.href);
            url.searchParams.set('rnd', String(Date.now()));
            const response = await fetch(url.href, {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (!response.ok) return;

            // Match the portal's own session-refresh behavior where possible.
            const data = await response.json().catch(() => null);
            if (!data || !window.ew) return;
            if (window.ew.TOKEN_NAME_KEY && data[window.ew.TOKEN_NAME_KEY] !== undefined)
                window.ew.TOKEN_NAME = data[window.ew.TOKEN_NAME_KEY];
            if (window.ew.ANTIFORGERY_TOKEN_KEY && data[window.ew.ANTIFORGERY_TOKEN_KEY] !== undefined)
                window.ew.ANTIFORGERY_TOKEN = data[window.ew.ANTIFORGERY_TOKEN_KEY];
            if (data.JWT) window.ew.API_JWT_TOKEN = data.JWT;
        } catch (_) {
            // A transient heartbeat failure should not interrupt the fill loop.
        }
    }

    function startHeartbeat() {
        stopHeartbeat();
        pingSession();
        timer = setInterval(pingSession, INTERVAL_MS);
    }

    function setRunning(next) {
        next = !!next;
        if (next === running) return;
        running = next;

        if (running) {
            if (window.ew && originals === null) {
                originals = {
                    timeout: window.ew.SESSION_TIMEOUT,
                    keepAlive: window.ew.SESSION_KEEP_ALIVE_INTERVAL,
                };

                // Cancel the portal's countdown while the extension is filling.
                window.ew.SESSION_TIMEOUT = 0;
                window.ew.SESSION_KEEP_ALIVE_INTERVAL = 0;
                try { window.ew.setSessionTimer?.(); } catch (_) {}
            }
            startHeartbeat();
        } else {
            stopHeartbeat();
            if (window.ew && originals) {
                window.ew.SESSION_TIMEOUT = originals.timeout;
                window.ew.SESSION_KEEP_ALIVE_INTERVAL = originals.keepAlive;
                try { window.ew.setSessionTimer?.(); } catch (_) {}
            }
            originals = null;
        }
    }

    window.addEventListener(EVENT, event => setRunning(!!event.detail?.running));
})();
