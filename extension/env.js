/*
browser extension api contact
*/

(() => {
  'use strict';

  const api =
    (typeof browser !== 'undefined' && browser.runtime && browser.runtime.id) ? browser :
    (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) ? chrome : null;
  const store = api && api.storage && api.storage.local ? api.storage.local : null;

  window.SeamloopEnv = {
    hasStore: !!store,

    version() {
      try { return api ? api.runtime.getManifest().version : '?'; } catch (_) { return '?'; }
    },

    // get(key, legacyRead) -> Promise<value|null>
    // legacyRead() is consulted (and its value migrated) when extension storage is empty
    async get(key, legacyRead) {
      if (store) {
        try {
          const r = await store.get(key);
          if (r && r[key] != null) return r[key];
        } catch (_) {}
        const legacy = legacyRead ? legacyRead() : null;
        if (legacy != null) {
          try {
            const p = store.set({ [key]: legacy });
            if (p && p.catch) p.catch(() => {});
          } catch (_) {}
          try { localStorage.removeItem(key); } catch (_) {}
        }
        return legacy;
      }
      return legacyRead ? legacyRead() : null;
    },

    set(key, value) {
      if (store) {
        try {
          const p = store.set({ [key]: value });
          if (p && p.catch) p.catch(() => {});
        } catch (_) {}
      } else {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
      }
    },
  };
})();
