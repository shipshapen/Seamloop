/*
plumbing: element tap graph (pass-through bus + loop bus + meter) and loop player
buffer playback with sample-accurate loop points and a destructive/reversible micro-crossfade at the seam
*/

(() => {
  'use strict';

  class Graph {
    constructor() {
      this.ctx = null;
      this.video = null;     // element the graph is currently wired to
      this.srcNode = null;   // MediaElementSource of that element
      this.passGain = null;  // element audio -> speakers (zeroed while a loop is engaged)
      this.loopGain = null;  // loop player -> speakers (mirrors the user's volume/mute)
      this.meter = null;     // analyser on the loop bus, for the silence watchdog
      this.meterBuf = null;
    }

    ensureCtx() {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      return this.ctx;
    }

    resume() {
      try { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); } catch (_) {}
    }

    // (re)wire the graph onto the current <video>, returns true if the element changed
    ensure(v) {
      if (!v) throw new Error('No video element found.');
      this.ensureCtx();
      if (v === this.video) return false;
      for (const n of [this.srcNode, this.passGain, this.loopGain, this.meter]) {
        try { if (n) n.disconnect(); } catch (_) {}
      }
      this.video = v;
      this.srcNode = this.ctx.createMediaElementSource(v);
      this.passGain = this.ctx.createGain();
      this.passGain.gain.value = 1;
      this.loopGain = this.ctx.createGain();
      this.loopGain.gain.value = 1;
      this.srcNode.connect(this.passGain);
      this.passGain.connect(this.ctx.destination);
      this.loopGain.connect(this.ctx.destination);
      this.meter = this.ctx.createAnalyser();
      this.meter.fftSize = 2048;
      this.meterBuf = new Float32Array(this.meter.fftSize);
      this.loopGain.connect(this.meter);
      return true;
    }

    meterDb() {
      if (!this.meter) return -Infinity;
      this.meter.getFloatTimeDomainData(this.meterBuf);
      let s = 0;
      for (let i = 0; i < this.meterBuf.length; i++) s += this.meterBuf[i] * this.meterBuf[i];
      const rms = Math.sqrt(s / this.meterBuf.length);
      return rms > 1e-8 ? 20 * Math.log10(rms) : -Infinity;
    }
  }

  // equal-power blend of the pre-loop-start samples into the loop tail (in place)
  function applyCrossfadeSafe(buf, startSample, endSample, fadeSamples) {
    const w = Math.min(fadeSamples, startSample, endSample - startSample - 1);
    if (w <= 0) return;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const tail = new Float32Array(w), pre = new Float32Array(w);
      buf.copyFromChannel(tail, c, endSample - w);
      buf.copyFromChannel(pre, c, startSample - w);
      for (let i = 0; i < w; i++) {
        const t = (((i + 1) / w) * Math.PI) / 2;
        tail[i] = tail[i] * Math.cos(t) + pre[i] * Math.sin(t);
      }
      buf.copyToChannel(tail, c, endSample - w);
    }
  }

  class LoopPlayer {
    constructor(graph) {
      this.g = graph;
      this.reset();
    }

    reset() {
      this.buf = null;
      this.start = 0;         // loop points in buffer seconds
      this.end = 0;
      this.src = null;
      this.startedAt = 0;
      this.startOffset = 0;
      this.xfade = null;      // pristine seam snapshot, so the crossfade stays reversible
    }

    // adopt a decoded buffer + loop points, snapshots the seam originals first
    load(buf, startSec, endSec) {
      this.restoreSeam();
      this.buf = buf;
      this.start = startSec;
      this.end = endSec;
      const sr = buf.sampleRate;
      const s = Math.round(startSec * sr), e = Math.round(endSec * sr);
      const wMax = Math.min(Math.round(0.06 * sr), s, e - s - 1);
      this.xfade = null;
      if (wMax > 0) {
        const orig = [];
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const a = new Float32Array(wMax);
          buf.copyFromChannel(a, c, e - wMax);
          orig.push(a);
        }
        this.xfade = { s, e, wMax, orig };
      }
    }

    restoreSeam() {
      if (!this.buf || !this.xfade) { this.xfade = null; return; }
      for (let c = 0; c < this.buf.numberOfChannels; c++) {
        this.buf.copyToChannel(this.xfade.orig[c], c, this.xfade.e - this.xfade.wMax);
      }
      this.xfade = null;
    }

    // re-render the seam from the pristine snapshot at the requested width
    applyXfade(on, ms) {
      if (!this.buf || !this.xfade) return;
      const { s, e, wMax, orig } = this.xfade;
      for (let c = 0; c < this.buf.numberOfChannels; c++) this.buf.copyToChannel(orig[c], c, e - wMax);
      if (on && ms > 0) {
        const w = Math.min(wMax, Math.round((ms / 1000) * this.buf.sampleRate));
        applyCrossfadeSafe(this.buf, s, e, w);
      }
    }

    // map any buffer time into the loop region (the intro region maps to itself)
    fold(t) {
      const s = this.start, e = this.end;
      if (t < 0) t = 0;
      return t <= e ? t : s + ((t - s) % (e - s));
    }

    play(offsetSec) {
      this.stop();
      const ctx = this.g.ctx;
      this.src = ctx.createBufferSource();
      this.src.buffer = this.buf;
      this.src.loop = true;
      this.src.loopStart = this.start;
      this.src.loopEnd = this.end;
      this.src.connect(this.g.loopGain);
      this.startOffset = this.fold(offsetSec);
      this.startedAt = ctx.currentTime;
      this.src.start(0, this.startOffset);
    }

    stop() {
      if (this.src) {
        try { this.src.stop(); } catch (_) {}
        try { this.src.disconnect(); } catch (_) {}
        this.src = null;
      }
    }

    // current playback position in buffer seconds (0 when not playing)
    pos() {
      if (!this.src) return 0;
      const s = this.start, e = this.end;
      const el = this.g.ctx.currentTime - this.startedAt + this.startOffset;
      return el < s ? el : s + ((el - s) % (e - s));
    }
  }

  window.SeamloopAudioGraph = { Graph, LoopPlayer };
})();
