/*
phases:
wait (armed, waiting for a stream)
fetch (fast-fetch driving the buffered edge)
record (slow pcm capture)
analyzing | ready | engaged | failed | idle
every phase-local variable lives on the phase session and dies on transition
video events are dispatched to the current phase's handler table
seek ledger filters out our own seeks before dispatch
*/

(() => {
  'use strict';
  if (window.__seamloopLoaded) return;
  window.__seamloopLoaded = true;

  const {
    TIMING, onWatchPage, getVideoEl, adShowing, chanYield, activeRangeEnd,
    safePlay, userEverActive, SeekLedger, MuteHold,
  } = SeamloopPlayerIO;

  try { console.info('[Seamloop] content script v' + SeamloopEnv.version() + ' loaded'); } catch (_) {}

  // shared services

  const seeks = new SeekLedger();
  const mute = new MuteHold();
  const graph = new SeamloopAudioGraph.Graph();
  const player = new SeamloopAudioGraph.LoopPlayer(graph);
  const mseStore = typeof MseCaptureStore !== 'undefined' ? new MseCaptureStore() : null;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'SEAMLOOP_MSE') return;
    if (mseStore) mseStore.onEvent(e.data);
  });
  try { window.postMessage({ type: 'SEAMLOOP_MSE_CS_READY' }, '*'); } catch (_) {}

  // cross-phase context

  let videoId = null;
  let result = null;                 // { bufferStart, bufferEnd, mediaStart, mediaEnd, confidence, details }
  let captureStartMediaTime = 0;     // buffer time t maps to media time captureStartMediaTime + t
  let failedTerminal = false;        // failed in a way Reload can't fix (no store / progressive stream)
  let mseDecoded = null, mseMeta = null; // decode cache, keyed by a stream stamp
  let analysisCancel = null;
  let idleTicks = 0;
  const diagWarned = new Set();

  const pickMseStream = (minSpanSec) => {
    if (!mseStore) return null;
    const v = getVideoEl();
    return mseStore.pickStream(v ? activeRangeEnd(v) : Infinity, minSpanSec);
  };

  // machine

  const machine = {
    phase: 'idle',
    session: {},
    to(name, session) {
      const prev = phases[this.phase];
      if (prev && prev.exit) prev.exit(this.session);
      this.phase = name;
      this.session = session || {};
      panel.render();
    },
    is(...names) { return names.indexOf(this.phase) !== -1; },
    dispatch(evt, v) {
      const h = phases[this.phase] && phases[this.phase][evt];
      if (h) h(this.session, v);
    },
  };

  // events within the grace window after arming are the player settling, not the user
  const withinGrace = (s) => !!s.armedAt && Date.now() - s.armedAt < TIMING.ARM_GRACE_MS;

  function setStatus(t) { panel.status(t); }
  function progress(p) { panel.progress(p); }

  function toFailed(msg) {
    machine.to('failed');
    setStatus(msg);
  }

  function cancelArm(v, msg) {
    mute.release(v);
    machine.to('idle');
    setStatus(msg);
  }

  // analysis

  const analysisYield = (tok) => () => (tok.cancelled
    ? Promise.reject(Object.assign(new Error('Analysis cancelled'), { seamloopCancelled: true }))
    : chanYield());

  function cancelAnalysis() {
    if (analysisCancel && !analysisCancel.cancelled) {
      analysisCancel.cancelled = true;
      setStatus('Cancelling\u2026');
    }
  }

  // shared success tail for both capture paths
  function adoptResult(buf, res, originMediaTime) {
    captureStartMediaTime = originMediaTime;
    player.load(buf, res.loopStart, res.loopEnd);
    const s = panel.getSettings();
    player.applyXfade(s.xfadeOn, s.xfadeMs);
    result = {
      bufferStart: res.loopStart,
      bufferEnd: res.loopEnd,
      mediaStart: originMediaTime + res.loopStart,
      mediaEnd: originMediaTime + res.loopEnd,
      confidence: res.confidence,
      details: res.details,
    };
  }

  // fast path: decode the captured mse stream and search it
  async function analyzeMse() {
    const pick = pickMseStream(8);
    if (!pick) { setStatus('No stream captured yet.'); return; }
    if (machine.is('analyzing', 'engaged')) return;

    const v = getVideoEl();
    const wasArmed = machine.is('wait', 'fetch');
    let ffSaved = null;
    if (machine.is('fetch') && machine.session.ff) {
      ffSaved = machine.session.ff.stop(v, { keepMuted: true });
    }
    machine.to('analyzing', { viaRecord: false });
    graph.ensureCtx();
    graph.resume();

    let pausedHere = false;
    const restoreAfterFail = () => {
      if (v) mute.release(v);
      if (ffSaved && v) {
        seeks.seek(v, ffSaved.savedTime);
        if (!ffSaved.savedPaused && v.paused) safePlay(v);
      } else if (pausedHere && v && v.paused) {
        safePlay(v);
      }
    };

    if (v && !v.paused && (wasArmed || (isFinite(v.duration) && v.duration - v.currentTime < 10))) {
      try { v.pause(); pausedHere = !ffSaved; } catch (_) {}
    }
    if (wasArmed && v) { mute.hold(v); try { v.muted = true; } catch (_) {} }

    const tok = { cancelled: false };
    analysisCancel = tok;
    const yieldFn = analysisYield(tok);
    const startVid = videoId;
    try {
      const stamp = pick.stream.id + ':' + pick.stream.bytes + ':' + pick.stream.unacked;
      if (!mseDecoded || !mseMeta || mseMeta.stamp !== stamp) {
        setStatus('Decoding\u2026'); progress(0.04);
        if (pick.stream.unacked > 0) {
          console.debug('[Seamloop] excluding ' + pick.stream.unacked +
            ' in-flight append(s) from analysis (not yet acked)');
        }
        let bytes = mseStore.assemble(pick.stream, true);

        const clean = MseCaptureStore.sanitizeWebm(bytes);
        if (clean.dropped) {
          console.log('[Seamloop] sanitized stream: dropped ' + clean.dropped + ' duplicate/backward WebM cluster(s)');
          bytes = clean.bytes;
        }

        let effSpan = pick.span;
        if (pick.span > TIMING.ANALYSIS_CAP_SEC) {
          const cut = MseCaptureStore.truncateWebm(bytes, TIMING.ANALYSIS_CAP_SEC * 1000);
          if (!cut.truncated) {
            throw new Error('stream spans ' + pick.span.toFixed(0) + 's, exceeding the ' +
              Math.round(TIMING.ANALYSIS_CAP_SEC / 60) + ' min analysis cap, and could not be truncated (non-WebM audio)');
          }
          console.log('[Seamloop] stream spans ' + pick.span.toFixed(0) +
            's - truncated to the ' + Math.round(TIMING.ANALYSIS_CAP_SEC / 60) + ' min analysis cap before decode');
          bytes = cut.bytes;
          effSpan = TIMING.ANALYSIS_CAP_SEC;
        }

        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        mseDecoded = await graph.ctx.decodeAudioData(ab);
        mseMeta = { origin: pick.origin, span: pick.span, stamp };

        const dd = mseDecoded.duration - effSpan;
        const tol = Math.max(2, effSpan * 0.03);
        if (effSpan && dd < -tol) {
          throw new Error(
            'decoded ' + mseDecoded.duration.toFixed(1) + 's but the acked stream spans ' +
            effSpan.toFixed(1) + 's - stream has holes, or append/ack pairing drifted (diag.ackDrift=' +
            (mseStore.diag.ackDrift || 0) + ')'
          );
        }
        if (effSpan && dd > tol) {
          console.warn('[Seamloop] decoded ' + mseDecoded.duration.toFixed(1) +
            's exceeds the acked span (' + effSpan.toFixed(1) +
            's) - span under-credited under ack churn; the decode is authoritative, proceeding');
        }
        console.log('[Seamloop] MSE stream decoded', {
          bytes: pick.stream.bytes, origin: pick.origin.toFixed(2),
          span: pick.span.toFixed(1), decoded: mseDecoded.duration.toFixed(1),
          frozen: pick.stream.frozen, reason: pick.stream.reason,
        });
      }

      const cfg = panel.getSettings();
      await yieldFn();

      const mono = LoopFinder.downmix(mseDecoded);
      const res = await LoopFinder.analyzeSamples(
        mono, mseDecoded.sampleRate,
        { minLoopSec: cfg.minLoopSec, simThreshold: cfg.simThreshold, yieldFn: yieldFn },
        (p, label) => { progress(p); setStatus(label + (label === 'Done' ? '.' : '\u2026')); }
      );
      progress(0);
      if (!res.found) {
        const partial = pick.origin > 1 ||
          (v && isFinite(v.duration) && pick.origin + mseDecoded.duration < v.duration - 2);
        console.info('[Seamloop] no loop:', res.reason);
        toFailed(partial ? 'No loop in partial capture.' : 'No loop found. Lower threshold?');
        restoreAfterFail();
        return;
      }
      if (videoId !== startVid) {
        console.info('[Seamloop] analysis finished after navigation - result discarded');
        return;
      }

      adoptResult(mseDecoded, res, mseMeta.origin);
      machine.to('ready');
      setStatus('Loop found.');
      console.info('[Seamloop] loop found', {
        mediaStart: result.mediaStart.toFixed(3),
        mediaEnd: result.mediaEnd.toFixed(3),
        confidence: Math.round(result.confidence * 100) + '%',
        details: res.details,
      });
      engage();

      if (machine.is('engaged')) {
        if (graph.ctx && graph.ctx.state === 'running') {
          if (v) mute.release(v);
          updateLoopGain();
        }
      } else {
        try { if (v && !v.paused) v.pause(); } catch (_) {}
        if (v) mute.release(v);
      }
    } catch (err) {
      progress(0);
      if (err && err.seamloopCancelled) {
        machine.to('idle');
        setStatus('Cancelled.');
        restoreAfterFail();
        return;
      }
      mseDecoded = null; mseMeta = null;
      if (pick && pick.stream) pick.stream.bad = true;
      const oflow = mseStore.overflowed;
      toFailed(oflow ? 'Capture overflowed: reload.' : 'Capture failed (see console)');
      console.warn('[Seamloop] capture failed for this video' +
        (oflow ? ' (hook relay queue overflowed; the stream has holes)' : ''), err);
      restoreAfterFail();
    } finally {
      if (analysisCancel === tok) analysisCancel = null;
    }
  }

  // slow path: drain the recorder, assemble a buffer, search it
  async function finishRecording(v) {
    if (!machine.is('record')) return;
    const rec = machine.session.rec;
    if (rec.finishing) return;

    const data = await rec.drain(v);
    if (!data || !machine.is('record') || machine.session.rec !== rec) return;

    machine.to('analyzing', { viaRecord: true });
    rec.disconnectNodes();
    rec.restoreElementAttrs(v);

    const restoreAfterFail = () => {
      if (graph.passGain) graph.passGain.gain.value = 1;
      try { if (data.saved.paused && !v.paused) v.pause(); } catch (_) {}
      seeks.seek(v, data.saved.time);
      if (!data.saved.paused && v.paused) safePlay(v);
    };

    const tok = { cancelled: false };
    analysisCancel = tok;
    const yieldFn = analysisYield(tok);
    const startVid = videoId;
    try {
      if (data.frames < graph.ctx.sampleRate * 8) {
        throw new Error('recording too short (' + (data.frames / graph.ctx.sampleRate).toFixed(1) + 's captured)');
      }
      setStatus('Assembling\u2026');
      progress(0.02);
      const buf = graph.ctx.createBuffer(2, data.frames, graph.ctx.sampleRate);
      let off = 0;
      for (const pair of data.chunks) {
        buf.copyToChannel(pair[0], 0, off);
        buf.copyToChannel(pair[1], 1, off);
        off += pair[0].length;
      }
      data.chunks.length = 0;
      const expected = isFinite(v.duration) && v.duration
        ? Math.min(v.duration, TIMING.ANALYSIS_CAP_SEC) : buf.duration;
      if (Math.abs(buf.duration - expected) > Math.max(2, expected * 0.03)) {
        console.warn('[Seamloop] recorded ' + buf.duration.toFixed(1) + 's of an intended ' + expected.toFixed(1) +
          's (' + data.splices + ' gate splice(s)) - timeline may drift; visuals re-sync each pass.');
      }
      console.log('[Seamloop] re-record captured', {
        seconds: buf.duration.toFixed(1), splices: data.splices, worklet: data.worklet,
      });
      const mono = LoopFinder.downmix(buf);
      const cfg = panel.getSettings();
      const res = await LoopFinder.analyzeSamples(
        mono, graph.ctx.sampleRate,
        { minLoopSec: cfg.minLoopSec, simThreshold: cfg.simThreshold, yieldFn: yieldFn },
        (p, label) => { progress(p); setStatus(label + (label === 'Done' ? '.' : '\u2026')); }
      );
      progress(0);
      if (!res.found) {
        const partial = isFinite(v.duration) && buf.duration < v.duration - 2;
        console.info('[Seamloop] no loop (re-record):', res.reason);
        toFailed(partial ? 'No loop in partial recording.' : 'No loop found. Lower threshold?');
        restoreAfterFail();
        return;
      }
      if (videoId !== startVid) {
        console.info('[Seamloop] analysis finished after navigation - result discarded');
        return;
      }

      adoptResult(buf, res, 0);
      machine.to('ready');
      setStatus('Loop found.');
      console.info('[Seamloop] loop found (re-record)', {
        mediaStart: result.mediaStart.toFixed(3),
        mediaEnd: result.mediaEnd.toFixed(3),
        confidence: Math.round(result.confidence * 100) + '%',
        details: res.details,
      });
      engage();
    } catch (err) {
      progress(0);
      if (err && err.seamloopCancelled) {
        machine.to('idle');
        setStatus('Cancelled.');
        restoreAfterFail();
        return;
      }
      toFailed('Recording failed (see console)');
      console.warn('[Seamloop] re-record capture failed', err);
      restoreAfterFail();
    } finally {
      if (analysisCancel === tok) analysisCancel = null;
    }
  }

  // engagement

  const enginePos = () =>
    machine.is('engaged') && machine.session.paused ? machine.session.pausedPos : player.pos();

  function updateLoopGain() {
    if (!graph.loopGain || !result || !graph.video) return;
    graph.loopGain.gain.value = graph.video.muted ? 0 : graph.video.volume;
  }

  let gestureHooked = false;
  function resumeOnGesture() {
    setStatus('Click page to begin playback.');
    if (gestureHooked) return;
    gestureHooked = true;
    const kick = (e) => {
      try {
        if (e && typeof e.composedPath === 'function' &&
            e.composedPath().some((n) => n && n.id === 'seamloop-host')) return;
      } catch (_) {}
      gestureHooked = false;
      document.removeEventListener('pointerdown', kick, true);
      document.removeEventListener('keydown', kick, true);
      const v = getVideoEl();
      if (!machine.is('engaged')) { mute.release(v); return; }
      machine.session.kickAt = Date.now();
      machine.session.kickReplayed = false;
      graph.resume();
      mute.release(v);
      updateLoopGain();
      setStatus('Looping\u2026');
      setTimeout(() => {
        try { if (machine.is('engaged') && v && v.paused) safePlay(v); } catch (_) {}
      }, 250);
    };
    document.addEventListener('pointerdown', kick, true);
    document.addEventListener('keydown', kick, true);
  }

  function startSyncTimer() {
    const s = machine.session;
    clearInterval(s.syncTimer);
    s.silentTicks = 0;
    s.silenceWarned = false;
    s.syncTimer = setInterval(() => {
      if (!machine.is('engaged')) return;
      const st = machine.session;
      if (st.paused || !player.src) return;
      if (graph.ctx && graph.ctx.state !== 'running') return;
      const v = graph.video;
      const mt = captureStartMediaTime + player.pos();
      if (Math.abs(v.currentTime - mt) > TIMING.SYNC_TOLERANCE) seeks.seek(v, mt);
      const db = graph.meterDb();
      const g = graph.loopGain.gain.value;
      if (db === -Infinity && g > 0.01) {
        if (++st.silentTicks > 6 && !st.silenceWarned) {
          st.silenceWarned = true;
          setStatus('Loop silent (see console)');
          console.warn('[Seamloop] engaged but meter reads silence', {
            gain: g, ctxState: graph.ctx.state, bufferPos: player.pos().toFixed(2),
          });
        }
      } else {
        st.silentTicks = 0;
      }
    }, TIMING.SYNC_INTERVAL_MS);
  }

  function engage() {
    if (!result || !player.buf) return;
    const v = getVideoEl();
    try {
      if (graph.ensure(v)) ensureVideoEvents(v);
    } catch (err) {
      setStatus(err.message);
      panel.render();
      return;
    }
    graph.resume();
    machine.to('engaged', { paused: false, pausedPos: 0, kickAt: 0, kickReplayed: false, syncTimer: 0 });
    player.play(0);
    graph.passGain.gain.value = 0;
    updateLoopGain();
    console.log('[Seamloop] engage', {
      loopStart: result.bufferStart.toFixed(3),
      loopEnd: result.bufferEnd.toFixed(3),
      startOffset: player.startOffset.toFixed(3),
      loopGain: graph.loopGain.gain.value.toFixed(3),
      videoVolume: v.volume.toFixed(3),
      videoMuted: v.muted,
      ctxState: graph.ctx.state,
    });
    seeks.seek(v, captureStartMediaTime + player.pos());

    const bridged = !graph.ctx || graph.ctx.state !== 'running';
    if (bridged) {
      resumeOnGesture();
    } else if (v.paused) {
      try {
        const p = v.play();
        if (p && p.catch) p.catch(() => resumeOnGesture());
      } catch (_) { resumeOnGesture(); }
    }
    startSyncTimer();
    if (!bridged) setStatus('Looping\u2026');
    panel.render();
  }

  function disengage(msg) {
    player.stop();
    if (graph.passGain) graph.passGain.gain.value = 1;
    machine.to(result ? 'ready' : 'idle');
    setStatus(msg || (result ? 'Disengaged.' : 'Idle.'));
  }

  // phase handlers

  const resumeCtxOnPlay = () => graph.resume();

  const phases = {
    idle: {
      onPlay: resumeCtxOnPlay,
    },

    // armed, fast mode, waiting for the mse store to surface a stream
    wait: {
      onForeignSeek(s, v) {
        if (v.currentTime < 1) return; // player restarts to 0 are not the user
        if (withinGrace(s) || !userEverActive()) return;
        cancelArm(v, 'Cancelled (by seek)');
      },
      onPause(s) {
        if (s.expectPause) s.expectPause = false; // our priming pause
      },
      onPlay: resumeCtxOnPlay,
    },

    fetch: {
      onForeignSeek(s, v) {
        if (v.currentTime < 1) {
          console.debug('[Seamloop] player restarted to 0 mid-fetch - retreating');
          s.ff.stop(v, {});
          machine.to('wait', { armedAt: s.armedAt, primed: true });
        } else if (!withinGrace(s) && userEverActive()) {
          s.ff.stop(v, {});
          machine.to('idle');
          setStatus('Cancelled (by seek)');
        }
      },
      onPause(s, v) {
        if (s.ff.consumeExpectedPause()) return;
        if (withinGrace(s) || !userEverActive()) return;
        s.ff.stop(v, { restorePos: true });
        machine.to('idle');
        setStatus('Cancelled (by pause)');
      },
      onPlay(s, v) {
        const r = s.ff.onForeignPlay(v, withinGrace(s));
        if (r === 'cancel') {
          s.ff.stop(v, { restorePos: true });
          machine.to('idle');
          setStatus('Cancelled.');
          return;
        }
        graph.resume();
      },
    },

    record: {
      onForeignSeek(s, v) {
        const rec = s.rec;
        if (rec.finishing) return;
        if (withinGrace(s)) {
          rec.gate(false);
          rec.resetCapture();
          seeks.seek(v, 0);
        } else {
          rec.disconnectNodes();
          rec.restoreElementFull(v, { keepPosition: true });
          machine.to('idle');
          setStatus('Cancelled (by seek)');
        }
      },
      onPause(s, v) {
        const rec = s.rec;
        rec.gate(false);
        if (rec.finishing) return;
        if (v.ended || (isFinite(v.duration) && v.duration - v.currentTime < 0.6)) {
          finishRecording(v);
        } else if (withinGrace(s)) {
          safePlay(v);
        } else {
          rec.disconnectNodes();
          rec.restoreElementFull(v, { keepPosition: true });
          machine.to('idle');
          setStatus('Cancelled (by pause)');
        }
      },
      onPlaying(s, v) {
        const rec = s.rec;
        if (!rec.finishing && !rec.adScrapped && !adShowing()) {
          rec.enforceElement(v);
          rec.gate(true);
        }
      },
      onWaiting(s) { s.rec.gate(false); },
      onEnded(s, v) { if (!s.rec.finishing) finishRecording(v); },
      onTimeUpdate(s, v) {
        const rec = s.rec;
        if (!rec.finishing && rec.gateOn &&
            ((isFinite(v.duration) && v.duration && v.duration - v.currentTime < 0.4) ||
             v.currentTime >= TIMING.ANALYSIS_CAP_SEC)) finishRecording(v);
      },
      onPlay(s, v) { if (!s.rec.finishing) s.rec.enforceElement(v); },
      onVolumeChange(s, v) { if (!s.rec.finishing) s.rec.enforceElement(v); },
      onRateChange(s, v) {
        if (!s.rec.finishing && v.playbackRate !== 1) {
          try { v.playbackRate = 1; } catch (_) {}
        }
      },
    },

    analyzing: {
      onForeignSeek() {}, // logged by the dispatcher, nothing to do
      onPlay(s, v) {
        // the player must not roam (fast path) or become audible (slow path) mid-analysis
        if (s.viaRecord) { try { v.pause(); } catch (_) {} return; }
        if (mute.held) {
          try { v.muted = true; } catch (_) {}
          try { v.pause(); } catch (_) {}
          return;
        }
        graph.resume();
      },
    },

    ready: {
      onPlay: resumeCtxOnPlay,
    },

    engaged: {
      exit(s) { clearInterval(s.syncTimer); s.syncTimer = 0; },
      onForeignSeek(s, v) {
        if (graph.ctx && graph.ctx.state !== 'running') {
          // pre-gesture: hold the visuals at the loop position instead of following
          seeks.seek(v, captureStartMediaTime + enginePos());
          return;
        }
        const bp = v.currentTime - captureStartMediaTime;
        if (bp < 0 || bp > player.buf.duration) disengage('Seeked beyond captured region.');
        else if (s.paused) s.pausedPos = player.fold(bp);
        else player.play(bp);
      },
      onPause(s, v) {
        if (!s.paused && !s.kickReplayed && Date.now() - s.kickAt < TIMING.KICK_REPLAY_MS) {
          // the player balked right after the resume gesture, push play once more
          s.kickReplayed = true;
          safePlay(v);
          return;
        }
        if (!s.paused) {
          s.pausedPos = enginePos();
          player.stop();
          s.paused = true;
          setStatus('Paused.');
          panel.render();
        }
      },
      onPlay(s) {
        graph.resume();
        if (s.paused) {
          s.paused = false;
          player.play(s.pausedPos);
          setStatus('Looping\u2026');
          panel.render();
        }
      },
      onVolumeChange() { updateLoopGain(); },
      onRateChange(s, v) { if (v.playbackRate !== 1) setStatus('Rate changes visuals only.'); },
    },

    failed: {
      onPlay: resumeCtxOnPlay,
    },
  };

  // video element events

  let eventsAttached = null;
  function ensureVideoEvents(v) {
    if (!v || eventsAttached === v) return;
    eventsAttached = v;
    v.addEventListener('seeking', () => {
      if (seeks.consume(v.currentTime)) return;
      if (machine.is('wait', 'fetch', 'record', 'analyzing')) {
        console.info('[Seamloop] foreign seek', {
          to: v.currentTime.toFixed(2), phase: machine.phase,
          sinceArm: machine.session.armedAt
            ? ((Date.now() - machine.session.armedAt) / 1000).toFixed(1) + 's' : '-',
        });
      }
      machine.dispatch('onForeignSeek', v);
    });
    v.addEventListener('pause', () => machine.dispatch('onPause', v));
    v.addEventListener('play', () => machine.dispatch('onPlay', v));
    v.addEventListener('playing', () => machine.dispatch('onPlaying', v));
    v.addEventListener('waiting', () => machine.dispatch('onWaiting', v));
    v.addEventListener('ended', () => machine.dispatch('onEnded', v));
    v.addEventListener('timeupdate', () => machine.dispatch('onTimeUpdate', v));
    v.addEventListener('volumechange', () => machine.dispatch('onVolumeChange', v));
    v.addEventListener('ratechange', () => machine.dispatch('onRateChange', v));
  }

  // watcher

  function diagnoseNoStream(v) {
    idleTicks++;
    if (idleTicks < TIMING.IDLE_TICKS_DIAG) { setStatus('Waiting for stream\u2026'); return; }

    const d = mseStore && mseStore.diag;
    const progressive = /^https?:/i.test(v.currentSrc || '');
    let key, msg, fail = true;
    if (!mseStore) {
      key = 'nostore'; msg = 'Capture unavailable here.';
    } else if (progressive && !(d.kinds.append > 0)) {
      key = 'progressive'; msg = 'Prog. stream: turn fast mode off.';
    } else if (mseStore.workerMse) {
      key = 'worker'; msg = 'Worker MSE: reload or fast off.';
    } else if (!mseStore.hook && d.msgs === 0) {
      key = 'silent'; msg = 'Capture hook not detected.';
    } else if (mseStore.hook && mseStore.hook.late) {
      key = 'late'; msg = 'Capture hook loaded late.';
    } else if (d.byteErrors > 0) {
      key = 'bytes'; msg = 'Segments failed (see console)';
    } else if (mseStore.overflowed) {
      key = 'overflow'; msg = 'Capture overflowed: reload.';
    } else if (!(d.kinds.append > 0)) {
      key = 'noappend'; msg = 'No segments: play, then retry.'; fail = false;
    } else {
      key = 'nopick'; msg = 'Assembling stream\u2026'; fail = false;
    }
    if (!diagWarned.has(key)) {
      diagWarned.add(key);
      console.warn('[Seamloop] capture diagnosis (' + key + '):', msg, d || '');
    }
    if (fail) {
      mute.release(v);
      failedTerminal = key === 'nostore' || key === 'progressive';
      toFailed(msg);
      return;
    }
    setStatus(msg);
  }

  function fastTick(v) {
    if (machine.is('wait')) {
      const s = machine.session;
      mute.hold(v);
      if (v.currentTime > 5) seeks.seek(v, 0);
      // prime the player once: a moment of play makes it open the stream, then re-pause
      if (!s.primed && v.paused) {
        s.primed = true;
        try {
          const p = v.play();
          const stop = () => {
            if (!machine.is('wait')) return;
            machine.session.expectPause = true;
            try { v.pause(); } catch (_) { machine.session.expectPause = false; }
          };
          if (p && p.then) p.then(stop, () => {}); else stop();
        } catch (_) {}
      }
    }

    const pick = pickMseStream(4);
    if (!pick) { diagnoseNoStream(v); return; }
    idleTicks = 0;

    const covered = (pick.origin + pick.span >= v.duration - 2 || pick.span >= TIMING.ANALYSIS_CAP_SEC) &&
      pick.origin <= 60;
    if (covered) { analyzeMse(); return; }

    if (adShowing()) {
      if (machine.is('fetch')) {
        machine.session.ff.stop(v, { restorePos: true });
        machine.to('wait', { armedAt: machine.session.armedAt, primed: true });
      }
      return;
    }

    if (machine.is('wait')) {
      if (v.paused || v.currentTime > 2) {
        const ff = new SeamloopFastFetch(v, { seeks, mute });
        machine.to('fetch', { armedAt: machine.session.armedAt, ff });
      } else {
        return; // let the just-primed player settle first
      }
    }

    if (machine.is('fetch')) {
      const s = machine.session;
      const r = s.ff.tick(v, pick);
      if (r.action === 'complete') { analyzeMse(); return; }
      if (r.action === 'fail') {
        s.ff.stop(v, { restorePos: true, resume: true });
        toFailed(r.msg);
        return;
      }
      if (r.progress != null) progress(r.progress);
      if (r.status) setStatus(r.status);
    }
    panel.render();
  }

  async function slowStart(v) {
    if (adShowing()) { setStatus('Waiting out the ad\u2026'); return; }
    if (!machine.is('wait')) return;
    try {
      if (graph.ensure(v)) ensureVideoEvents(v);
    } catch (err) {
      toFailed(err.message);
      return;
    }
    graph.resume();
    const rec = new SeamloopRecorder(v, graph, { seeks, safePlay, onStatus: setStatus });
    machine.to('record', { armedAt: machine.session.armedAt, rec });
    setStatus('Recording\u2026');
    try {
      await rec.start(v);
    } catch (err) {
      console.warn('[Seamloop] recorder tap failed:', err);
      if (machine.is('record') && machine.session.rec === rec) {
        rec.disconnectNodes();
        rec.restoreElementFull(v, {});
        toFailed('No recorder (see console)');
      }
    }
  }

  function recordTick(v) {
    const rec = machine.session.rec;
    if (rec.finishing) return;
    if (adShowing()) {
      if (!rec.adScrapped) rec.scrapForAd();
      setStatus('Waiting out the ad\u2026');
      return;
    }
    if (rec.adScrapped) {
      rec.adScrapped = false;
      seeks.seek(v, 0);
      safePlay(v);
      return;
    }
    const r = rec.tick(v);
    if (r.action === 'fail') {
      rec.disconnectNodes();
      rec.restoreElementFull(v, {});
      toFailed(r.msg);
      return;
    }
    if (r.action === 'complete') { finishRecording(v); return; }
    if (r.progress != null) progress(r.progress);
    if (r.status) setStatus(r.status);
    panel.render();
  }

  function watcher() {
    ensureVideoEvents(getVideoEl());
    if (machine.is('analyzing')) {
      if (mute.held) {
        const v = getVideoEl();
        if (v) mute.reassert(v);
      }
      return;
    }
    if (!machine.is('wait', 'fetch', 'record') || !onWatchPage()) return;
    const v = getVideoEl();
    if (!v || !isFinite(v.duration) || !v.duration) return;

    const fast = panel.getSettings().fastMode;
    // mode/phase mismatch safety net (the settings callback also cancels on change)
    if ((fast && machine.is('record')) || (!fast && machine.is('fetch'))) {
      cancelPipeline();
      return;
    }
    if (machine.is('record')) { recordTick(v); return; }
    if (!fast) { slowStart(v); return; }
    fastTick(v);
  }

  // pipeline commands

  function cancelPipeline() {
    const v = getVideoEl();
    if (machine.is('fetch')) {
      machine.session.ff.stop(v, { restorePos: true, resume: true });
    } else if (machine.is('record')) {
      machine.session.rec.disconnectNodes();
      machine.session.rec.restoreElementFull(v, { resume: true });
    } else {
      mute.release(v);
    }
    machine.to('idle');
    setStatus('Cancelled.');
  }

  function analyzeNow() {
    const v = getVideoEl();
    if (machine.is('record')) {
      const rec = machine.session.rec;
      if (rec.starting || rec.frames < graph.ctx.sampleRate * 8) {
        setStatus('Not enough recorded yet.');
        return;
      }
      finishRecording(v);
      return;
    }
    if (machine.is('wait') && !panel.getSettings().fastMode) {
      setStatus('Nothing recorded yet.');
      return;
    }
    analyzeMse();
  }

  function loopThisVideo() {
    const fast = panel.getSettings().fastMode;
    if (fast && !mseStore) {
      failedTerminal = true;
      toFailed('Capture unavailable here.');
      return;
    }
    failedTerminal = false;
    idleTicks = 0;
    graph.ensureCtx();
    graph.resume();
    machine.to('wait', { armedAt: Date.now(), primed: false });
    setStatus(fast ? 'Capturing\u2026' : 'Recording\u2026');
    if (!fast) {
      const sv = getVideoEl();
      if (sv && isFinite(sv.duration) && sv.duration) slowStart(sv);
      return;
    }
    const v = getVideoEl();
    const pick = pickMseStream(4);
    if (pick && v && isFinite(v.duration) &&
        (pick.origin + pick.span >= v.duration - 2 || pick.span >= TIMING.ANALYSIS_CAP_SEC) &&
        pick.origin <= 60) {
      analyzeMse();
    }
  }

  function forceReloadCapture() {
    failedTerminal = false;
    idleTicks = 0;
    machine.to('idle');
    if (!armReload()) loopThisVideo();
  }

  // arm across reload

  const ARM_KEY = 'seamloopArm';

  function armReload() {
    try {
      sessionStorage.setItem(ARM_KEY, JSON.stringify({ v: videoId, t: Date.now() }));
    } catch (_) { return false; }
    setStatus('Reloading to capture\u2026');
    location.reload();
    return true;
  }

  function checkArm() {
    let raw = null;
    try {
      raw = sessionStorage.getItem(ARM_KEY);
      if (raw != null) sessionStorage.removeItem(ARM_KEY);
    } catch (_) { return; }
    if (!raw) return;
    try {
      const a = JSON.parse(raw);
      const vid = new URL(location.href).searchParams.get('v');
      if (a && a.v === vid && Date.now() - a.t < 120000) {
        machine.to('wait', { armedAt: Date.now(), primed: false });
        setStatus('Capturing\u2026');
        console.info('[Seamloop] armed after reload for', vid);
      }
    } catch (_) {}
  }

  // navigation

  function onNavigate() {
    const vid = new URL(location.href).searchParams.get('v');
    if (vid !== videoId) {
      videoId = vid;
      const v = getVideoEl();
      player.stop();
      if (graph.passGain) graph.passGain.gain.value = 1;
      if (machine.is('fetch') && machine.session.ff) machine.session.ff.stop(v, {});
      if (machine.is('record') && machine.session.rec) {
        machine.session.rec.disconnectNodes();
        machine.session.rec.restoreElementFull(v, { keepPosition: true });
      }
      mute.release(v);
      result = null;
      player.reset();
      mseDecoded = null; mseMeta = null;
      idleTicks = 0;
      diagWarned.clear();
      failedTerminal = false;
      if (mseStore) {
        mseStore.prune();
        mseStore.overflowed = false; // a fresh video gets a fresh verdict
      }
      machine.to('idle');
      setStatus('Idle.');
    }
    panel.setVisible(onWatchPage());
  }

  // panel + init

  const panel = SeamloopPanel.create({
    ui: () => ({
      phase: machine.phase,
      busy: machine.is('wait', 'fetch', 'record'),
      failedTerminal,
      result,
    }),
    onLoop: loopThisVideo,
    onAnalyzeNow: analyzeNow,
    onReload: forceReloadCapture,
    onCancelCapture: cancelPipeline,
    onCancelAnalysis: cancelAnalysis,
    onEngage: engage,
    onDisengage: () => disengage(),
    onXfadeChanged: () => {
      if (!player.buf) return;
      const s = panel.getSettings();
      const posNow = machine.is('engaged') && !machine.session.paused ? enginePos() : null;
      player.applyXfade(s.xfadeOn, s.xfadeMs);
      if (posNow != null) player.play(posNow); // restart the source so the new seam is audible
    },
    onModeChanged: () => {
      if (machine.is('wait', 'fetch', 'record')) {
        cancelPipeline();
        setStatus('Mode changed: retry loop.');
      }
    },
    onDetectionChanged: () => {
      if (machine.is('ready', 'engaged', 'failed')) setStatus('Applies to next analysis.');
    },
  });

  panel.mount();
  panel.render();
  videoId = new URL(location.href).searchParams.get('v');
  checkArm();
  window.addEventListener('yt-navigate-finish', onNavigate, true);
  setInterval(watcher, TIMING.WATCH_INTERVAL_MS);
})();
