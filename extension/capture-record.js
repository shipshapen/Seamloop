/*
tap the decoded pcm through an audioworklet (scriptprocessor fallback) while the video plays once through
gate splices out ads/stalls
the element stays at unity gain (its volume/mute would scale the tapped signal)
user's volume is mirrored into passGain instead
all recorder-local state lives on the instance and dies with it
*/

(() => {
  'use strict';

  const { TIMING } = SeamloopPlayerIO;

  const WORKLET_SRC = `
    class SeamloopRec extends AudioWorkletProcessor {
      constructor() {
        super();
        this._on = false;
        this._l = []; this._r = []; this._n = 0;
        this.port.onmessage = (e) => {
          const m = e.data || {};
          if (m.cmd === 'gate') { this._on = !!m.on; if (!this._on) this._flush(false); }
          else if (m.cmd === 'flush') this._flush(true);
        };
      }
      _flush(final) {
        if (!this._n) { if (final) this.port.postMessage({ final: true, frames: 0 }); return; }
        const l = new Float32Array(this._n), r = new Float32Array(this._n);
        let o = 0;
        for (let i = 0; i < this._l.length; i++) { l.set(this._l[i], o); r.set(this._r[i], o); o += this._l[i].length; }
        const msg = { l: l, r: r, frames: this._n, final: !!final };
        this._l = []; this._r = []; this._n = 0;
        this.port.postMessage(msg, [l.buffer, r.buffer]);
      }
      process(inputs) {
        if (this._on) {
          const inp = inputs[0];
          if (inp && inp.length && inp[0] && inp[0].length) {
            const L = inp[0], R = inp.length > 1 ? inp[1] : inp[0];
            this._l.push(new Float32Array(L)); this._r.push(new Float32Array(R));
            this._n += L.length;
            if (this._n >= 2048) this._flush(false);
          }
        }
        return true;
      }
    }
    registerProcessor('seamloop-rec', SeamloopRec);
  `;

  let workletReady = null; // per-AudioContext module load, attempted once

  async function buildTap(ctx) {
    if (ctx.audioWorklet && ctx.audioWorklet.addModule) {
      if (!workletReady) {
        workletReady = (async () => {
          const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
          try { await ctx.audioWorklet.addModule(url); return true; }
          catch (err) {
            console.warn('[Seamloop] AudioWorklet module load failed; using ScriptProcessor fallback:', err);
            return false;
          } finally { URL.revokeObjectURL(url); }
        })();
      }
      if (await workletReady) {
        return {
          worklet: true,
          node: new AudioWorkletNode(ctx, 'seamloop-rec', {
            numberOfInputs: 1, numberOfOutputs: 1,
            channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
          }),
        };
      }
    }
    return { worklet: false, node: ctx.createScriptProcessor(4096, 2, 2) };
  }

  class Recorder {
    // io: { seeks: SeekLedger, safePlay, onStatus }
    constructor(v, graph, io) {
      this.g = graph;
      this.io = io;
      this.saved = { time: v.currentTime, paused: v.paused, muted: v.muted, volume: v.volume, rate: v.playbackRate };
      this.chunks = [];
      this.frames = 0;
      this.gateOn = false;
      this.node = null;
      this.sink = null;
      this.worklet = false;
      this.adScrapped = false;
      this.finishing = false;
      this.starting = true;
      this.dead = false;
      this.lastT = 0;
      this.stallTicks = 0;
      this.splices = 0;
      this.onFinalFlush = null;
    }

    // wire the tap and start playback from 0, throws if no tap could be built
    async start(v) {
      const tap = await buildTap(this.g.ctx);
      if (this.dead) return;
      this.node = tap.node;
      this.worklet = tap.worklet;
      this.sink = this.g.ctx.createGain();
      this.sink.gain.value = 0; // the tap must be pulled by the graph but stay inaudible
      this.g.srcNode.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(this.g.ctx.destination);

      const push = (l, r, frames) => {
        if (this.dead || !frames) return;
        if ((this.frames + frames) / this.g.ctx.sampleRate > TIMING.ANALYSIS_CAP_SEC + 5) return;
        this.chunks.push([l, r]);
        this.frames += frames;
      };
      if (this.worklet) {
        this.node.port.onmessage = (e) => {
          const m = e.data || {};
          if (m.frames) push(m.l, m.r, m.frames);
          if (m.final && this.onFinalFlush) this.onFinalFlush();
        };
      } else {
        this.node.onaudioprocess = (e) => {
          if (this.dead || !this.gateOn) return;
          const ib = e.inputBuffer;
          const l = new Float32Array(ib.length);
          ib.copyFromChannel(l, 0);
          let r = l;
          if (ib.numberOfChannels > 1) { r = new Float32Array(ib.length); ib.copyFromChannel(r, 1); }
          push(l, r, ib.length);
        };
      }

      this.enforceElement(v);
      if (v.currentTime > 0.25) this.io.seeks.seek(v, 0);
      try {
        const p = v.play();
        if (p && p.catch) p.catch(() => {
          if (!this.dead && !this.finishing) this.io.onStatus('Autoplay blocked: press play.');
        });
      } catch (_) {}
      this.starting = false;
    }

    // keep the element at unity gain, mirroring the user's intent into passGain
    enforceElement(v) {
      try {
        if (!this.finishing && this.g.passGain) {
          if (v.muted) this.saved.muted = true;
          else if (v.volume !== 1) { this.saved.volume = v.volume; this.saved.muted = false; }
          this.g.passGain.gain.value = this.saved.muted ? 0 : this.saved.volume;
        }
        if (v.muted) v.muted = false;
        if (v.volume !== 1) v.volume = 1;
        if (v.playbackRate !== 1) v.playbackRate = 1;
      } catch (_) {}
    }

    gate(on) {
      if (this.gateOn === on) return;
      this.gateOn = on;
      if (!on && this.frames && !this.finishing) this.splices++;
      if (this.worklet && this.node) {
        try { this.node.port.postMessage({ cmd: 'gate', on: on }); } catch (_) {}
      }
    }

    resetCapture() {
      this.chunks.length = 0;
      this.frames = 0;
      this.lastT = 0;
      this.stallTicks = 0;
      this.splices = 0;
    }

    // an ad started mid-recording: scrap and wait, the controller restarts from 0 when it ends
    scrapForAd() {
      this.gate(false);
      this.adScrapped = true;
      this.resetCapture();
      console.info('[Seamloop] ad interrupted the recording - restarting from 0 once it ends');
    }

    // one watcher beat, returns { action: 'continue'|'complete'|'fail', ... }
    tick(v) {
      if (this.starting) return { action: 'continue' };
      this.enforceElement(v);
      if (v.paused && !this.frames && !this.gateOn) {
        return { action: 'continue', progress: 0, status: 'Press play to record.' };
      }
      const playing = !v.paused && !v.ended && v.readyState >= 3;
      if (!this.finishing && playing !== this.gateOn) this.gate(playing);
      if (v.currentTime <= this.lastT + 0.05) {
        if (!v.paused && ++this.stallTicks > TIMING.REC_STALL_TICKS) {
          return { action: 'fail', msg: 'Recording stalled.' };
        }
      } else {
        this.stallTicks = 0;
        this.lastT = v.currentTime;
      }
      const d = v.duration;
      const target = isFinite(d) && d ? Math.min(d, TIMING.ANALYSIS_CAP_SEC) : TIMING.ANALYSIS_CAP_SEC;
      const done = v.currentTime >= target - 0.4 || this.frames / this.g.ctx.sampleRate >= TIMING.ANALYSIS_CAP_SEC;
      return {
        action: done ? 'complete' : 'continue',
        progress: Math.min(1, v.currentTime / target),
        status: 'Scanning\u2026 ' + Math.floor(Math.min(v.currentTime, target)) + 's / ' + Math.floor(target) + 's',
      };
    }

    // gate off, pause, drain the worklet, hands the frames back
    // the caller owns analysis and element restore from here
    async drain(v) {
      if (this.finishing) return null;
      this.gate(false);
      this.finishing = true;
      try { if (!v.paused) v.pause(); } catch (_) {}
      if (this.worklet && this.node) {
        await new Promise((res) => {
          let done = false;
          const fin = () => { if (!done) { done = true; res(); } };
          this.onFinalFlush = fin;
          try { this.node.port.postMessage({ cmd: 'flush' }); } catch (_) { fin(); }
          setTimeout(fin, 300);
        });
        this.onFinalFlush = null;
      }
      if (this.dead) return null;
      return { chunks: this.chunks, frames: this.frames, splices: this.splices, worklet: this.worklet, saved: this.saved };
    }

    disconnectNodes() {
      this.dead = true;
      try {
        if (this.node) {
          this.node.disconnect();
          if (!this.worklet) this.node.onaudioprocess = null;
        }
      } catch (_) {}
      try { if (this.sink) this.sink.disconnect(); } catch (_) {}
    }

    // restore muted/volume/rate only (done right after a drain, before analysis)
    restoreElementAttrs(v) {
      try { v.muted = this.saved.muted; } catch (_) {}
      try { v.volume = this.saved.volume; } catch (_) {}
      try { v.playbackRate = this.saved.rate; } catch (_) {}
    }

    // full restore for cancel paths, opts: { keepPosition, resume }
    restoreElementFull(v, opts = {}) {
      this.chunks.length = 0;
      this.frames = 0;
      if (this.g.passGain) this.g.passGain.gain.value = 1;
      if (!v) return;
      this.restoreElementAttrs(v);
      if (!opts.keepPosition) {
        try { if (!v.paused && (this.saved.paused || !opts.resume)) v.pause(); } catch (_) {}
        this.io.seeks.seek(v, this.saved.time);
        if (opts.resume && !this.saved.paused && v.paused) this.io.safePlay(v);
      }
    }
  }

  window.SeamloopRecorder = Recorder;
})();
