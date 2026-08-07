/*
dom/video plumbing shared by every phase
every timing constant named and documented here
*/

(() => {
  'use strict';

  const TIMING = {
    ARM_GRACE_MS: 5000,      // events this soon after arming are the player settling, not the user
    KICK_REPLAY_MS: 800,     // a pause this soon after a resume-gesture is the player balking, replay play() once
    FF_REPAUSE_MS: 1500,     // re-pause attempts inside this window don't count as user resistance
    FF_LEAD: 6,              // fast-fetch: jump when the buffered edge is this far ahead (s)
    FF_BACKOFF: 3,           // fast-fetch: land this far behind the edge (s)
    FF_STALL_TICKS: 30,      // ~15 s (at the watcher cadence) of no growth aborts fast-fetch
    FF_MAX_BREAKS: 1,        // stream restarts tolerated before failing (+3 when conceding to a keep-playing extension)
    FF_MAX_RESUMES: 3,       // forced resumes before conceding and capturing while playing, muted
    REC_STALL_TICKS: 120,    // ~60 s of frozen currentTime aborts a recording
    IDLE_TICKS_DIAG: 12,     // armed ticks (~6 s) without a stream before running capture diagnostics
    SYNC_TOLERANCE: 0.4,     // s of visual drift before re-seeking the video under an engaged loop
    SEEK_MATCH_EPS: 0.25,    // ledger tolerance when matching a 'seeking' event to one of our own seeks (s)
    WATCH_INTERVAL_MS: 500,  // watcher cadence (FF_STALL_TICKS / REC_STALL_TICKS count these beats)
    SYNC_INTERVAL_MS: 250,   // engaged visual re-sync cadence
    ANALYSIS_CAP_SEC: 60 * 20, // decode/analysis memory guard
  };

  const clock = (t) => {
    t = Math.max(0, Math.round(t));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const ss = String(s).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
  };

  const onWatchPage = () => location.pathname === '/watch' || location.hostname === 'music.youtube.com';

  const getVideoEl = () =>
    document.querySelector('#movie_player video') ||
    document.querySelector('video.html5-main-video') ||
    document.querySelector('video');

  const adShowing = () => {
    const p = document.getElementById('movie_player');
    return !!(p && p.classList.contains('ad-showing'));
  };

  // macrotask yield that isn't throttled like setTimeout in background tabs
  const chanYield = () =>
    new Promise((res) => {
      const mc = new MessageChannel();
      mc.port1.onmessage = () => { mc.port1.close(); res(); };
      mc.port2.postMessage(0);
    });

  const bufferedEnd = (v) => {
    try { return v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0; } catch (_) { return 0; }
  };

  // end of the buffered range the playhead sits in (falls back to the last range)
  const activeRangeEnd = (v) => {
    try {
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) {
        if (v.currentTime >= b.start(i) - 0.5 && v.currentTime <= b.end(i) + 0.05) return b.end(i);
      }
    } catch (_) {}
    return bufferedEnd(v);
  };

  const safePlay = (v) => {
    try {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  };

  const userEverActive = () => {
    try {
      const ua = navigator.userActivation;
      return ua ? !!ua.hasBeenActive : true;
    } catch (_) { return true; }
  };

  // every programmatic seek goes through the ledger so the 'seeking' handler can
  // tell our seeks from the user's, capped so a missed consume can't grow it
  class SeekLedger {
    constructor() { this.pending = []; }
    expect(t) {
      this.pending.push(t);
      if (this.pending.length > 8) this.pending.shift();
    }
    seek(v, t) {
      this.expect(t);
      try { v.currentTime = t; } catch (_) {}
    }
    consume(t) {
      for (let i = 0; i < this.pending.length; i++) {
        if (Math.abs(this.pending[i] - t) < TIMING.SEEK_MATCH_EPS) {
          this.pending.splice(i, 1);
          return true;
        }
      }
      return false;
    }
  }

  // single owner of "we muted the element": remembers the user's muted state
  // once, re-asserts while held, restores exactly once on release
  class MuteHold {
    constructor() { this.owned = null; }
    get held() { return this.owned !== null; }
    hold(v) {
      if (this.owned === null && v) {
        this.owned = v.muted;
        try { v.muted = true; } catch (_) {}
      }
    }
    reassert(v) {
      if (this.owned !== null && v) {
        try { if (!v.muted) v.muted = true; } catch (_) {}
      }
    }
    release(v) {
      if (this.owned !== null && v) {
        try { v.muted = this.owned; } catch (_) {}
      }
      this.owned = null;
    }
  }

  window.SeamloopPlayerIO = {
    TIMING, clock, onWatchPage, getVideoEl, adShowing,
    chanYield, bufferedEnd, activeRangeEnd, safePlay, userEverActive,
    SeekLedger, MuteHold,
  };
})();
