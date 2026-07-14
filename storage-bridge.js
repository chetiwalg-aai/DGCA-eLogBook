/**
storage-bridge.js
Content scripts (on both Chrome and Firefox) cannot rely on direct access to
chrome.storage.session:
  - Chrome blocks it by default unless the background script calls
    storage.session.setAccessLevel({accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'}).
  - Firefox has no setAccessLevel escape hatch at all — content scripts are
    permanently blocked from storage.session there.

So instead of touching chrome.storage.session directly, content scripts go
through this bridge, which relays get/set/remove calls to the background
script (a trusted context on both browsers) via runtime messaging, and
listens for change broadcasts the background re-emits from its own
storage.onChanged listener.

Must be loaded before any content script file that used to call
chrome.storage.session.* directly.
*/
(function () {
	'use strict';

	function get(keys) {
		return chrome.runtime.sendMessage({ type: 'DGCA_STORAGE_GET', keys }).then((resp) => {
			if (!resp || !resp.ok) throw new Error(resp?.error || 'storage get failed');
			return resp.value || {};
		});
	}

	function set(items) {
		return chrome.runtime.sendMessage({ type: 'DGCA_STORAGE_SET', items }).then((resp) => {
			if (!resp || !resp.ok) throw new Error(resp?.error || 'storage set failed');
			return resp;
		});
	}

	function remove(keys) {
		return chrome.runtime.sendMessage({ type: 'DGCA_STORAGE_REMOVE', keys }).then((resp) => {
			if (!resp || !resp.ok) throw new Error(resp?.error || 'storage remove failed');
			return resp;
		});
	}

	// Mirrors chrome.storage.onChanged's (changes, area) callback signature.
	// Fires only for area === 'session', re-broadcast from the background
	// script's own (trusted-context) storage.onChanged listener.
	const _listeners = new Set();
	function onChanged(callback) {
		_listeners.add(callback);
	}

	chrome.runtime.onMessage.addListener((msg) => {
		if (msg && msg.type === 'DGCA_STORAGE_CHANGED') {
			for (const cb of _listeners) {
				try { cb(msg.changes, msg.area); } catch (_) { }
			}
		}
	});

	window.DGCA_STORAGE = { get, set, remove, onChanged };
})();
