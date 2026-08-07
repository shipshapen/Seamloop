/*
drive the (muted, ideally paused) player along its buffered edge
youtube fetches the whole audio stream at network speed
page-hook.js and the mse store see the bytes as they pass
every fast-fetch-local variable lives on the instance and dies with it
the controller creates one on entering the fetch phase and drops it on exit
*/

(() => {
  'use strict';

  const { TIMING, activeRangeEnd, userEverActive } = SeamloopPlayerIO;

  class FastFetch {
    // io: { seeks: SeekLedger, mute: MuteHold }
    constructor(v, io) {
      this.io = io;
      this.savedTime = v.currentTime;
      this.savedPaused = v.paused;
      this.streamId = 0;
      this.breaks = 0;         // stream restarts seen (player fighting back)
      this.stallTicks = 0;
      this.lastSpan = 0;
      this.reanchored = false; // one-shot: rewound once because capture missed the head
      this.resumes = 0;        // foreign play() calls while we want the element paused
      this.unpausable = false; // conceded to a keep-playing extension: capture while playing, muted
      this.pausedAt = 0;
      this.expectPause = false;
      io.mute.hold(v);
      // paused: the player stops fighting the mute, fetching goes bursty, the
      // playhead can't drift - fetching itself continues regardless
      if (!v.paused) this._tryPause(v);
    }

    _tryPause(v) {
      this.expectPause = true;
      this.pausedAt = Date.now();
      try { v.pause(); } catch (_) { this.expectPause = false; this.pausedAt = 0; }
    }

    // the pause handler asks: was this pause one of ours?
    consumeExpectedPause() {
      const b = this.expectPause;
      this.expectPause = false;
      return b;
    }

    // the player fired 'play' while we want it paused, decide the response:
    // 'repause' (we pushed back) | 'concede' (keep-playing extension: capture
    // while playing, muted) | 'cancel' (a real user resumed)
    onForeignPlay(v, withinGrace) {
      this.resumes++;
      if (this.unpausable) {
        try { v.muted = true; } catch (_) {}
        return 'concede';
      }
      if (this.resumes >= TIMING.FF_MAX_RESUMES) {
        // count resumes: keep-playing extensions force-resume repeatedly, a real
        // user can't - stop fighting and capture while playing, muted
        this.unpausable = true;
        try { v.muted = true; } catch (_) {}
        console.info('[Seamloop] video refuses to stay paused (a keep-playing extension?) - capturing while playing, muted');
        return 'concede';
      }
      if ((this.pausedAt && Date.now() - this.pausedAt < TIMING.FF_REPAUSE_MS) || withinGrace || !userEverActive()) {
        try { v.muted = true; } catch (_) {}
        this._tryPause(v);
        return 'repause';
      }
      return 'cancel';
    }

    // one watcher beat, returns { action: 'continue'|'complete'|'fail', ... }
    tick(v, pick) {
      try { if (!v.muted) v.muted = true; } catch (_) {}

      // the capture missed the head of the file: rewind once so the player
      // re-fetches from 0 (unless the head is already buffered and will re-append)
      if (pick.origin > 1 && !this.reanchored) {
        this.reanchored = true;
        let headBuffered = false;
        try { headBuffered = v.buffered.length > 0 && v.buffered.start(0) <= 0.5; } catch (_) {}
        if (!headBuffered) {
          this.streamId = 0; this.breaks = 0;
          this.stallTicks = 0; this.lastSpan = 0;
          this.io.seeks.seek(v, 0);
          return { action: 'continue' };
        }
      }

      if (pick.origin + pick.span >= v.duration - 2 || pick.span >= TIMING.ANALYSIS_CAP_SEC) {
        return { action: 'complete' };
      }

      if (pick.stream.id !== this.streamId) {
        const maxBreaks = this.unpausable ? TIMING.FF_MAX_BREAKS + 3 : TIMING.FF_MAX_BREAKS;
        if (this.streamId && ++this.breaks > maxBreaks) {
          return { action: 'fail', msg: 'Player fought the fetch.' };
        }
        this.streamId = pick.stream.id;
      }

      if (pick.span <= this.lastSpan + 0.05) {
        if (++this.stallTicks > TIMING.FF_STALL_TICKS) {
          return { action: 'fail', msg: 'Fetch stalled.' };
        }
      } else {
        this.stallTicks = 0;
        this.lastSpan = pick.span;
      }

      const be = activeRangeEnd(v);
      if (be - v.currentTime > TIMING.FF_LEAD) {
        const target = Math.min(be - TIMING.FF_BACKOFF, v.duration - 8);
        if (target > v.currentTime + 0.5) this.io.seeks.seek(v, target);
      }

      const target = Math.min(v.duration, TIMING.ANALYSIS_CAP_SEC);
      return {
        action: 'continue',
        progress: Math.min(1, pick.span / target),
        status: 'Scanning\u2026 ' + Math.min(pick.span, target).toFixed(0) + 's / ' + target.toFixed(0) + 's',
      };
    }

    // restore element state, returns the saved position for a later restore
    // opts: { keepMuted, restorePos, resume }
    stop(v, opts = {}) {
      this.expectPause = false;
      try {
        if (v) {
          if (!opts.keepMuted) this.io.mute.release(v);
          if (opts.restorePos) this.io.seeks.seek(v, this.savedTime);
          if (opts.resume && !this.savedPaused && v.paused) {
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
          }
        }
      } catch (_) {}
      return { savedTime: this.savedTime, savedPaused: this.savedPaused };
    }
  }

  window.SeamloopFastFetch = FastFetch;
})();
