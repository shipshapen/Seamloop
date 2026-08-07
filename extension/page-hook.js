/*
hook mediasource in the page world at document_start before the player builds it
copy the bytes passing through sourcebuffer.appendbuffer and relay them to the content script via postmessage
queue everything until the content script posts cs_ready and then flush in order
relay ack / abort / discontinuity signals alongside the bytes
*/

(() => {
  'use strict';
  if (window.__seamloopHook) return;

// diagnostics

  const readyState = typeof document !== 'undefined' ? document.readyState : 'loading';
  const stats = {
    installed: true,
    late: readyState !== 'loading',
    sbs: 0, audioSbs: 0, audioAppends: 0, acks: 0,
    queued: 0, posted: 0, ready: false,
  };
  window.__seamloopHook = stats;
  try {
    console.info('[Seamloop] MSE hook installed (readyState=' + readyState + ')');
    if (stats.late) console.warn(
      '[Seamloop] Hook injected after document_start - a player created before ' +
      'this moment cannot be tapped. Reload the page for passive capture.');
  } catch (_) {}

// relay queue

  const TYPE = 'SEAMLOOP_MSE';
  const READY_TYPE = TYPE + '_CS_READY';
  const QUEUE_CAP_BYTES = 80 * 1024 * 1024; // ~1h of Opus
  const QUEUE_CAP_MSGS = 8192; // ~2h of append+ack pairs

  let csReady = false;
  let queue = [];
  let queuedBytes = 0;
  let overflowed = false;

  function post(msg, transfer) {
    if (csReady) {
      try { window.postMessage(msg, '*', transfer || []); stats.posted++; } catch (err) {
        try { console.warn('[Seamloop] relay postMessage failed:', err); } catch (_) {}
      }
      return;
    }
    if (queue.length >= QUEUE_CAP_MSGS) { overflowed = true; return; }
    if (msg.bytes) {
      if (queuedBytes + msg.bytes.byteLength > QUEUE_CAP_BYTES) { overflowed = true; return; }
      queuedBytes += msg.bytes.byteLength;
    }
    queue.push(msg);
    stats.queued = queue.length;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== READY_TYPE) return;
    if (csReady) return;
    csReady = true;
    stats.ready = true;
    if (overflowed) queue.push({ type: TYPE, kind: 'overflow' });
    const q = queue;
    queue = []; queuedBytes = 0; stats.queued = 0;
    for (const m of q) {
      try { window.postMessage(m, '*', m.bytes ? [m.bytes] : []); stats.posted++; } catch (err) {
        try { console.warn('[Seamloop] relay postMessage failed:', err); } catch (_) {}
      }
    }
  });

  post({ type: TYPE, kind: 'hello', late: stats.late });

  const MS = window.MediaSource;
  const SB = window.SourceBuffer;
  if (!MS || !SB || !MS.prototype || !SB.prototype) return;

// worker mse

  try {
    if (MS.canConstructInDedicatedWorker === true) {
      Object.defineProperty(MS, 'canConstructInDedicatedWorker', { value: false, configurable: true });
      stats.workerMseSuppressed = true;
      console.info('[Seamloop] Worker-MSE support hidden from the player (forcing main-thread MSE).');
    }
  } catch (_) {}

  try {
    const ME = window.HTMLMediaElement;
    const soDesc = ME && ME.prototype && Object.getOwnPropertyDescriptor(ME.prototype, 'srcObject');
    if (soDesc && soDesc.set && soDesc.configurable) {
      Object.defineProperty(ME.prototype, 'srcObject', {
        configurable: true,
        enumerable: soDesc.enumerable,
        get: soDesc.get,
        set(v) {
          try {
            const ctor = v && v.constructor && v.constructor.name;
            if (ctor === 'MediaSourceHandle') {
              stats.workerMse = true;
              post({ type: TYPE, kind: 'workermse' });
              console.warn('[Seamloop] Player attached a worker MediaSource - its bytes are invisible to the page-world hook.');
            }
          } catch (_) {}
          return soDesc.set.call(this, v);
        },
      });
    }
  } catch (_) {}

