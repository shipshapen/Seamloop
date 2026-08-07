/*
assemble the encoded audio byte stream relayed by page-hook.js into decodable media-time-anchored streams
concatenate appends after an init segment, breaks (abort, timestampOffset, changeType) freeze the stream and start a fresh one
each ack carries the sourcebuffer buffered ranges, the growth anchors the stream origin and span in media time
sanitize webm clusters by timestamp to drop duplicate/backward/jumped media before decode
*/

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.MseCaptureStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STREAM_CAP_BYTES = 80 * 1024 * 1024;

// init detect

  function isInitBearing(u8) {
    if (u8.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return true;
    if (u8.length >= 8 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return true;
    return false;
  }

// webm sanitize

  function readVint(u8, pos, keepMarker) {
    if (pos >= u8.length) return null;
    const first = u8[pos];
    if (first === 0) return null;
    let len = 1, mask = 0x80;
    while (!(first & mask)) { len++; mask >>= 1; }
    if (len > 8 || pos + len > u8.length) return null;
    let value = keepMarker ? first : first & (mask - 1);
    let allOnes = !keepMarker && (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) {
      value = value * 256 + u8[pos + i];
      if (u8[pos + i] !== 0xff) allOnes = false;
    }
    return { value, len, unknown: !keepMarker && allOnes };
  }

  const ID_SEGMENT = 0x18538067, ID_CLUSTER = 0x1f43b675, ID_TIMESTAMP = 0xe7;

  function clusterTimestamp(u8, start, end) {
    let pos = start;
    while (pos < end) {
      const id = readVint(u8, pos, true);
      if (!id) return null;
      pos += id.len;
      const size = readVint(u8, pos, false);
      if (!size || size.unknown) return null;
      pos += size.len;
      if (pos + size.value > end) return null;
      if (id.value === ID_TIMESTAMP) {
        let ts = 0;
        for (let i = 0; i < size.value; i++) ts = ts * 256 + u8[pos + i];
        return ts;
      }
      pos += size.value;
    }
    return null;
  }

  function truncateWebm(u8, maxMs) {
    const unchanged = { bytes: u8, truncated: false };
    try {
      if (!(u8.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3)) return unchanged;
      let cutAt = -1, pos = 0;
      let segSizeAt = -1, segSizeLen = 0;
      while (pos < u8.length && cutAt < 0) {
        const id = readVint(u8, pos, true);
        if (!id) return unchanged;
        const size = readVint(u8, pos + id.len, false);
        if (!size) return unchanged;
        const headEnd = pos + id.len + size.len;
        if (id.value === ID_SEGMENT) {
          if (!size.unknown) { segSizeAt = pos + id.len; segSizeLen = size.len; }
          const segEnd = size.unknown ? u8.length : Math.min(u8.length, headEnd + size.value);
          let cpos = headEnd;
          while (cpos < segEnd) {
            const cid = readVint(u8, cpos, true);
            if (!cid) break;
            const csize = readVint(u8, cpos + cid.len, false);
            if (!csize || csize.unknown) break;
            const cend = cpos + cid.len + csize.len + csize.value;
            if (cend > segEnd) break;
            if (cid.value === ID_CLUSTER) {
              const ts = clusterTimestamp(u8, cpos + cid.len + csize.len, cend);
              if (ts != null && ts >= maxMs) { cutAt = cpos; break; }
            }
            cpos = cend;
          }
          pos = segEnd;
        } else {
          if (size.unknown) return unchanged;
          const end = headEnd + size.value;
          if (end > u8.length) break;
          pos = end;
        }
      }
      if (cutAt < 0) return unchanged;
      const out = u8.slice(0, cutAt);
      // patch segment size to unknown-size (all value bits 1): spec-valid and always correct after a cut
      if (segSizeAt >= 0 && segSizeAt + segSizeLen <= out.length) {
        const marker = 0x80 >> (segSizeLen - 1);
        out[segSizeAt] = marker | (marker - 1);
        for (let i = 1; i < segSizeLen; i++) out[segSizeAt + i] = 0xff;
      }
      return { bytes: out, truncated: true };
    } catch (_) {
      return unchanged;
    }
  }

  const FWD_GAP_TC = 30000; // TimecodeScale units, 1 ms on YouTube WebM

  function sanitizeWebm(u8) {
    const unchanged = { bytes: u8, dropped: 0 };
    try {
      if (!(u8.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3)) return unchanged;
      const keep = [];
      let dropped = 0, lastTs = -1, pos = 0;
      let cut = false;
      let segSizeAt = -1, segSizeLen = 0;
      while (pos < u8.length) {
        const id = readVint(u8, pos, true);
        if (!id) return unchanged;
        const size = readVint(u8, pos + id.len, false);
        if (!size) return unchanged;
        const headEnd = pos + id.len + size.len;
        if (id.value === ID_SEGMENT) {
          keep.push([pos, headEnd]);
          if (!size.unknown) { segSizeAt = pos + id.len; segSizeLen = size.len; }
          const segEnd = size.unknown ? u8.length : Math.min(u8.length, headEnd + size.value);
          let cpos = headEnd;
          while (cpos < segEnd) {
            const cid = readVint(u8, cpos, true);
            if (!cid) { keep.push([cpos, segEnd]); break; }
            const csize = readVint(u8, cpos + cid.len, false);
            if (!csize || csize.unknown) { keep.push([cpos, segEnd]); break; }
            const cend = cpos + cid.len + csize.len + csize.value;
            if (cend > segEnd) { keep.push([cpos, segEnd]); break; }
            if (cid.value === ID_CLUSTER) {
              const ts = clusterTimestamp(u8, cpos + cid.len + csize.len, cend);
              if (ts == null) return unchanged;
              if (ts > lastTs + FWD_GAP_TC && lastTs >= 0) { // forward jump: spliced seek media - truncate the rest
                dropped++;
                cut = true;
                break;
              }
              if (ts > lastTs) { lastTs = ts; keep.push([cpos, cend]); }
              else dropped++; // duplicate/backward re-fetch - drop just the cluster
            } else {
              keep.push([cpos, cend]);
            }
            cpos = cend;
          }
          pos = segEnd;
          if (cut) break;
        } else {
          if (size.unknown) return unchanged;
          const end = headEnd + size.value;
          if (end > u8.length) { keep.push([pos, u8.length]); break; }
          keep.push([pos, end]);
          pos = end;
        }
      }
      if (!dropped) return unchanged;
      let total = 0;
      for (const [s, e] of keep) total += e - s;
      const out = new Uint8Array(total);
      let o = 0;
      for (const [s, e] of keep) { out.set(u8.subarray(s, e), o); o += e - s; }
      // patch segment size to unknown-size (all value bits 1): spec-valid and always correct after drops
      if (segSizeAt >= 0) {
        const marker = 0x80 >> (segSizeLen - 1);
        out[segSizeAt] = marker | (marker - 1);
        for (let i = 1; i < segSizeLen; i++) out[segSizeAt + i] = 0xff;
      }
      return { bytes: out, dropped };
    } catch (_) {
      return unchanged;
    }
  }

// growth range

  function growthRange(prev, cur) {
    for (const r of cur) {
      let matched = false;
      for (const p of prev) {
        if (r[0] >= p[0] - 0.05 && r[0] <= p[1] + 0.05) {
          matched = true;
          if (r[1] > p[1] + 0.01) return [p[1], r[1]];
        }
      }
      if (!matched) return [r[0], r[1]];
    }
    return null;
  }

// store

  class MseCaptureStore {
    constructor(now) {
      this.sbs = new Map();
      this.overflowed = false;
      this._seq = 0;
      this._now = now || Date.now;
      this.hook = null;
      this.workerMse = false;
      this.diag = { msgs: 0, kinds: {}, byteErrors: 0 };
    }

    _sb(id) {
      let s = this.sbs.get(id);
      if (!s) { s = { mime: '', audio: false, prevBuffered: [], streams: [] }; this.sbs.set(id, s); }
      return s;
    }
    _cur(sb) { return sb.streams.length ? sb.streams[sb.streams.length - 1] : null; }
    _freeze(stream, reason) {
      if (!stream.frozen) { stream.frozen = true; stream.reason = reason; }
    }

    onEvent(m) {
      if (!m || !m.kind) return;
      this.diag.msgs++;
      this.diag.kinds[m.kind] = (this.diag.kinds[m.kind] || 0) + 1;
      switch (m.kind) {
        case 'hello': {
          this.hook = { late: !!m.late };
          break;
        }
        case 'workermse': {
          this.workerMse = true;
          break;
        }
        case 'sourcebuffer': {
          const sb = this._sb(m.sbId);
          sb.mime = String(m.mime || '');
          sb.audio = !!m.audio;
          break;
        }
        case 'changetype': {
          const sb = this._sb(m.sbId);
          sb.mime = String(m.mime || '');
          sb.audio = !!m.audio;
          const cur = this._cur(sb);
          if (cur) this._freeze(cur, 'changeType');
          break;
        }
        case 'append': {
          const sb = this._sb(m.sbId);
          if (!sb.audio || !m.bytes) break;
          const seq = m.seq != null ? m.seq : (sb.autoSeq || 0) + 1;
          sb.autoSeq = Math.max(sb.autoSeq || 0, seq);
          let u8;
          try {
            u8 = new Uint8Array(m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array(m.bytes));
          } catch (_) {
            this.diag.byteErrors++;
            const bad = this._cur(sb);
            if (bad) this._freeze(bad, 'byte transfer failed');
            break;
          }
          let cur = this._cur(sb);
          if (isInitBearing(u8)) {
            sb.lastInit = u8;
            cur = {
              id: ++this._seq, chunks: [], seqs: [], bytes: 0, frozen: false, reason: null,
              origin: null, spanEnd: null, unacked: 0, ackedIdx: 0, ackedSeq: seq - 1,
              lastActive: this._now(),
            };
            sb.streams.push(cur);
            if (sb.streams.length > 4) sb.streams.splice(0, sb.streams.length - 4);
          }
          if (!cur || cur.frozen) break;
          if (cur.bytes + u8.length > STREAM_CAP_BYTES) { this._freeze(cur, 'size cap'); break; }
          cur.chunks.push(u8);
          cur.seqs.push(seq);
          cur.bytes += u8.length;
          cur.unacked = cur.chunks.length - cur.ackedIdx;
          if (cur.unacked > 2) this.diag.ackDrift = Math.max(this.diag.ackDrift || 0, cur.unacked);
          cur.lastActive = this._now();
          break;
        }
        case 'ack': {
          // completion is strictly ordered: an ack for seq n completes every append <= n, so lost acks self-heal
          const sb = this._sb(m.sbId);
          const ranges = Array.isArray(m.buffered) ? m.buffered : [];
          const cur = this._cur(sb);
          const ackSeq = m.seq != null ? m.seq
            : (cur && cur.ackedIdx < cur.seqs.length ? cur.seqs[cur.ackedIdx]
              : (cur ? cur.ackedSeq : 0));
          let owner = null;
          for (const st of sb.streams) {
            if (st.seqs.length && ackSeq >= st.seqs[0] &&
                ackSeq <= st.seqs[st.seqs.length - 1] && st.seqs.indexOf(ackSeq) !== -1) {
              owner = st;
            }
            if (ackSeq > st.ackedSeq) {
              st.ackedSeq = ackSeq;
              while (st.ackedIdx < st.seqs.length && st.seqs[st.ackedIdx] <= ackSeq) st.ackedIdx++;
              st.unacked = st.chunks.length - st.ackedIdx;
            }
          }
          if (owner && ackSeq > (owner.growSeq || 0)) {
            owner.growSeq = ackSeq;
            const grown = growthRange(sb.prevBuffered, ranges);
            if (grown) {
              const contiguous = owner.origin == null ||
                (grown[0] <= owner.spanEnd + 0.75 && grown[1] >= owner.spanEnd - 0.05);
              if (contiguous) {
                if (owner.origin == null) owner.origin = grown[0];
                owner.spanEnd = grown[1];
                owner.lastActive = this._now();
              } else if (!owner.frozen) {
                // position jump: un-append the jumped chunk, freeze the honest prefix, seed a new stream from lastInit + that chunk (inits describe the whole file)
                let jumped = null;
                const ji = owner.seqs.lastIndexOf(ackSeq);
                if (ji >= 0) {
                  jumped = owner.chunks.splice(ji, 1)[0];
                  owner.seqs.splice(ji, 1);
                  owner.bytes -= jumped.length;
                }
                this._freeze(owner, 'position jump');
                owner.ackedIdx = owner.chunks.length;
                owner.unacked = 0;
                const nu = {
                  id: ++this._seq, chunks: [], seqs: [], bytes: 0, frozen: false, reason: null,
                  origin: grown[0], spanEnd: grown[1], unacked: 0, ackedIdx: 0, ackedSeq: ackSeq,
                  growSeq: ackSeq, lastActive: this._now(),
                  seeded: true,
                };
                if (sb.lastInit) { nu.chunks.push(sb.lastInit); nu.seqs.push(0); nu.bytes += sb.lastInit.length; }
                if (jumped) { nu.chunks.push(jumped); nu.seqs.push(ackSeq); nu.bytes += jumped.length; }
                nu.ackedIdx = nu.chunks.length;
                sb.streams.push(nu);
                if (sb.streams.length > 4) sb.streams.splice(0, sb.streams.length - 4);
              }
            }
          }
          sb.prevBuffered = ranges;
          break;
        }
        case 'abort': {
          const sb = this._sb(m.sbId);
          const cur = this._cur(sb);
          if (cur && !cur.frozen) {
            if (m.pendingDropped && cur.chunks.length) {
              const ai = m.seq != null ? cur.seqs.lastIndexOf(m.seq)
                : (cur.ackedIdx < cur.chunks.length ? cur.chunks.length - 1 : -1);
              if (ai >= cur.ackedIdx) {
                const dropped = cur.chunks.splice(ai, 1)[0];
                cur.seqs.splice(ai, 1);
                cur.bytes -= dropped.length;
                cur.unacked = cur.chunks.length - cur.ackedIdx;
              }
            }
            this._freeze(cur, 'abort');
          }
          break;
        }
        case 'discontinuity': {
          const cur = this._cur(this._sb(m.sbId));
          if (cur) this._freeze(cur, m.reason || 'discontinuity');
          break;
        }
        case 'appendthrow': {
          break;
        }
        case 'overflow':
          this.overflowed = true;
          break;
      }
    }

// pick stream

    pickStream(videoBufferedEnd, minSpanSec) {
      let best = null, bestScore = Infinity;
      for (const sb of this.sbs.values()) {
        if (!sb.audio) continue;
        for (const st of sb.streams) {
          if (st.bad) continue;
          if (st.origin == null || st.spanEnd == null || !st.bytes) continue;
          const span = st.spanEnd - st.origin;
          if (span < (minSpanSec || 0)) continue;
          let score = isFinite(videoBufferedEnd) ? Math.abs(st.spanEnd - videoBufferedEnd) : 0;
          if (st.frozen) score += 30;
          score -= Math.min(span, 600) / 1200;
          if (score < bestScore) { bestScore = score; best = { stream: st, origin: st.origin, span }; }
        }
      }
      return best;
    }

// assemble

    assemble(stream, ackedOnly) {
      const chunks = ackedOnly && stream.ackedIdx != null
        ? stream.chunks.slice(0, stream.ackedIdx)
        : stream.chunks;
      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    }

// prune

    prune() {
      const now = this._now();
      for (const [id, sb] of this.sbs) {
        if (sb.streams.length > 1) {
          sb.streams.sort((a, b) => a.lastActive - b.lastActive);
          sb.streams.splice(0, sb.streams.length - 1);
        }
        const st = sb.streams[0];
        if (!st || now - st.lastActive > 10 * 60 * 1000) this.sbs.delete(id);
      }
    }
  }

  MseCaptureStore.isInitBearing = isInitBearing;
  MseCaptureStore.sanitizeWebm = sanitizeWebm;
  MseCaptureStore.truncateWebm = truncateWebm;
  MseCaptureStore.growthRange = growthRange;
  MseCaptureStore.STREAM_CAP_BYTES = STREAM_CAP_BYTES;
  return MseCaptureStore;
});
