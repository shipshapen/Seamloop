/*
shadow-dom control panel, decoupled from the controller

cb: {
  ui() -> { phase, busy, failedTerminal, result
    phase: idle|wait|fetch|record|analyzing|ready|engaged|failed
  onLoop, onAnalyzeNow, onReload,
  onCancelCapture, onCancelAnalysis,
  onEngage, onDisengage,
  onXfadeChanged, onModeChanged, onDetectionChanged,
}
*/

(() => {
  'use strict';

  const { clock } = SeamloopPlayerIO;

  // motion values mirrored as stylesheet literals (not interpolated) to satisfy amo's sanitizer lint
  const MOTION = { dur: 240, fast: 140, blip: 180, ease: 'cubic-bezier(.4, 0, .2, 1)' };

  let rmq = null;
  try { rmq = matchMedia('(prefers-reduced-motion: reduce)'); } catch (_) {}

  function create(cb) {
    const host = document.createElement('div');
    host.id = 'seamloop-host';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; --dur: 240ms; --dur-fast: 140ms; --ease: cubic-bezier(.4, 0, .2, 1); }
        @media (prefers-reduced-motion: reduce) { :host { --dur: 1ms; --dur-fast: 1ms; } }
        * { box-sizing: border-box; font-family: ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace; }
        .boot, .boot *, .boot *::before, .boot *::after { transition: none !important; }
        .card {
          position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
          width: 280px; background: #14171d; color: #e8e4da;
          border: 1px solid #2a3140; border-radius: 10px; padding: 8px 14px;
          box-shadow: 0 8px 28px rgba(0,0,0,.5); font-size: 12px;
          transform-origin: 100% 100%;
          transition: transform var(--dur) var(--ease), opacity var(--dur-fast) var(--ease),
                      border-radius var(--dur) var(--ease), visibility 0s;
        }
        .card.min {
          transform: scale(.13); opacity: 0; border-radius: 48px; visibility: hidden;
          transition: transform var(--dur) var(--ease), opacity var(--dur) var(--ease),
                      border-radius var(--dur) var(--ease), visibility 0s var(--dur);
        }
        .card > * { transition: opacity var(--dur-fast) var(--ease); }
        .card.min > * { opacity: 0; transition-duration: 90ms; }
        .head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #7fc8f8; flex: none; transition: background var(--dur-fast) var(--ease); }
        .dot.rec { background: #f28b82; animation: pulse 1.2s infinite; }
        .dot.inf { background: #cbe896; }
        @keyframes pulse { 50% { opacity: .35; } }
        .head b { font-size: 12px; letter-spacing: .04em; flex: 1; }
        .head button { background: none; border: none; color: #8a90a2; cursor: pointer; font-size: 14px; padding: 0 2px; transition: color .12s, transform var(--dur) var(--ease); }
        .head button:hover { color: #e8e4da; }
        #gear.open { transform: rotate(90deg); color: #e8e4da; }
        .sep { height: 1px; background: #2a3140; margin-bottom: 5px; transition: height var(--dur) var(--ease), margin-bottom var(--dur) var(--ease), opacity var(--dur-fast) var(--ease); }
        .sep.hide { height: 0; margin-bottom: 0; opacity: 0; }
        .status { color: #8a90a2; line-height: 1.45; min-height: 16px; margin-bottom: 5px; word-wrap: break-word; overflow: hidden; }
        .prog { height: 0; background: #1d222b; border-radius: 2px; overflow: hidden; margin-bottom: 0; opacity: 0; transition: height var(--dur) var(--ease), margin-bottom var(--dur) var(--ease), opacity var(--dur-fast) var(--ease); }
        .prog.show { height: 4px; margin-bottom: 6px; opacity: 1; }
        .prog i { display: block; height: 100%; width: 0; background: linear-gradient(90deg,#7fc8f8,#cbe896); transition: width var(--dur-fast) linear; }
        .collapse { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dur) var(--ease), opacity var(--dur-fast) var(--ease); }
        .collapse.open { grid-template-rows: 1fr; }
        .collapse > .clip { min-height: 0; overflow: hidden; }
        .collapse > .clip > * { opacity: 0; transition: opacity var(--dur-fast) var(--ease); }
        .collapse.open > .clip > * { opacity: 1; transition-delay: 70ms; }
        .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px; }
        .stat { background: #1d222b; border-radius: 6px; padding: 4px 8px; }
        .stat .k { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: #8a90a2; }
        .stat .v { font-size: 13px; margin-top: 2px; }
        .row { display: flex; align-items: stretch; gap: 8px; }
        .toggle {
          flex: 0 0 30px; width: 30px; height: 30px;
          display: flex; align-items: center; justify-content: center;
          color: #8a90a2; border: none; background: none; border-radius: 7px;
          position: relative; z-index: 0;
          cursor: pointer; padding: 0; transition: color .12s;
        }
        .toggle::before {
          content: ''; position: absolute; inset: 0; z-index: -1;
          background: #1d222b; border: 1px solid #2a3140; border-radius: 7px;
          transition: background .12s, border-color .12s, box-shadow .12s, transform .16s;
        }
        .toggle:hover:not(:disabled) { color: #e8e4da; }
        .toggle:hover:not(:disabled)::before { transform: scale(.92); }
        .toggle.on { color: #0d0f13; }
        .toggle.on::before {
          background: #7fc8f8; border-color: #7fc8f8;
          box-shadow: 0 0 10px rgba(127, 200, 248, .35);
        }
        .toggle.cancel { color: #0d0f13; }
        .toggle.cancel::before {
          background: #f28b82; border-color: #f28b82;
          box-shadow: 0 0 10px rgba(242, 139, 130, .35);
        }
        .toggle.on:hover:not(:disabled), .toggle.cancel:hover:not(:disabled) { color: #000; }
        .toggle:disabled { opacity: .35; cursor: default; }
        .toggle svg { display: block; margin: auto; flex: none; }
        .primary {
          flex: 1; color: #182008; font-weight: 600; font-size: 12px;
          border: none; height: 30px; padding: 0 10px; cursor: pointer;
          position: relative; z-index: 0; background: none;
          transition: color .12s;
        }
        .primary::before {
          content: ''; position: absolute; inset: 0; z-index: -1;
          background: #cbe896; border-radius: 7px;
          transition: transform .16s;
        }
        .primary:hover:not(:disabled) { color: #0d0f13; }
        .primary:hover:not(:disabled)::before { transform: scale(.97); }
        .primary:disabled { opacity: .4; cursor: default; }
        .opt { display: flex; align-items: center; gap: 5px; color: #8a90a2; font-size: 11px; }
        input[type=checkbox] { accent-color: #7fc8f8; }
        .bubble {
          position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
          width: 40px; height: 40px; border-radius: 50%;
          line-height: 1; padding-bottom: 2px;
          border: none; background: none; color: #cbe896; font-size: 18px;
          display: flex; align-items: center; justify-content: center; cursor: pointer;
          transform-origin: 100% 100%; transform: scale(.35); opacity: 0; visibility: hidden;
          transition: color .12s, transform var(--dur) var(--ease),
                      opacity var(--dur-fast) var(--ease), visibility 0s var(--dur);
        }
        .bubble.show {
          transform: none; opacity: 1; visibility: visible;
          transition: color .12s, transform var(--dur) var(--ease),
                      opacity var(--dur) var(--ease), visibility 0s;
        }
        .bubble::before {
          content: ''; position: absolute; inset: 0; z-index: -1;
          background: #14171d; border: 1px solid #2a3140; border-radius: 50%;
          box-shadow: 0 6px 20px rgba(0,0,0,.5);
          transition: transform .16s;
        }
        .bubble:hover { color: #e0f4b8; }
        .bubble:hover::before { transform: scale(.92); }
        .settings { display: grid; grid-template-columns: 1fr; gap: 5px; background: #1d222b; border-radius: 7px; padding: 7px 10px; margin-bottom: 6px; }
        .settings .opt { justify-content: space-between; }
        .settings input[type=number] { -moz-appearance: textfield; appearance: textfield; width: 44px; background: none; border: none; color: #e8e4da; font-size: 11px; padding: 4px 6px 4px 2px; text-align: right; }
        .num { display: inline-flex; align-items: stretch; background: #14171d; border: 1px solid #2a3140; border-radius: 5px; overflow: hidden; }
        .num .steps { display: flex; flex-direction: column; border-right: 1px solid #2a3140; }
        .num .steps button { flex: 1; background: #1d222b; border: none; color: #8a90a2; cursor: pointer; font-size: 7px; line-height: 1; padding: 1px 4px; }
        .num .steps button:hover { color: #e8e4da; }
        .settings .inline { display: flex; align-items: center; gap: 6px; }
      </style>
      <div id="wrap" class="boot">
        <div class="card" id="card">
          <div class="head"><span class="dot" id="dot"></span><b>SEAMLOOP</b><button id="gear" title="Settings">\u2699</button><button id="min" title="Minimize">\u2013</button></div>
          <div class="sep" id="sep"></div>
          <div class="collapse" id="settingsWrap"><div class="clip">
            <div class="settings" id="settings">
              <div class="opt">min. loop length (s.) <span class="num"><span class="steps"><button data-dir="up">\u25b4</button><button data-dir="down">\u25be</button></span><input id="setMinLoop" type="number" value="10" min="2" max="600" step="1" /></span></div>
              <div class="opt">similarity threshold <span class="num"><span class="steps"><button data-dir="up">\u25b4</button><button data-dir="down">\u25be</button></span><input id="setThr" type="number" value="0.80" min="0.50" max="0.98" step="0.01" /></span></div>
              <div class="opt"><span>micro-crossfade (ms.)</span><span class="inline"><input id="setXfadeOn" type="checkbox" checked /><span class="num"><span class="steps"><button data-dir="up">\u25b4</button><button data-dir="down">\u25be</button></span><input id="setXfadeMs" type="number" value="10" min="0" max="60" step="1" /></span></span></div>
              <div class="opt" title="On: capture the encoded stream directly (network speed). Off: play the video through once, audibly, and record the decoded audio (slower, but works where stream capture cannot)."><span>fast mode</span><input id="setFast" type="checkbox" checked /></div>
            </div>
          </div></div>
          <div class="status" id="status">Idle.</div>
          <div class="prog" id="prog"><i id="bar"></i></div>
          <div class="collapse" id="statsWrap"><div class="clip">
            <div class="stats" id="stats">
              <div class="stat"><div class="k">start</div><div class="v" id="sStart">-</div></div>
              <div class="stat"><div class="k">end</div><div class="v" id="sEnd">-</div></div>
            </div>
          </div></div>
          <div class="row">
            <button class="toggle" id="loopToggle" title="Engage loop" disabled></button>
            <button class="primary" id="primary"><span id="primaryLabel">Loop</span></button>
          </div>
        </div>
        <div class="bubble" id="bubble" title="Seamloop">\u221e</div>
      </div>
    `;
    const $ = (id) => root.getElementById(id);

    // icons are built as dom nodes (not innerHTML) to satisfy amo's sanitizer lint
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs) => {
      const el = document.createElementNS(SVG_NS, tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      return el;
    };
    const makePlayIcon = () => {
      const svg = svgEl('svg', { viewBox: '0 0 24 24', width: 13, height: 13, 'aria-hidden': 'true' });
      svg.appendChild(svgEl('path', { d: 'M7 4.5 L19 12 L7 19.5 Z', fill: 'currentColor' }));
      return svg;
    };
    const makeStopIcon = () => {
      const svg = svgEl('svg', { viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': 'true' });
      svg.appendChild(svgEl('rect', { x: 3, y: 3, width: 8, height: 8, rx: 1, fill: 'currentColor' }));
      return svg;
    };
    const makeXIcon = () => {
      const svg = svgEl('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' });
      const g = svgEl('g', { transform: 'rotate(45 12 12)', fill: 'currentColor' });
      g.appendChild(svgEl('rect', { x: 3.5, y: 10.4, width: 17, height: 3.2, rx: 1.6 }));
      g.appendChild(svgEl('rect', { x: 10.4, y: 3.5, width: 3.2, height: 17, rx: 1.6 }));
      svg.appendChild(g);
      return svg;
    };
    let togIcon = 'play';
    $('loopToggle').replaceChildren(makePlayIcon());

    const animatable = (el) =>
      !(rmq && rmq.matches) && !$('wrap').classList.contains('boot') && el.getClientRects().length > 0;

    const fadeSwap = (el, text) => {
      if (el.textContent === text) return;
      el.textContent = text;
      if (animatable(el)) el.animate([{ opacity: .25 }, { opacity: 1 }], { duration: MOTION.blip, easing: MOTION.ease });
    };

    // keep keystrokes from reaching youtube's hotkeys
    for (const t of ['keydown', 'keyup', 'keypress']) {
      host.addEventListener(t, (e) => e.stopPropagation());
    }

    // persistence

    const MIN_KEY = 'seamloopMinimized';
    const SETTINGS_KEY = 'seamloopSettings';
    let minimized = false;

    SeamloopEnv.get(MIN_KEY, () => {
      try {
        const v = localStorage.getItem(MIN_KEY);
        return v == null ? null : (v === '1' || v === 'true');
      } catch (_) { return null; }
    }).then((v) => { if (v != null) { minimized = !!v; api.applyVis(true); } });

    const saveMinimized = () => SeamloopEnv.set(MIN_KEY, minimized);

    const saveSettings = () => SeamloopEnv.set(SETTINGS_KEY, {
      minLoop: $('setMinLoop').value,
      thr: $('setThr').value,
      xfOn: $('setXfadeOn').checked,
      xfMs: $('setXfadeMs').value,
      fast: $('setFast').checked,
    });

    SeamloopEnv.get(SETTINGS_KEY, () => {
      try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (_) { return null; }
    }).then((s) => {
      if (!s || typeof s !== 'object') return;
      if (s.minLoop != null) $('setMinLoop').value = s.minLoop;
      if (s.thr != null) $('setThr').value = s.thr;
      if (s.xfOn != null) $('setXfadeOn').checked = !!s.xfOn;
      if (s.xfMs != null) $('setXfadeMs').value = s.xfMs;
      if (s.fast != null) $('setFast').checked = !!s.fast;
    });

    // wiring

    $('min').addEventListener('click', () => { minimized = true; saveMinimized(); api.applyVis(); });
    $('bubble').addEventListener('click', () => { minimized = false; saveMinimized(); api.applyVis(); });
    $('gear').addEventListener('click', () => {
      const open = !$('settingsWrap').classList.contains('open');
      $('settingsWrap').classList.toggle('open', open);
      $('gear').classList.toggle('open', open);
      $('sep').classList.toggle('hide', open);
    });

    const clampNum = (el, lo, hi, fb) => {
      const v = parseFloat(el.value);
      return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
    };

    for (const id of ['setMinLoop', 'setThr', 'setXfadeOn', 'setXfadeMs', 'setFast']) {
      $(id).addEventListener('change', saveSettings);
    }
    root.querySelectorAll('.num .steps button').forEach((b) => {
      b.addEventListener('click', () => {
        const inp = b.closest('.num').querySelector('input');
        try { b.dataset.dir === 'up' ? inp.stepUp() : inp.stepDown(); } catch (_) {}
        inp.dispatchEvent(new Event('change'));
      });
    });
    $('setXfadeOn').addEventListener('change', () => cb.onXfadeChanged());
    $('setXfadeMs').addEventListener('change', () => cb.onXfadeChanged());
    $('setFast').addEventListener('change', () => cb.onModeChanged());
    $('setMinLoop').addEventListener('change', () => cb.onDetectionChanged());
    $('setThr').addEventListener('change', () => cb.onDetectionChanged());

    $('primary').addEventListener('click', () => {
      const u = cb.ui();
      if (u.phase === 'analyzing') return;
      if (u.busy) cb.onAnalyzeNow();
      else if (u.phase === 'idle') cb.onLoop();
      else cb.onReload(); // ready | engaged | failed
    });

    $('loopToggle').addEventListener('click', () => {
      const u = cb.ui();
      if (u.busy) { cb.onCancelCapture(); return; }
      if (u.phase === 'analyzing') { cb.onCancelAnalysis(); return; }
      if (!u.result) return;
      if (u.phase === 'engaged') cb.onDisengage();
      else cb.onEngage();
    });

    const api = {
      mount() {
        (document.body || document.documentElement).appendChild(host);
        this.applyVis(true);
      },
      setVisible(v) { host.style.display = v ? '' : 'none'; },
      applyVis(instant) {
        const w = $('wrap');
        if (instant) w.classList.add('boot');
        $('card').classList.toggle('min', minimized);
        $('bubble').classList.toggle('show', minimized);
        if (instant) {
          void $('card').offsetWidth;
          requestAnimationFrame(() => w.classList.remove('boot'));
        }
      },
      status(t) {
        const el = $('status');
        if (el.textContent === t) return;
        if (!animatable(el)) { el.textContent = t; return; }
        const from = el.offsetHeight;
        el.textContent = t;
        const to = el.offsetHeight;
        if (from !== to) el.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: MOTION.dur, easing: MOTION.ease });
        el.animate([{ opacity: .25 }, { opacity: 1 }], { duration: MOTION.blip, easing: MOTION.ease });
      },
      progress(p) {
        $('prog').classList.toggle('show', p > 0);
        $('bar').style.width = (p * 100).toFixed(1) + '%';
      },
      getSettings() {
        return {
          minLoopSec: clampNum($('setMinLoop'), 2, 600, 10),
          simThreshold: clampNum($('setThr'), 0.5, 0.98, 0.80),
          xfadeOn: $('setXfadeOn').checked,
          xfadeMs: clampNum($('setXfadeMs'), 0, 60, 10),
          fastMode: $('setFast').checked,
        };
      },
      render() {
        const u = cb.ui();
        const dot = $('dot');
        dot.className = 'dot' + (u.busy ? ' rec' : u.phase === 'engaged' ? ' inf' : '');
        const btn = $('primary');
        btn.disabled = u.phase === 'analyzing' || (u.phase === 'failed' && u.failedTerminal);
        fadeSwap($('primaryLabel'),
          u.phase === 'analyzing' ? 'Analyzing\u2026' :
          u.busy ? 'Analyze Now' :
          u.phase === 'idle' ? 'Loop' : 'Reload');
        const tog = $('loopToggle');
        const cancel = u.busy || u.phase === 'analyzing';
        tog.disabled = !cancel && !u.result;
        tog.classList.toggle('cancel', cancel);
        tog.classList.toggle('on', !cancel && u.phase === 'engaged');
        tog.title = cancel ? (u.phase === 'analyzing' ? 'Cancel analysis' : 'Cancel capture')
          : u.phase === 'engaged' ? 'Disengage' : 'Engage';
        const want = cancel ? 'x' : u.phase === 'engaged' ? 'stop' : 'play';
        if (togIcon !== want) {
          togIcon = want;
          const icon = togIcon === 'x' ? makeXIcon() : togIcon === 'stop' ? makeStopIcon() : makePlayIcon();
          tog.replaceChildren(icon);
          if (animatable(tog)) {
            icon.animate([{ opacity: 0, transform: 'scale(.55)' }, { opacity: 1, transform: 'scale(1)' }],
              { duration: MOTION.blip, easing: MOTION.ease });
          }
        }
        $('statsWrap').classList.toggle('open', !!u.result);
        if (u.result) {
          $('sStart').textContent = clock(Math.floor(u.result.mediaStart));
          $('sEnd').textContent = clock(Math.ceil(u.result.mediaEnd));
        }
      },
    };
    return api;
  }

  window.SeamloopPanel = { create };
})();