// hooks

  let nextId = 1;
  const sbInfo = new WeakMap();
  const isAudio = (m) => /^audio\//i.test(String(m));

  function register(sb, mime) {
    // seq ledger: sourcebuffer completion is strictly ordered, so an ack for seq n proves every append <= n completed
    const info = { id: nextId++, mime: String(mime), audio: isAudio(mime), seq: 0, pendingSeq: 0 };
    sbInfo.set(sb, info);
    stats.sbs++;
    if (info.audio) stats.audioSbs++;
    try {
      sb.addEventListener('updateend', () => {
        if (!info.pendingSeq) return;
        const seq = info.pendingSeq;
        info.pendingSeq = 0;
        if (!info.audio) return;
        const ranges = [];
        try {
          const b = sb.buffered;
          for (let i = 0; i < b.length; i++) ranges.push([b.start(i), b.end(i)]);
        } catch (_) {}
        stats.acks++;
        post({ type: TYPE, kind: 'ack', sbId: info.id, seq: seq, buffered: ranges });
      });
    } catch (_) {}
    post({ type: TYPE, kind: 'sourcebuffer', sbId: info.id, mime: info.mime, audio: info.audio });
    return info;
  }

  const origAdd = MS.prototype.addSourceBuffer;
  MS.prototype.addSourceBuffer = function (mime) {
    const sb = origAdd.call(this, mime);
    try { register(sb, mime); } catch (_) {}
    return sb;
  };

  if (SB.prototype.changeType) {
    const origChange = SB.prototype.changeType;
    SB.prototype.changeType = function (mime) {
      try {
        const info = sbInfo.get(this);
        if (info) {
          info.mime = String(mime);
          const wasAudio = info.audio;
          info.audio = isAudio(mime);
          if (wasAudio || info.audio) post({ type: TYPE, kind: 'changetype', sbId: info.id, mime: info.mime, audio: info.audio });
        }
      } catch (_) {}
      return origChange.call(this, mime);
    };
  }

  const origAppend = SB.prototype.appendBuffer;
  SB.prototype.appendBuffer = function (data) {
    // copy before the call, relay only after it returns: a throwing append's bytes never reached the parser and would desync the append<->ack ledger
    let info = null, copy = null;
    try {
      info = sbInfo.get(this);
      if (info && info.audio && data) {
        const src = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        copy = src.slice().buffer;
      }
    } catch (_) { copy = null; }
    let r;
    try {
      r = origAppend.call(this, data);
    } catch (err) {
      try {
        if (info && info.audio) {
          stats.appendThrows = (stats.appendThrows || 0) + 1;
          post({ type: TYPE, kind: 'appendthrow', sbId: info.id, name: err && err.name });
        }
      } catch (_) {}
      throw err;
    }
    try {
      if (info) {
        const seq = ++info.seq;
        info.pendingSeq = seq;
        if (copy) {
          if (stats.audioAppends === 0) {
            try { console.debug('[Seamloop] first audio append tapped (' + copy.byteLength + ' bytes)'); } catch (_) {}
          }
          stats.audioAppends++;
          post({ type: TYPE, kind: 'append', sbId: info.id, seq: seq, bytes: copy }, [copy]);
        }
      }
    } catch (_) {}
    return r;
  };

  const origAbort = SB.prototype.abort;
  SB.prototype.abort = function () {
    try {
      const info = sbInfo.get(this);
      if (info) {
        const seq = info.pendingSeq;
        info.pendingSeq = 0;
        if (info.audio) post({ type: TYPE, kind: 'abort', sbId: info.id, pendingDropped: seq > 0, seq: seq });
      }
    } catch (_) {}
    return origAbort.call(this);
  };

  try {
    const tsDesc = Object.getOwnPropertyDescriptor(SB.prototype, 'timestampOffset');
    if (tsDesc && tsDesc.set && tsDesc.configurable) {
      Object.defineProperty(SB.prototype, 'timestampOffset', {
        configurable: true,
        enumerable: tsDesc.enumerable,
        get: tsDesc.get,
        set(v) {
          try {
            const info = sbInfo.get(this);
            if (info && info.audio && v !== 0) {
              post({ type: TYPE, kind: 'discontinuity', sbId: info.id, reason: 'timestampOffset=' + v });
            }
          } catch (_) {}
          return tsDesc.set.call(this, v);
        },
      });
    }
  } catch (_) {}
})();
