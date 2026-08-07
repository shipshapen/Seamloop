/*
search over candidate loop lengths
for each lag L measure the longest continuous run of frames t where spectrum(t) ~= spectrum(t+L)
the lag with the longest sustained musical run is the fundamental loop
after the coarse spectral pass do normalized cross-correlation to refine the lag to sample accuracy
*/

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.LoopFinder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

// fft

  function makeFFT(n) {
    const levels = Math.round(Math.log2(n));
    if (1 << levels !== n) throw new Error('FFT size must be a power of 2');
    const cosT = new Float32Array(n / 2);
    const sinT = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cosT[i] = Math.cos((2 * Math.PI * i) / n);
      sinT[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    return function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const tre = re[j + half] * cosT[k] + im[j + half] * sinT[k];
            const tim = -re[j + half] * sinT[k] + im[j + half] * cosT[k];
            re[j + half] = re[j] - tre;
            im[j + half] = im[j] - tim;
            re[j] += tre;
            im[j] += tim;
          }
        }
      }
    };
  }

// feature extract

  function extractFeatures(samples, sampleRate, opts = {}) {
    const frameSize = opts.frameSize || (sampleRate >= 32000 ? 4096 : 2048);
    const targetFrames = opts.targetFrames || 3200;
    const minHop = opts.minHop || frameSize >> 2;
    const hop = Math.max(minHop, Math.floor((samples.length - frameSize) / targetFrames));
    const nFrames = Math.floor((samples.length - frameSize) / hop) + 1;
    if (!(nFrames >= 24)) throw new Error('Audio too short to analyze.');
    const nBands = opts.nBands || 48;

    const fft = makeFFT(frameSize);
    const win = new Float32Array(frameSize);
    for (let i = 0; i < frameSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameSize - 1));

    const fMin = 55;
    const fMax = Math.min(sampleRate / 2, 10000);
    const edges = new Uint32Array(nBands + 1);
    for (let b = 0; b <= nBands; b++) {
      const f = fMin * Math.pow(fMax / fMin, b / nBands);
      edges[b] = Math.max(1, Math.min(frameSize / 2, Math.round((f * frameSize) / sampleRate)));
    }
    for (let b = 1; b <= nBands; b++) if (edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;

    const re = new Float32Array(frameSize);
    const im = new Float32Array(frameSize);
    const features = new Float32Array(nFrames * nBands);
    const energies = new Float32Array(nFrames);
    const band = new Float32Array(nBands);

    for (let fIdx = 0; fIdx < nFrames; fIdx++) {
      const off = fIdx * hop;
      for (let i = 0; i < frameSize; i++) { re[i] = samples[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let energy = 0;
      band.fill(0);
      let b = 0;
      for (let k = 1; k < frameSize / 2; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        energy += mag * mag;
        while (b < nBands && k >= edges[b + 1]) b++;
        if (b < nBands && k >= edges[b]) band[b] += mag;
      }
      energies[fIdx] = energy;

      let mean = 0;
      for (let d = 0; d < nBands; d++) { band[d] = Math.log1p(band[d] * 100); mean += band[d]; }
      mean /= nBands;
      let norm = 0;
      for (let d = 0; d < nBands; d++) { const v = band[d] - mean; band[d] = v; norm += v * v; }
      norm = Math.sqrt(norm);
      const base = fIdx * nBands;
      if (norm > 1e-6) for (let d = 0; d < nBands; d++) features[base + d] = band[d] / norm;
    }

    let maxE = 0;
    for (let i = 0; i < nFrames; i++) if (energies[i] > maxE) maxE = energies[i];
    const silent = new Uint8Array(nFrames);
    const silenceFloor = maxE * (opts.silenceRatio || 3e-6); // ~ -55 dB
    for (let i = 0; i < nFrames; i++) if (energies[i] < silenceFloor) silent[i] = 1;

    return {
      features, silent, energies, nFrames, nBands, hop, frameSize, sampleRate,
      hopSec: hop / sampleRate,
    };
  }

// lag search

  async function findBestLag(feat, opts = {}, onProgress) {
    const { features: F, silent, nFrames: N, nBands: D, hopSec } = feat;
    const minLag = Math.max(4, Math.round((opts.minLoopSec ?? 10) / hopSec));
    const minRun = Math.max(3, Math.round((opts.minRunSec ?? 3) / hopSec));
    const maxLag = N - minRun;
    if (maxLag <= minLag) return { best: null, candidates: [] };

    const thr = opts.simThreshold ?? 0.8;
    const gapTol = opts.gapToleranceFrames ?? 3;
    const maxSilenceBridge = Math.max(2, Math.round((opts.maxSilenceBridgeSec ?? 4) / hopSec));

    const candidates = [];

    for (let lag = minLag; lag <= maxLag; lag++) {
      let inRun = false, runStart = 0, lastGood = -1;
      let musical = 0, simSum = 0, gap = 0, neutral = 0;
      let bestRun = null;

      const closeRun = () => {
        if (inRun && musical >= minRun) {
          const cand = { lag, start: runStart, end: lastGood, musical, meanSim: simSum / musical };
          if (!bestRun || cand.musical > bestRun.musical) bestRun = cand;
        }
        inRun = false; musical = 0; simSum = 0; gap = 0; neutral = 0;
      };

      const M = N - lag;
      for (let t = 0; t < M; t++) {
        const sA = silent[t], sB = silent[t + lag];
        if (sA && sB) {
          if (inRun && ++neutral > maxSilenceBridge) closeRun();
          continue;
        }
        if (sA || sB) {
          if (inRun && ++gap > gapTol) closeRun();
          continue;
        }
        let s = 0;
        const a = t * D, b = (t + lag) * D;
        for (let d = 0; d < D; d++) s += F[a + d] * F[b + d];
        if (s >= thr) {
          if (!inRun) { inRun = true; runStart = t; }
          lastGood = t; musical++; simSum += s; gap = 0; neutral = 0;
        } else if (inRun && ++gap > gapTol) {
          closeRun();
        }
      }
      closeRun();
      if (bestRun) candidates.push(bestRun);

      if (onProgress && (lag - minLag) % 64 === 0) {
        onProgress((lag - minLag) / (maxLag - minLag));
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (!candidates.length) return { best: null, candidates };
    candidates.sort((a, b) => b.musical - a.musical);

    let best = candidates[0];
    const inspect = Math.min(candidates.length, 40);
    for (let i = 1; i < inspect; i++) {
      const c = candidates[i];
      if (c.musical >= 0.92 * best.musical && c.meanSim > best.meanSim + 0.04) best = c;
    }
    if (onProgress) onProgress(1);
    return { best, candidates: candidates.slice(0, 8) };
  }

// sample-level refine

  function refineLoop(samples, sampleRate, loopStartSample, coarseLagSamples, opts = {}) {
    const radius = Math.round(opts.radiusSamples ?? Math.max(2048, sampleRate * 0.1));
    let win = Math.round((opts.windowSec ?? 0.35) * sampleRate);

    const refOff = loopStartSample;
    const candBase = loopStartSample + coarseLagSamples;
    const maxWin = samples.length - (candBase + radius) - 1;
    win = Math.min(win, maxWin, samples.length - refOff - 1);
    if (win < 256) return { delta: 0, ncc: 0, refined: false };

    let refE = 0;
    for (let i = 0; i < win; i++) { const v = samples[refOff + i]; refE += v * v; }
    if (refE < 1e-9) return { delta: 0, ncc: 0, refined: false };

    const ncc = (delta) => {
      const off = candBase + delta;
      let dot = 0, e = 0;
      for (let i = 0; i < win; i++) {
        const c = samples[off + i];
        dot += samples[refOff + i] * c;
        e += c * c;
      }
      return e < 1e-9 ? 0 : dot / Math.sqrt(refE * e);
    };

    const step = 4;
    let bestDelta = 0, bestN = -Infinity;
    for (let d = -radius; d <= radius; d += step) {
      const v = ncc(d);
      if (v > bestN) { bestN = v; bestDelta = d; }
    }
    for (let d = Math.max(-radius, bestDelta - step); d <= Math.min(radius, bestDelta + step); d++) {
      const v = ncc(d);
      if (v > bestN) { bestN = v; bestDelta = d; }
    }
    return { delta: bestDelta, ncc: bestN, refined: true };
  }

// crossfade integration

  function crossfadeChannels(channels, loopStartSample, loopEndSample, fadeSamples) {
    const w = Math.min(fadeSamples, loopStartSample, loopEndSample - loopStartSample - 1);
    if (w <= 0) return 0;
    for (const ch of channels) {
      for (let i = 0; i < w; i++) {
        const t = ((i + 1) / w) * (Math.PI / 2);
        const g1 = Math.cos(t), g2 = Math.sin(t);
        const dst = loopEndSample - w + i;
        const src = loopStartSample - w + i;
        ch[dst] = ch[dst] * g1 + ch[src] * g2;
      }
    }
    return w;
  }

// pipeline

  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  async function analyzeSamples(samples, sampleRate, opts = {}, onProgress) {
    const report = (p, label) => { if (onProgress) onProgress(clamp01(p), label); };

    report(0.02, 'Extracting spectral fingerprint');
    const feat = extractFeatures(samples, sampleRate, opts);
    await new Promise((r) => setTimeout(r, 0));

    report(0.1, 'Searching loop lengths');
    const { best, candidates } = await findBestLag(feat, opts, (p) => report(0.1 + 0.82 * p, 'Searching loop lengths'));
    if (!best) {
      return {
        found: false,
        reason: 'No sustained repetition found. The file may contain only a single pass of the loop.',
        feat: summarizeFeat(feat),
      };
    }

    report(0.94, 'Refining to sample accuracy');

    const startFrame = Math.min(best.start + 1, feat.nFrames - 2);
    const loopStartSample = startFrame * feat.hop;
    const coarseLag = best.lag * feat.hop;
    const r = refineLoop(samples, sampleRate, loopStartSample, coarseLag, {
      radiusSamples: feat.hop + 512,
      windowSec: opts.refineWindowSec ?? 0.35,
    });
    const loopEndSample = Math.min(loopStartSample + coarseLag + r.delta, samples.length - 1);

    const thr = opts.simThreshold ?? 0.8;
    const runSec = best.musical * feat.hopSec;
    const lagSec = (loopEndSample - loopStartSample) / sampleRate;
    const simScore = clamp01((best.meanSim - thr) / (0.97 - thr));
    const runScore = clamp01(runSec / Math.min(best.lag * feat.hopSec, 30));
    const nccScore = r.refined ? clamp01((r.ncc - 0.5) / 0.45) : 0.3;
    const confidence = 0.4 * simScore + 0.25 * runScore + 0.35 * nccScore;

    report(1, 'Done');
    return {
      found: true,
      loopStart: loopStartSample / sampleRate,
      loopEnd: loopEndSample / sampleRate,
      loopStartSample,
      loopEndSample,
      loopLength: lagSec,
      confidence,
      details: {
        meanSimilarity: best.meanSim,
        matchedRunSec: runSec,
        refinedNcc: r.ncc,
        refineDeltaSamples: r.delta,
        coarseLagSec: best.lag * feat.hopSec,
        hopSec: feat.hopSec,
        topCandidates: candidates.map((c) => ({
          lagSec: c.lag * feat.hopSec, runSec: c.musical * feat.hopSec, meanSim: c.meanSim,
        })),
      },
      feat: summarizeFeat(feat),
    };
  }

  function summarizeFeat(feat) {
    return { nFrames: feat.nFrames, hopSec: feat.hopSec, frameSize: feat.frameSize };
  }

  function downmix(audioBuffer) {
    const n = audioBuffer.length;
    const out = new Float32Array(n);
    const chs = audioBuffer.numberOfChannels;
    for (let c = 0; c < chs; c++) {
      const d = audioBuffer.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i];
    }
    if (chs > 1) for (let i = 0; i < n; i++) out[i] /= chs;
    return out;
  }

  async function findLoop(audioBuffer, opts = {}, onProgress) {
    const mono = downmix(audioBuffer);
    return analyzeSamples(mono, audioBuffer.sampleRate, opts, onProgress);
  }

  return {
    findLoop,
    analyzeSamples,
    extractFeatures,
    findBestLag,
    refineLoop,
    crossfadeChannels,
    downmix,
  };
});
