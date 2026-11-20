/* PORKIES — host (TV) client. Renders purely from the server's `state` event. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function fmt(n) { return (Number(n) || 0).toLocaleString('en-GB'); }
  function safeColor(c) { return /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#a99bc9'; }

  var root = $('#screen');
  var overlay = $('#overlay');
  var overlayText = $('#overlay-text');
  var toastEl = $('#toast');

  var S = null;            // latest state
  var offset = 0;          // server clock - local clock
  var screenKey = '';
  var ui = {};             // refs for the current screen
  var cleanups = [];       // timers etc. belonging to the current screen
  var knownIds = null;     // player ids seen so far (for the join blip)

  var PHASE_MS = { writing: 60000, voting: 30000, scores: 8000 }; // fallback if the server sends no phaseMs
  var MAX_PLAYERS = 12;
  var MODES = {
    classic: { label: 'Classic', badge: 'CLASSIC', desc: '7 questions · 60s to write, 30s to vote' },
    quickfire: { label: 'Quickfire ⚡', badge: '⚡ QUICKFIRE', desc: '12 questions · 25s to write, 15s to vote · ❤ best-porkie bonus' }
  };
  var QUICKFIRE_TEMPO = 1.12; // music plays ~12% faster in Quickfire
  var modeBadge = $('#mode-badge');
  function modeName() { return S && MODES[S.mode] ? S.mode : 'classic'; }
  function tempoMul() { return S && S.mode === 'quickfire' ? QUICKFIRE_TEMPO : 1; }

  function now() { return Date.now() + offset; }
  function later(fn, ms) {
    var t = setTimeout(fn, ms);
    cleanups.push(function () { clearTimeout(t); });
  }

  /* ───────────── sound (WebAudio, silent until a gesture unlocks it) ───────────── */
  // graph: sfxBus + musBus -> master -> compressor -> speakers
  var actx = null, master = null, sfxBus = null, musBus = null, noiseBuf = null;
  var muted = false, musicOn = true;
  var MUSIC_LEVEL = 0.3, SFX_LEVEL = 1.5;
  try {
    muted = localStorage.getItem('porkies_host_muted') === '1';
    musicOn = localStorage.getItem('porkies_host_music') !== '0';
  } catch (e) {}

  function initAudio() {
    if (actx) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var c = new AC();
      var comp = c.createDynamicsCompressor();
      master = c.createGain(); master.gain.value = muted ? 0 : 1;
      sfxBus = c.createGain(); sfxBus.gain.value = SFX_LEVEL;
      musBus = c.createGain(); musBus.gain.value = MUSIC_LEVEL;
      sfxBus.connect(master); musBus.connect(master);
      master.connect(comp); comp.connect(c.destination);
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      actx = c;
      actx.onstatechange = audioStateChanged;
      audioStateChanged();
    } catch (e) { actx = null; }
  }
  function audioStateChanged() {
    document.body.classList.toggle('audio-on', !!(actx && actx.state === 'running'));
    musicRefresh();
  }
  function unlockAudio() {
    try {
      initAudio();
      if (actx && actx.state === 'suspended') { var p = actx.resume(); if (p && p.catch) p.catch(function () {}); }
    } catch (e) {}
  }
  /** Briefly pull the music down under a sting. */
  function duck(secs) {
    if (!actx || !musBus) return;
    try {
      var t = actx.currentTime;
      musBus.gain.cancelScheduledValues(t);
      musBus.gain.setTargetAtTime(MUSIC_LEVEL * 0.2, t, 0.04);
      musBus.gain.setTargetAtTime(MUSIC_LEVEL, t + secs, 0.35);
    } catch (e) {}
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, unlockAudio, { passive: true });
  });

  function tone(freq, start, dur, type, vol, slideTo) {
    if (muted || !actx || actx.state !== 'running') return;
    try {
      var t0 = actx.currentTime + (start || 0);
      var o = actx.createOscillator();
      var g = actx.createGain();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.15, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(sfxBus);
      o.start(t0); o.stop(t0 + dur + 0.03);
    } catch (e) {}
  }
  var sfx = {
    join: function () { tone(523, 0, 0.12, 'triangle', 0.16); tone(784, 0.1, 0.18, 'triangle', 0.16); },
    done: function () { tone(880, 0, 0.09, 'sine', 0.1); },
    tick: function () { tone(1100, 0, 0.06, 'square', 0.05); },
    pop: function () { tone(330, 0, 0.16, 'triangle', 0.14, 660); },
    voters: function () { tone(587, 0, 0.1, 'sine', 0.1); tone(740, 0.08, 0.12, 'sine', 0.1); },
    lie: function () {
      duck(1.2);
      tone(311, 0, 0.28, 'sawtooth', 0.11, 233);
      tone(233, 0.26, 0.5, 'sawtooth', 0.11, 147);
    },
    truth: function () {
      duck(1.8);
      [523, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.11, 0.2, 'triangle', 0.16); });
      tone(1047, 0.46, 0.6, 'triangle', 0.16); tone(784, 0.46, 0.6, 'triangle', 0.1);
    },
    win: function () {
      duck(2.2);
      [392, 523, 659, 784, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.14, 0.22, 'square', 0.07); });
      tone(1047, 1.0, 0.9, 'triangle', 0.16); tone(1319, 1.0, 0.9, 'triangle', 0.1);
    },
    whoosh: function () { tone(200, 0, 0.3, 'sine', 0.08, 800); },
    best: function () { [784, 988, 1175, 1568].forEach(function (f, i) { tone(f, 0.55 + i * 0.07, 0.16, 'triangle', 0.12); }); }
  };

  /* ───────────── background music (procedural step sequencer) ─────────────
     Original tunes. Grid = swung 8th notes, 8 steps per bar. Each mood runs as a
     "track" with its own gain bus so moods cross-fade on phase change. Notes are
     scheduled against actx.currentTime by a short look-ahead timer. */
  var _ = null; // rest
  var CH = { maj: [4, 7, 12], maj7: [4, 7, 11], m7: [3, 7, 10], dom: [4, 7, 10], six: [4, 7, 9], m: [3, 7, 12] };
  var MOODS = {
    lobby: { // relaxed and catchy, F major
      bpm: 112, swing: 0.2, vol: 1, lead: 'pluck',
      chords: [[5, 'maj7'], [2, 'm7'], [7, 'm7'], [0, 'dom'], [5, 'maj7'], [2, 'dom'], [7, 'm7'], [0, 'dom']],
      kick: 'x...x...', snare: '..x...x.', hat: 'x.xxx.xx', comp: '...x..x.',
      bass: [[0, _, 7, _, 12, _, 7, _], [0, _, 7, 0, 12, _, 7, 12]],
      mel: [72, _, 69, 72, _, 74, 72, _,  69, _, 65, 69, _, 72, 69, _,
            70, _, 67, 70, _, 74, 72, 70,  67, _, _, 64, 67, _, 70, _,
            72, _, 69, 72, _, 77, 76, 74,  72, _, 66, 69, _, 72, _, _,
            70, _, 74, 70, _, 67, 69, 70,  72, _, _, 76, _, 72, 70, 67]
    },
    writing: { // "thinking" groove, D minor; gets urgent in the last 10 s
      bpm: 100, swing: 0.22, vol: 0.9, lead: 'organ',
      chords: [[2, 'm7'], [2, 'm7'], [10, 'maj7'], [9, 'dom'], [2, 'm7'], [7, 'm7'], [10, 'maj7'], [9, 'dom']],
      kick: 'x....x..', snare: '..x...x.', hat: 'x.xxx.xx', comp: '.x....x.',
      bass: [[0, _, _, 7, _, 12, _, 7]],
      mel: [74, _, _, 77, _, 74, _, _,  72, _, 69, _, _, _, _, _,
            74, _, _, 77, _, 74, _, 70,  73, _, _, _, 69, _, 73, 76,
            77, _, _, 74, _, 77, _, _,  79, _, 74, _, 70, _, _, _,
            77, _, _, 74, _, 70, _, 74,  73, _, 76, _, 73, _, 69, _]
    },
    voting: { // tense and sparse, E minor
      bpm: 92, swing: 0.15, vol: 0.85, lead: 'pluck',
      chords: [[4, 'm'], [4, 'm'], [0, 'dom'], [11, 'dom']],
      kick: 'x.......', snare: '........', hat: '..r...r.', comp: '....x...',
      bass: [[0, _, _, _, _, 0, _, _], [0, _, _, _, _, 0, _, 7]],
      mel: [_, _, 76, _, 79, _, 78, _,  76, _, _, _, _, _, 71, _,
            _, _, 76, _, 79, _, 82, _,  81, _, _, 78, _, 75, _, _]
    },
    reveal: { // quiet suspense bed, A minor
      bpm: 80, swing: 0.1, vol: 0.55, lead: 'pluck', pad: true,
      chords: [[9, 'm'], [9, 'm'], [5, 'maj7'], [4, 'dom']],
      kick: 'x.......', snare: '........', hat: '..-...-.', comp: '........',
      bass: [[0, _, _, _, _, _, 7, _]],
      mel: [_]
    },
    scores: { // upbeat, C major
      bpm: 132, swing: 0.18, vol: 1, lead: 'pluck',
      chords: [[0, 'six'], [9, 'dom'], [2, 'm7'], [7, 'dom']],
      kick: 'x...x...', snare: '..x...x.', hat: 'xxxxxxxx', comp: '..x..x.x',
      bass: [[0, _, 7, _, 12, _, 7, _], [0, 0, 7, _, 12, _, 7, 12]],
      mel: [76, 79, 81, 79, 76, _, 72, _,  73, 76, 79, 76, 73, _, 69, _,
            74, 77, 81, 77, 74, _, 72, 74,  71, _, 74, 77, _, 74, 71, 67,
            76, 79, 81, 84, 81, _, 79, _,  79, 76, 73, 76, 79, _, 81, _,
            77, _, 74, 77, 81, _, 77, 74,  79, _, 79, _, 83, _, _, _]
    },
    gameover: { // triumphant, G major
      bpm: 126, swing: 0.1, vol: 1, lead: 'brass',
      chords: [[7, 'maj'], [0, 'maj'], [2, 'maj'], [7, 'maj'], [4, 'm'], [0, 'maj'], [2, 'maj'], [2, 'dom']],
      kick: 'x..xx...', snare: '..x...x.', hat: 'x.x.x.xo', comp: 'x..x..x.',
      bass: [[0, _, 0, 7, _, 7, 12, _]],
      mel: [67, _, 71, 74, 79, _, 79, _,  76, _, 79, 76, 72, _, 76, _,
            74, _, 78, 81, _, 78, 74, _,  79, _, _, 74, 71, _, 67, _,
            71, _, 76, 79, 83, _, 83, _,  84, _, 79, 76, _, 79, 84, _,
            86, _, 81, 78, _, 81, 86, _,  84, _, 81, _, 78, _, 74, _]
    }
  };

  var mus = { tracks: [], timer: 0, mood: null, urgent: false };
  function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function barPat(p, bar) { return Array.isArray(p) ? p[bar % p.length] : p; }

  function mOsc(bus, type, f, t, a, d, vol, cut, slide) {
    var o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + a + d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    var out = o;
    if (cut) { var fl = actx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = cut; o.connect(fl); out = fl; }
    out.connect(g); g.connect(bus);
    o.start(t); o.stop(t + a + d + 0.05);
  }
  function mNoise(bus, t, d, vol, hp) {
    var s = actx.createBufferSource(), fl = actx.createBiquadFilter(), g = actx.createGain();
    s.buffer = noiseBuf; fl.type = 'highpass'; fl.frequency.value = hp;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    s.connect(fl); fl.connect(g); g.connect(bus);
    s.start(t, Math.random() * 0.5); s.stop(t + d + 0.02);
  }
  var drum = {
    kick: function (b, t, v) { mOsc(b, 'sine', 150, t, 0.004, 0.2, 0.5 * v, 0, 42); },
    snare: function (b, t, v) { mNoise(b, t, 0.13, 0.16 * v, 1600); mOsc(b, 'triangle', 190, t, 0.003, 0.08, 0.12 * v, 0, 120); },
    hat: function (b, t, v) { mNoise(b, t, 0.035, 0.09 * v, 7000); },
    open: function (b, t, v) { mNoise(b, t, 0.22, 0.08 * v, 6000); },
    rim: function (b, t, v) { mOsc(b, 'triangle', 1500, t, 0.002, 0.035, 0.14 * v, 0, 900); }
  };
  function leadNote(b, kind, m, t, v) {
    var f = hz(m);
    if (kind === 'organ') {
      mOsc(b, 'sine', f, t, 0.01, 0.3, 0.13 * v);
      mOsc(b, 'sine', f * 2, t, 0.01, 0.22, 0.05 * v);
      mOsc(b, 'sine', f * 3, t, 0.01, 0.14, 0.025 * v);
    } else if (kind === 'brass') {
      mOsc(b, 'sawtooth', f, t, 0.025, 0.3, 0.085 * v, 2600);
      mOsc(b, 'sawtooth', f * 1.006, t, 0.025, 0.3, 0.06 * v, 2000);
    } else {
      mOsc(b, 'square', f, t, 0.005, 0.24, 0.075 * v, 1900);
      mOsc(b, 'triangle', f * 2, t, 0.005, 0.1, 0.03 * v);
    }
  }

  function playStep(tr, t) {
    var m = tr.m, s = tr.step % 8, bar = Math.floor(tr.step / 8), b = tr.bus;
    var urgent = tr.name === 'writing' && mus.urgent;
    var ch = m.chords[bar % m.chords.length], pc = ch[0], iv = CH[ch[1]];
    var acc = (s % 2) ? 0.7 : 1;

    if (barPat(m.kick, bar)[s] === 'x') drum.kick(b, t, 1);
    if (barPat(m.snare, bar)[s] === 'x') drum.snare(b, t, 1);
    var h = barPat(m.hat, bar)[s];
    if (h === 'x') drum.hat(b, t, acc);
    else if (h === '-') drum.hat(b, t, 0.45);
    else if (h === 'o') drum.open(b, t, 1);
    else if (h === 'r') drum.rim(b, t, 1);

    var bn = barPat(m.bass, bar)[s];
    if (bn !== _ && bn !== undefined) {
      var note = 36 + pc + (bn || 0);
      if (note > 52) note -= 12;
      mOsc(b, 'triangle', hz(note), t, 0.008, 0.26, 0.3, 700);
      mOsc(b, 'sine', hz(note + 12), t, 0.008, 0.12, 0.06);
    }
    if (barPat(m.comp, bar)[s] === 'x') {
      var base = (pc <= 5 ? 60 : 48) + pc;
      iv.forEach(function (x) { mOsc(b, 'triangle', hz(base + x), t, 0.006, 0.16, 0.05, 2400); });
    }
    if (m.pad && s === 0) {
      var barLen = 8 * 30 / (m.bpm * tempoMul()), pb = 48 + pc;
      [0, iv[0], iv[1]].forEach(function (x) { mOsc(b, 'sawtooth', hz(pb + x), t, barLen * 0.4, barLen * 0.75, 0.05, 520); });
      mOsc(b, 'sine', hz(pb + 24 + iv[1]), t, barLen * 0.5, barLen * 0.6, 0.02);
    }
    var ln = m.mel[tr.step % m.mel.length];
    if (ln) leadNote(b, m.lead, urgent ? ln + 12 : ln, t, urgent ? 0.7 : 1);

    if (urgent) { // extra percussion + a rising chromatic tick layer
      if (h !== 'x') drum.hat(b, t, 0.6);
      if (s === 3 || s === 5 || s === 7) drum.rim(b, t, 0.7);
      mOsc(b, 'square', hz(74 + Math.min(22, Math.floor(tr.urg / 2))), t, 0.003, 0.07, 0.05, 3000);
      tr.urg++;
    }
  }

  function fadeTrack(tr, secs) {
    if (tr.stopAt !== Infinity) return;
    var t = actx.currentTime;
    try {
      tr.bus.gain.cancelScheduledValues(t);
      tr.bus.gain.setValueAtTime(Math.max(0.0001, tr.bus.gain.value), t);
      tr.bus.gain.linearRampToValueAtTime(0.0001, t + secs);
    } catch (e) {}
    tr.stopAt = t + secs;
  }
  function dropTrack(tr) { try { tr.bus.disconnect(); } catch (e) {} }

  function startTrack(name) {
    var t = actx.currentTime, m = MOODS[name];
    mus.tracks.forEach(function (tr) { fadeTrack(tr, 1.5); });   // cross-fade out
    var bus = actx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.linearRampToValueAtTime(m.vol, t + 1.2);            // ...and in
    bus.connect(musBus);
    mus.tracks.push({ name: name, m: m, bus: bus, step: 0, base: t + 0.08, next: t + 0.08, stopAt: Infinity, urg: 0 });
  }

  function schedule() {
    if (!actx || actx.state !== 'running') return;
    var t = actx.currentTime, horizon = t + 0.15;
    for (var i = mus.tracks.length - 1; i >= 0; i--) {
      var tr = mus.tracks[i];
      if (t > tr.stopAt + 0.3) { dropTrack(tr); mus.tracks.splice(i, 1); continue; }
      if (tr.next < t - 0.25) {            // timer was throttled: skip ahead, don't pile up notes
        tr.step += tr.step % 2;            // land on a beat
        tr.base = tr.next = t + 0.05;
      }
      while (tr.next < horizon) {
        if (tr.next < tr.stopAt) { try { playStep(tr, tr.next); } catch (e) {} }
        var sd = 30 / (tr.m.bpm * tempoMul() * (tr.name === 'writing' && mus.urgent ? 1.15 : 1));
        tr.step++; tr.base += sd;
        tr.next = tr.base + ((tr.step % 2) ? tr.m.swing * sd : 0);
      }
    }
  }

  function musicShouldRun() {
    return !!(actx && actx.state === 'running' && musicOn && !muted && !document.hidden && mus.mood && MOODS[mus.mood]);
  }
  function musicStop() {
    clearInterval(mus.timer); mus.timer = 0;
    var old = mus.tracks; mus.tracks = [];
    old.forEach(function (tr) { fadeTrack(tr, 0.15); });
    setTimeout(function () { old.forEach(dropTrack); }, 700);
  }
  /** Start/stop the sequencer to match audio state, toggles and tab visibility. */
  function musicRefresh() {
    if (!actx || !mus) return;
    var run = musicShouldRun();
    if (run && !mus.timer) { startTrack(mus.mood); mus.timer = setInterval(schedule, 25); schedule(); }
    else if (!run && mus.timer) musicStop();
  }
  function musicSetMood(name) {
    if (mus.mood === name) return;
    mus.mood = name;
    if (mus.timer && musicShouldRun()) startTrack(name);
    else musicRefresh();
  }
  document.addEventListener('visibilitychange', musicRefresh);
  initAudio(); // may already be allowed to play (kiosk / autoplay permitted)

  /* ───────────── confetti (canvas) ───────────── */
  var cv = $('#confetti');
  var cx = cv.getContext ? cv.getContext('2d') : null;
  var parts = [];
  var rafId = 0;
  var lastT = 0;
  var CONF_COLORS = ['#ff4f9a', '#ffd23f', '#3ddc97', '#4fc3ff', '#ff8a3d', '#b28dff', '#fff7e6'];

  function sizeCanvas() { cv.width = window.innerWidth; cv.height = window.innerHeight; }
  window.addEventListener('resize', sizeCanvas);
  sizeCanvas();

  function addParts(n, make) {
    if (!cx) return;
    if (parts.length > 900) return;
    for (var i = 0; i < n; i++) parts.push(make());
    if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(confLoop); }
  }
  function mkPart(x, y, vx, vy) {
    var u = cv.width / 100;
    return {
      x: x, y: y, vx: vx, vy: vy,
      w: u * (0.5 + Math.random() * 0.6), h: u * (0.25 + Math.random() * 0.35),
      r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 12,
      c: CONF_COLORS[(Math.random() * CONF_COLORS.length) | 0],
      sway: Math.random() * 6.28
    };
  }
  function burst(n, fx, fy) {
    var W = cv.width, H = cv.height;
    addParts(n, function () {
      var a = Math.random() * 6.28, sp = (0.25 + Math.random() * 0.75) * H * 0.9;
      return mkPart(W * fx, H * fy, Math.cos(a) * sp, Math.sin(a) * sp - H * 0.35);
    });
  }
  function rain(n) {
    var W = cv.width, H = cv.height;
    addParts(n, function () {
      return mkPart(Math.random() * W, -Math.random() * H * 0.3, (Math.random() - 0.5) * W * 0.08, H * (0.15 + Math.random() * 0.25));
    });
  }
  function confLoop(t) {
    var dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
    var W = cv.width, H = cv.height, g = H * 0.9;
    cx.clearRect(0, 0, W, H);
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.vy += g * dt; p.vx *= (1 - 1.2 * dt);
      if (p.vy > H * 0.45) p.vy = H * 0.45;
      p.sway += dt * 5;
      p.x += (p.vx + Math.sin(p.sway) * W * 0.02) * dt; p.y += p.vy * dt; p.r += p.vr * dt;
      if (p.y > H + 40) { parts.splice(i, 1); continue; }
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r);
      cx.fillStyle = p.c; cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.sway)) + 1);
      cx.restore();
    }
    if (parts.length) rafId = requestAnimationFrame(confLoop);
    else { rafId = 0; cx.clearRect(0, 0, W, H); }
  }

  /* ───────────── small shared pieces ───────────── */
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }
  var ERRORS = { need_players: 'Need at least 2 players to start!' };
  function send(ev, payload) {
    if (!socket) return;
    socket.emit(ev, payload || {}, function (res) {
      if (res && res.ok === false) toast(ERRORS[res.error] || ('Nope: ' + res.error));
    });
  }

  function playerById(id) {
    var ps = (S && S.players) || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
    return null;
  }

  /** Static chip (reveal voters etc). */
  function miniChip(p) {
    var full = playerById(p.id);
    var c = el('span', 'chip');
    c.style.setProperty('--c', safeColor(full && full.color));
    c.appendChild(el('span', 'cname', p.name));
    return c;
  }

  /**
   * Keyed chip list: creates chips for new players, removes gone ones, and only
   * toggles classes on existing ones (so animations never restart).
   * mode: 'lobby' (kick button) | 'status' (lights up when done)
   */
  function syncChips(box, players, mode) {
    var map = box._chips || (box._chips = {});
    var first = !box._synced; box._synced = true;
    var seen = {};
    players.forEach(function (p) {
      seen[p.id] = true;
      var c = map[p.id];
      if (!c) {
        c = el('span', 'chip');
        c.appendChild(el('span', 'crown', '👑'));
        c._name = el('span', 'cname');
        c.appendChild(c._name);
        if (mode === 'lobby') {
          var k = el('button', 'kick', '✕');
          k.type = 'button';
          k.title = 'Kick';
          k.addEventListener('click', function () { send('host:kick', { playerId: p.id }); });
          c.appendChild(k);
        }
        map[p.id] = c;
        box.appendChild(c);
      }
      c.style.setProperty('--c', safeColor(p.color));
      if (c._name.textContent !== p.name) c._name.textContent = p.name;
      c.classList.toggle('vip', !!p.isVip);
      c.classList.toggle('off', !p.connected);
      if (mode === 'status') {
        var was = c.classList.contains('done');
        c.classList.toggle('done', !!p.done);
        if (p.done && !was && !first) sfx.done();
      }
    });
    Object.keys(map).forEach(function (id) {
      if (!seen[id]) { if (map[id].parentNode) map[id].parentNode.removeChild(map[id]); delete map[id]; }
    });
  }

  function questionEl(q, cls) {
    var d = el('div', 'qtext ' + (cls || ''));
    var text = (q && q.text) || '';
    var parts = text.split('_____');
    parts.forEach(function (part, i) {
      if (i > 0) {
        var b = el('span', 'blank');
        if (!ui.blank) ui.blank = b;
        d.appendChild(b);
      }
      if (part) d.appendChild(document.createTextNode(part));
    });
    if (text.length > 110) d.classList.add('long');
    else if (text.length > 70) d.classList.add('mid');
    return d;
  }

  function headEl(q, withTimer) {
    var h = el('div', 'qhead');
    var left = el('div', 'qmeta');
    if (q) {
      left.appendChild(el('span', 'qnum', 'Question ' + q.number + ' of ' + q.total));
      if (q.category) left.appendChild(el('span', 'qcat', q.category));
      if (q.multiplier > 1) {
        var label = q.multiplier === 2 ? 'DOUBLE POINTS' : q.multiplier === 3 ? 'TRIPLE POINTS' : '×' + q.multiplier + ' POINTS';
        left.appendChild(el('span', 'mult mult' + q.multiplier, '★ ' + label + ' ★'));
      }
    }
    h.appendChild(left);
    if (withTimer) h.appendChild(timerEl());
    return h;
  }

  var RING_C = 2 * Math.PI * 44;
  function timerEl() {
    var t = el('div', 'timer');
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    var bg = document.createElementNS(NS, 'circle');
    var fg = document.createElementNS(NS, 'circle');
    [bg, fg].forEach(function (c) { c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', 44); });
    bg.setAttribute('class', 'ring-bg'); fg.setAttribute('class', 'ring-fg');
    fg.setAttribute('stroke-dasharray', RING_C.toFixed(2));
    svg.appendChild(bg); svg.appendChild(fg);
    var num = el('div', 'timer-num', '');
    t.appendChild(svg); t.appendChild(num);
    ui.timer = { box: t, ring: fg, num: num, sec: null };
    return t;
  }

  function phaseTotal() {
    if (typeof S.phaseMs === 'number' && S.phaseMs > 0) return S.phaseMs; // full length of the phase, from the server
    var rem = S.deadline ? S.deadline - now() : 0;
    return Math.max(PHASE_MS[S.phase] || 1, rem);
  }

  /* ───────────── screens ───────────── */
  var builders = {}, patchers = {};

  // LOBBY
  builders.lobby = function () {
    var left = el('div', 'lobby-left');
    var logo = el('h1', 'logo');
    'PORKIES'.split('').forEach(function (ch, i) {
      var s = el('span', 'logo-l', ch); s.style.setProperty('--i', i); logo.appendChild(s);
    });
    logo.appendChild(el('span', 'logo-pig', '🐷'));
    left.appendChild(logo);
    left.appendChild(el('div', 'tagline', 'tell a whopper, spot the truth'));

    var join = el('div', 'join');
    join.appendChild(el('div', 'join-label', 'Join on your phone: go to'));
    ui.joinHost = el('div', 'join-host', '');
    join.appendChild(ui.joinHost);
    left.appendChild(join);

    var qrWrap = el('div', 'qr-wrap');
    var tile = el('div', 'qr-tile');
    var img = el('img');
    img.alt = 'QR code to join';
    img.addEventListener('error', function () { tile.style.display = 'none'; });
    img.src = '/qr.svg';
    tile.appendChild(img);
    qrWrap.appendChild(tile);
    var qrSide = el('div', 'qr-side');
    qrSide.appendChild(el('div', 'qr-hint', '…or scan me!'));
    qrSide.appendChild(el('div', 'qr-fallback', 'Not working? Try'));
    ui.lanUrl = el('div', 'lan-url', '');
    qrSide.appendChild(ui.lanUrl);
    qrWrap.appendChild(qrSide);
    left.appendChild(qrWrap);
    left.appendChild(el('div', 'sound-hint', '🔊 click anywhere for sound'));

    var right = el('div', 'lobby-right panel');
    var h = el('h2', 'lobby-h');
    h.appendChild(el('span', '', "WHO'S IN?"));
    ui.count = el('span', 'lobby-count', '');
    h.appendChild(ui.count);
    right.appendChild(h);
    ui.chips = el('div', 'chips lobby-chips');
    right.appendChild(ui.chips);
    ui.empty = el('div', 'lobby-empty', 'Waiting for players…');
    right.appendChild(ui.empty);

    var modeBox = el('div', 'mode-box');
    var sw = el('div', 'mode-switch');
    sw.setAttribute('role', 'group');
    sw.setAttribute('aria-label', 'Game mode');
    ui.modeBtns = {};
    Object.keys(MODES).forEach(function (m) {
      var b = el('button', 'mode-opt mode-' + m, MODES[m].label);
      b.type = 'button';
      b.addEventListener('click', function () { if (modeName() !== m) send('game:mode', { mode: m }); });
      ui.modeBtns[m] = b;
      sw.appendChild(b);
    });
    modeBox.appendChild(sw);
    ui.modeDesc = el('div', 'mode-desc', '');
    modeBox.appendChild(ui.modeDesc);
    right.appendChild(modeBox);

    var foot = el('div', 'lobby-foot');
    ui.start = el('button', 'btn', 'START');
    ui.start.type = 'button';
    ui.start.addEventListener('click', function () { send('game:start'); });
    foot.appendChild(ui.start);
    ui.note = el('div', 'lobby-note', '');
    foot.appendChild(ui.note);
    right.appendChild(foot);

    root.appendChild(left); root.appendChild(right);
  };
  patchers.lobby = function () {
    var ps = S.players || [];
    ui.joinHost.textContent = S.joinHost || '';
    ui.lanUrl.textContent = S.lanUrl || '';
    syncChips(ui.chips, ps, 'lobby');
    ui.count.textContent = ps.length + ' / ' + MAX_PLAYERS;
    ui.empty.style.display = ps.length ? 'none' : '';
    ui.start.disabled = ps.length < 2;
    var mode = modeName();
    Object.keys(ui.modeBtns).forEach(function (m) {
      ui.modeBtns[m].classList.toggle('on', m === mode);
      ui.modeBtns[m].setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    });
    if (ui.modeDesc.textContent !== MODES[mode].desc) ui.modeDesc.textContent = MODES[mode].desc;
    var vip = ps.filter(function (p) { return p.isVip; })[0];
    ui.note.textContent = ps.length < 2
      ? 'Need at least 2 players to start'
      : (vip ? '👑 ' + vip.name + ' can also start from their phone' : 'The first player can also start from their phone');
  };

  // WRITING
  builders.writing = function () {
    root.appendChild(headEl(S.question, true));
    var mid = el('div', 'qstage');
    mid.appendChild(questionEl(S.question, 'big'));
    root.appendChild(mid);
    root.appendChild(el('div', 'hint', '✏️ Write a convincing lie on your phone!'));
    ui.chips = el('div', 'chips status');
    root.appendChild(ui.chips);
    ui.total = phaseTotal();
    sfx.whoosh();
  };
  patchers.writing = function () { syncChips(ui.chips, S.players || [], 'status'); };

  // VOTING
  builders.voting = function () {
    root.appendChild(headEl(S.question, true));
    root.appendChild(questionEl(S.question, 'small'));
    ui.grid = el('div', 'options');
    root.appendChild(ui.grid);
    root.appendChild(el('div', 'hint', '🕵️ Which one is the truth? Vote on your phone!'));
    ui.chips = el('div', 'chips status');
    root.appendChild(ui.chips);
    ui.total = phaseTotal();
    ui.optSig = null;
    sfx.whoosh();
  };
  patchers.voting = function () {
    var opts = S.options || [];
    var sig = opts.map(function (o) { return o.id + ':' + o.text; }).join('|');
    if (sig !== ui.optSig) {
      ui.optSig = sig;
      var n = opts.length;
      var cols = n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : 5;
      var rows = Math.ceil(n / cols) || 1;
      ui.grid.textContent = '';
      ui.grid.style.setProperty('--cols', cols);
      ui.grid.className = 'options rows' + Math.min(rows, 4);
      opts.forEach(function (o, i) {
        var t = el('div', 'opt');
        t.style.setProperty('--i', i);
        t.appendChild(el('span', '', o.text));
        ui.grid.appendChild(t);
      });
    }
    syncChips(ui.chips, S.players || [], 'status');
  };

  // REVEAL
  builders.reveal = function () {
    root.appendChild(headEl(S.question, false));
    root.appendChild(questionEl(S.question, 'small'));
    ui.stage = el('div', 'rstage');
    root.appendChild(ui.stage);
    ui.dots = el('div', 'rdots');
    (S.reveal || []).forEach(function () { ui.dots.appendChild(el('i')); });
    root.appendChild(ui.dots);
    ui.rv = { step: -1, sub: -1, card: null };
    tickReveal(true);
  };
  patchers.reveal = function () {};

  function namesJoin(list) {
    var n = list.map(function (a) { return a.name; });
    if (n.length <= 1) return n.join('');
    return n.slice(0, -1).join(', ') + ' & ' + n[n.length - 1];
  }

  function buildRevealItem(i) {
    var item = S.reveal[i];
    var voters = item.voters || [], authors = item.authors || [];
    ui.stage.textContent = '';
    var wrap = el('div', 'ritem ' + (item.isTruth ? 'truth' : 'lie'));
    var card = el('div', 'rcard');
    var txt = el('div', 'rtext', item.text);
    if ((item.text || '').length > 22) txt.classList.add('long');
    card.appendChild(txt);

    var vs = el('div', 'rvoters');
    if (voters.length) {
      vs.appendChild(el('span', 'rv-label', 'picked by'));
      voters.forEach(function (v, k) {
        var c = miniChip(v);
        c.style.setProperty('--i', k);
        if (item.isTruth) c.appendChild(el('span', 'plus', '+' + fmt(item.points)));
        vs.appendChild(c);
      });
    } else {
      vs.appendChild(el('span', 'rv-label', 'picked by… nobody at all'));
    }
    card.appendChild(vs);
    card.appendChild(el('div', 'stamp', item.isTruth ? 'THE TRUTH!' : 'LIE!'));
    if (item.likes > 0) {
      var hearts = el('div', 'rlikes');
      hearts.appendChild(el('span', 'heart', '❤'));
      hearts.appendChild(el('span', '', item.likes));
      card.appendChild(hearts);
    }
    if (item.bestPorkie) {
      wrap.classList.add('best');
      var best = el('div', 'rbest');
      best.appendChild(el('span', 'rbest-t', '💖 BEST PORKIE'));
      if (item.bonus > 0) best.appendChild(el('span', 'rbest-b', '+' + fmt(item.bonus) + (authors.length > 1 ? ' each' : '')));
      card.appendChild(best);
    }
    wrap.appendChild(card);

    var credit = el('div', 'rcredit');
    if (item.isTruth) {
      credit.textContent = voters.length
        ? (voters.length === 1 ? 'Sharp eyes, ' : 'Sharp eyes: ') + namesJoin(voters) + '!'
        : 'Nobody found the truth!';
    } else if (authors.length) {
      credit.appendChild(el('span', 'by', 'by '));
      authors.forEach(function (a, k) {
        if (k > 0) credit.appendChild(el('span', 'by', k === authors.length - 1 ? ' & ' : ', '));
        var p = playerById(a.id);
        var s = el('span', 'author', a.name);
        s.style.color = safeColor(p && p.color);
        credit.appendChild(s);
      });
      credit.appendChild(el('span', 'pts', '+' + fmt(item.points) + (authors.length > 1 ? ' each' : '')));
    } else {
      credit.textContent = 'our lie — nobody wrote this one';
      credit.classList.add('decoy');
    }
    wrap.appendChild(credit);
    ui.stage.appendChild(wrap);
    ui.rv.card = wrap;

    var dots = ui.dots.children;
    for (var d = 0; d < dots.length; d++) {
      dots[d].className = d < i ? 'past' : d === i ? 'cur' : '';
    }
  }

  function applyRevealSub(i, sub) {
    var item = S.reveal[i], w = ui.rv.card;
    if (sub === 0) { sfx.pop(); }
    if (sub === 1) { w.classList.add('s1'); sfx.voters(); }
    if (sub === 2) {
      w.classList.add('s1'); w.classList.add('s2');
      if (item.isTruth) {
        sfx.truth(); burst(160, 0.5, 0.45);
        if (ui.blank) { ui.blank.textContent = item.text; ui.blank.classList.add('filled'); }
      } else {
        sfx.lie();
        if (item.bestPorkie) { sfx.best(); burst(50, 0.5, 0.45); }
      }
    }
  }

  function tickReveal() {
    if (!S || S.phase !== 'reveal' || !ui.rv) return;
    var items = S.reveal || [];
    if (!items.length) return;
    var stepMs = S.revealStepMs || 6000;
    var step, sub;
    if (S.deadline) {
      var start = S.deadline - (S.phaseMs > 0 ? S.phaseMs : items.length * stepMs + 1500);
      var t = Math.max(0, now() - start);
      step = Math.min(items.length - 1, Math.floor(t / stepMs));
      var inStep = t - step * stepMs;
      sub = inStep < stepMs * 0.27 ? 0 : inStep < stepMs * 0.56 ? 1 : 2;
    } else { step = items.length - 1; sub = 2; }
    var rv = ui.rv;
    // never go backwards (clock offset jitter)
    if (step < rv.step || (step === rv.step && sub <= rv.sub)) return;
    if (step !== rv.step) { buildRevealItem(step); rv.step = step; rv.sub = -1; }
    // on a jump (refresh) only play the latest sub-step's effects
    for (var k = rv.sub + 1; k <= sub; k++) {
      if (k === sub || k === 0) applyRevealSub(step, k);
    }
    rv.sub = sub;
  }

  // SCORES
  function playersSig() {
    return (S.players || []).map(function (p) { return p.id + ':' + p.score; }).join('|');
  }
  function sortBy(ps, key) {
    return ps.map(function (p, i) { return { p: p, i: i }; })
      .sort(function (a, b) { return (key(b.p) - key(a.p)) || (a.i - b.i); })
      .map(function (x) { return x.p; });
  }
  function countUp(node, from, to, ms) {
    var t0 = performance.now(), stop = false;
    cleanups.push(function () { stop = true; });
    (function step(t) {
      if (stop) return;
      var f = Math.min(1, (t - t0) / ms); f = 1 - Math.pow(1 - f, 3);
      node.textContent = fmt(Math.round((from + (to - from) * f) / 10) * 10);
      if (f < 1) requestAnimationFrame(step); else node.textContent = fmt(to);
    })(t0);
  }

  builders.scores = function () {
    var q = S.question;
    var head = el('div', 'shead');
    head.appendChild(el('h1', 'stitle', 'SCORES'));
    if (q) head.appendChild(el('span', 'ssub', q.number >= q.total ? 'final question done!' : 'after question ' + q.number + ' of ' + q.total));
    root.appendChild(head);

    var ps = S.players || [];
    var n = Math.max(ps.length, 1);
    var board = el('div', 'board n' + (n <= 5 ? 'S' : n <= 8 ? 'M' : 'L'));
    var rowH = Math.min(100 / n, 17);
    var old = function (p) { return (p.score || 0) - (p.delta || 0); };
    var maxScore = Math.max(1, Math.max.apply(null, ps.map(function (p) { return p.score || 0; }).concat([0])));
    var before = sortBy(ps, old), after = sortBy(ps, function (p) { return p.score || 0; });
    var rows = {};
    before.forEach(function (p, i) {
      var r = el('div', 'row' + (p.connected ? '' : ' off'));
      r.style.setProperty('--c', safeColor(p.color));
      r.style.setProperty('--i', i);
      r.style.height = rowH + '%';
      r.style.top = (i * rowH) + '%';
      var inner = el('div', 'row-in');
      var rank = el('span', 'rank', i + 1);
      var name = el('span', 'rname', p.name);
      var track = el('span', 'track');
      var fill = el('span', 'fill');
      fill.style.width = (old(p) / maxScore * 100) + '%';
      track.appendChild(fill);
      var score = el('span', 'rscore', fmt(old(p)));
      var delta = el('span', 'rdelta', p.delta > 0 ? '+' + fmt(p.delta) : '');
      inner.appendChild(rank); inner.appendChild(name); inner.appendChild(track);
      inner.appendChild(score); inner.appendChild(delta);
      r.appendChild(inner);
      board.appendChild(r);
      rows[p.id] = { r: r, rank: rank, fill: fill, score: score, delta: delta, p: p };
    });
    root.appendChild(board);
    var bar = el('div', 'pbar'); ui.pbar = el('i'); bar.appendChild(ui.pbar); root.appendChild(bar);
    ui.total = phaseTotal();
    ui.sig = playersSig();

    later(function () {
      after.forEach(function (p) {
        var o = rows[p.id];
        o.fill.style.width = ((p.score || 0) / maxScore * 100) + '%';
        if (p.delta > 0) { o.delta.classList.add('show'); countUp(o.score, old(p), p.score || 0, 1000); }
      });
      sfx.voters();
    }, 900);
    later(function () {
      after.forEach(function (p, i) {
        var o = rows[p.id];
        o.r.style.top = (i * rowH) + '%';
        o.rank.textContent = i + 1;
        if (i === 0 && (p.score || 0) > 0) o.r.classList.add('lead');
      });
      sfx.whoosh();
    }, 2300);
  };
  patchers.scores = function () { if (playersSig() !== ui.sig) build(); };

  // GAMEOVER
  builders.gameover = function () {
    var ps = sortBy(S.players || [], function (p) { return p.score || 0; });
    var top = ps.length ? (ps[0].score || 0) : 0;
    var winners = ps.filter(function (p) { return (p.score || 0) === top; });

    var left = el('div', 'go-left');
    var pig = el('div', 'go-pig');
    pig.appendChild(el('span', 'go-crown', '👑'));
    pig.appendChild(el('span', 'go-face', '🐷'));
    left.appendChild(pig);
    var title = !ps.length ? 'GAME OVER' : winners.length > 1 ? "IT'S A TIE!" : 'WINNER!';
    left.appendChild(el('div', 'go-title', title));
    var names = el('div', 'go-names' + (winners.length > 2 ? ' many' : winners.some(function (p) { return String(p.name).length > 8; }) ? ' long' : ''));
    winners.forEach(function (p, i) {
      if (i > 0) names.appendChild(el('span', 'go-amp', i === winners.length - 1 ? ' & ' : ', '));
      var s = el('span', 'go-name', p.name);
      s.style.color = safeColor(p.color);
      names.appendChild(s);
    });
    left.appendChild(names);
    if (ps.length) left.appendChild(el('div', 'go-score', fmt(top) + ' points' + (winners.length > 1 ? ' each' : '')));
    var again = el('button', 'btn', 'PLAY AGAIN');
    again.type = 'button';
    again.addEventListener('click', function () { send('game:restart'); });
    left.appendChild(again);
    root.appendChild(left);

    var right = el('div', 'go-right panel');
    right.appendChild(el('h2', 'go-h', 'FINAL RANKING'));
    var list = el('div', 'go-list n' + (ps.length <= 6 ? 'S' : ps.length <= 9 ? 'M' : 'L'));
    ps.forEach(function (p, i) {
      var rank = 1 + ps.filter(function (o) { return (o.score || 0) > (p.score || 0); }).length;
      var r = el('div', 'go-row' + (rank === 1 ? ' first' : '') + (p.connected ? '' : ' off'));
      r.style.setProperty('--c', safeColor(p.color));
      r.style.setProperty('--i', i);
      r.appendChild(el('span', 'rank', rank === 1 ? '🏆' : rank));
      r.appendChild(el('span', 'rname', p.name));
      r.appendChild(el('span', 'rscore', fmt(p.score)));
      list.appendChild(r);
    });
    right.appendChild(list);
    root.appendChild(right);

    ui.sig = playersSig();
    sfx.win();
    burst(220, 0.5, 0.4);
    rain(120);
    var iv = setInterval(function () { rain(35); }, 1200);
    cleanups.push(function () { clearInterval(iv); });
  };
  patchers.gameover = function () { if (playersSig() !== ui.sig) build(); };

  /* ───────────── render loop ───────────── */
  function build() {
    cleanups.forEach(function (f) { try { f(); } catch (e) {} });
    cleanups = [];
    ui = {};
    root.textContent = '';
    root.className = 'screen screen-' + S.phase;
    // restart the entry animation
    root.style.animation = 'none'; void root.offsetWidth; root.style.animation = '';
    (builders[S.phase] || function () {})();
    document.body.setAttribute('data-phase', S.phase);
    $('#c-skip').disabled = (S.phase === 'lobby' || S.phase === 'gameover');
  }

  function onState(s) {
    if (!s || !s.phase) return;
    S = s;
    if (typeof s.now === 'number') offset = s.now - Date.now();
    var key = s.phase + '|' + (s.question ? s.question.number + ':' + s.question.text : '');
    if (key !== screenKey) { screenKey = key; build(); }
    (patchers[s.phase] || function () {})();

    // join blip
    var ids = {};
    (s.players || []).forEach(function (p) { ids[p.id] = true; });
    if (knownIds) {
      for (var id in ids) if (!knownIds[id]) { sfx.join(); break; }
    }
    knownIds = ids;
    var mode = modeName();
    if (document.body.getAttribute('data-mode') !== mode) document.body.setAttribute('data-mode', mode);
    if (modeBadge && modeBadge.textContent !== MODES[mode].badge) modeBadge.textContent = MODES[mode].badge;
    musicSetMood(s.phase);
    tick();
  }

  function tick() {
    if (!S) return;
    var rem = S.deadline ? Math.max(0, S.deadline - now()) : 0;
    var frac = ui.total ? Math.max(0, Math.min(1, rem / ui.total)) : 0;
    mus.urgent = S.phase === 'writing' && !!S.deadline && rem <= 10000;
    if (ui.timer) {
      var sec = Math.ceil(rem / 1000);
      ui.timer.ring.style.strokeDashoffset = (RING_C * (1 - frac)).toFixed(2);
      if (sec !== ui.timer.sec) {
        var prev = ui.timer.sec;
        ui.timer.sec = sec;
        ui.timer.num.textContent = sec;
        ui.timer.box.classList.toggle('urgent', sec <= 5);
        if (prev !== null && sec <= 5 && sec > 0) {
          sfx.tick();
          ui.timer.num.classList.remove('bump'); void ui.timer.num.offsetWidth; ui.timer.num.classList.add('bump');
        }
      }
    }
    if (ui.pbar) ui.pbar.style.width = (frac * 100) + '%';
    if (S.phase === 'reveal') tickReveal();
  }
  setInterval(tick, 100);

  /* ───────────── controls strip ───────────── */
  var idleT = 0;
  var controls = $('#controls');
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(function idle() {
      if (controls.matches(':hover')) { idleT = setTimeout(idle, 2000); return; }
      document.body.classList.add('idle');
    }, 3000);
  }
  window.addEventListener('mousemove', wake);
  window.addEventListener('mousedown', wake);

  $('#c-skip').addEventListener('click', function () { send('game:skip'); });

  var restartBtn = $('#c-restart'), restartArmed = 0;
  restartBtn.addEventListener('click', function () {
    if (restartArmed) {
      clearTimeout(restartArmed); restartArmed = 0;
      restartBtn.textContent = 'Restart ↺'; restartBtn.classList.remove('armed');
      send('game:restart');
    } else {
      restartBtn.textContent = 'Sure? Click again'; restartBtn.classList.add('armed');
      restartArmed = setTimeout(function () {
        restartArmed = 0; restartBtn.textContent = 'Restart ↺'; restartBtn.classList.remove('armed');
      }, 3000);
    }
  });

  var fullBtn = $('#c-full');
  fullBtn.addEventListener('click', function () {
    try {
      var d = document, de = d.documentElement;
      if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else {
        var p = (de.requestFullscreen || de.webkitRequestFullscreen).call(de);
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {}
  });
  function fsLabel() {
    fullBtn.textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? 'Exit fullscreen ⛶' : 'Fullscreen ⛶';
  }
  document.addEventListener('fullscreenchange', fsLabel);
  document.addEventListener('webkitfullscreenchange', fsLabel);

  var muteBtn = $('#c-mute');
  function muteLabel() { muteBtn.textContent = muted ? 'Muted 🔇' : 'Sound 🔊'; muteBtn.classList.toggle('armed', muted); }
  muteBtn.addEventListener('click', function () {
    muted = !muted;
    try { localStorage.setItem('porkies_host_muted', muted ? '1' : '0'); } catch (e) {}
    muteLabel();
    unlockAudio();
    if (master && actx) { try { master.gain.setTargetAtTime(muted ? 0 : 1, actx.currentTime, 0.03); } catch (e) {} }
    musicRefresh();
    if (!muted) setTimeout(sfx.join, 60);
  });
  muteLabel();

  var musicBtn = $('#c-music');
  function musicLabel() { musicBtn.textContent = musicOn ? 'Music 🎵' : 'Music off'; musicBtn.classList.toggle('armed', !musicOn); }
  musicBtn.addEventListener('click', function () {
    musicOn = !musicOn;
    try { localStorage.setItem('porkies_host_music', musicOn ? '1' : '0'); } catch (e) {}
    musicLabel();
    unlockAudio();
    musicRefresh();
  });
  musicLabel();

  /* ───────────── socket ───────────── */
  var socket = null;
  function showOverlay(msg) { overlayText.textContent = msg; overlay.classList.remove('hidden'); }
  function hideOverlay() { overlay.classList.add('hidden'); }

  if (typeof window.io !== 'function') {
    showOverlay('Can’t reach the game server — retrying…');
    setTimeout(function () { location.reload(); }, 4000);
    return;
  }
  socket = window.io();
  var everConnected = false;
  socket.on('connect', function () {
    everConnected = true;
    socket.emit('host:join', {}, function () {});
    hideOverlay();
  });
  socket.on('disconnect', function () { showOverlay('Reconnecting…'); });
  socket.on('connect_error', function () { showOverlay(everConnected ? 'Reconnecting…' : 'Connecting…'); });
  socket.on('state', onState);
})();
