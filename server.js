'use strict';
/*
 * PORKIES - server. Authoritative game state; clients render purely from `state`.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

// ---------------------------------------------------------------- config
const FAST = process.env.FAST === '1' || process.env.FAST === 'true';
const DIV = FAST ? 10 : 1;
const REVEAL_EXTRA_MS = 1500 / DIV;

// Game modes. Classic is the default; the chosen mode persists until changed.
const MODES = {
  classic: {
    questions: 7,
    multipliers: [1, 1, 1, 2, 2, 2, 3],
    writingMs: 60000 / DIV,
    votingMs: 30000 / DIV,
    revealStepMs: 6000 / DIV,
    scoresMs: 8000 / DIV,
    likes: false,
  },
  quickfire: {
    questions: 12,
    multipliers: [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3],
    writingMs: 25000 / DIV,
    votingMs: 15000 / DIV,
    revealStepMs: 3500 / DIV,
    scoresMs: 5000 / DIV,
    likes: true, // "best porkie" hearts during voting
  },
};
const DEFAULT_MODE = 'classic';
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;
const MAX_NAME = 12;
const MAX_LIE = 40;
const TRUTH_POINTS = 1000;
const FOOL_POINTS = 500;
const BEST_PORKIE_POINTS = 250;
const FALLBACK_PORT = 3000;
const JOIN_HOST = process.env.JOIN_HOST || 'cyrus.game';
const PALETTE = ['#ff4f9a', '#ffd23f', '#3ddc97', '#4fc3ff', '#ff8a3d', '#b28dff',
  '#ff5964', '#7ee081', '#f78fb3', '#63e6e2', '#e6c229', '#c084fc'];

const PUBLIC_DIR = path.join(__dirname, 'public');
const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(__dirname, 'questions.json');

// ---------------------------------------------------------------- questions
const FALLBACK_QUESTIONS = [
  { id: 1, category: 'Animals', text: 'A group of flamingos is called a _____.', answer: 'flamboyance', alternates: ['a flamboyance'], decoys: ['blush', 'stilt', 'parade', 'rosette'] },
  { id: 2, category: 'Animals', text: 'Wombats are famous for producing poo shaped like _____.', answer: 'cubes', alternates: ['cube', 'squares', 'dice'], decoys: ['pyramids', 'rings', 'spirals', 'stars'] },
  { id: 3, category: 'Food', text: 'Before it was a sauce for chips, ketchup was sold in the 1830s as _____.', answer: 'medicine', alternates: ['a medicine', 'medication'], decoys: ['boot polish', 'hair tonic', 'fish bait', 'paint'] },
  { id: 4, category: 'History', text: 'In 1932 the Australian army lost a "war" against a mob of _____.', answer: 'emus', alternates: ['emu'], decoys: ['kangaroos', 'rabbits', 'sheep', 'cane toads'] },
  { id: 5, category: 'Science', text: 'Bananas are very slightly _____ because of the potassium in them.', answer: 'radioactive', alternates: [], decoys: ['magnetic', 'explosive', 'alcoholic', 'fluorescent'] },
  { id: 6, category: 'Geography', text: 'The national animal of Scotland is the _____.', answer: 'unicorn', alternates: ['a unicorn'], decoys: ['red stag', 'golden eagle', 'haggis', 'wildcat'] },
  { id: 7, category: 'Animals', text: 'Sea otters hold _____ while they sleep so they do not drift apart.', answer: 'hands', alternates: ['paws', 'each others hands'], decoys: ['kelp', 'their breath', 'rocks', 'tails'] },
  { id: 8, category: 'Words', text: 'The dot over a lowercase "i" or "j" is called a _____.', answer: 'tittle', alternates: ['a tittle'], decoys: ['jot', 'pip', 'nib', 'speck'] },
];

function sanitiseQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((q, i) => {
    if (!q || typeof q !== 'object') return;
    if (typeof q.text !== 'string' || !q.text.includes('_____')) return;
    if (typeof q.answer !== 'string' && typeof q.answer !== 'number') return;
    const answer = String(q.answer).trim();
    if (!answer) return;
    const strList = (a) => (Array.isArray(a) ? a : [])
      .filter((s) => typeof s === 'string' || typeof s === 'number')
      .map((s) => String(s).trim()).filter(Boolean);
    out.push({
      id: q.id != null ? q.id : i + 1,
      category: typeof q.category === 'string' && q.category.trim() ? q.category.trim() : 'General',
      text: q.text,
      answer,
      alternates: strList(q.alternates),
      decoys: strList(q.decoys),
    });
  });
  return out;
}

function loadQuestions() {
  try {
    const raw = fs.readFileSync(QUESTIONS_FILE, 'utf8').replace(/^﻿/, '');
    const list = sanitiseQuestions(JSON.parse(raw));
    if (list.length > 0) return { list, source: path.basename(QUESTIONS_FILE) };
    console.warn('[porkies] questions file has no usable questions - using built-in fallback list');
  } catch (e) {
    console.warn('[porkies] could not load questions file (' + e.message + ') - using built-in fallback list');
  }
  return { list: sanitiseQuestions(FALLBACK_QUESTIONS), source: 'built-in fallback' };
}

const loadedQuestions = loadQuestions();
const QUESTIONS = loadedQuestions.list;
let unusedQuestions = []; // indices into QUESTIONS not yet used since last exhaustion

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function drawQuestions(n) {
  const picked = [];
  const pickedSet = new Set();
  let guard = 0;
  while (picked.length < n && guard++ < 10000) {
    if (unusedQuestions.length === 0) {
      // bank exhausted: refill, avoiding repeats inside this game where possible
      let refill = QUESTIONS.map((_, i) => i).filter((i) => !pickedSet.has(i));
      if (refill.length === 0) { refill = QUESTIONS.map((_, i) => i); pickedSet.clear(); }
      unusedQuestions = shuffle(refill);
    }
    const idx = unusedQuestions.pop();
    if (pickedSet.has(idx)) continue;
    pickedSet.add(idx);
    picked.push(QUESTIONS[idx]);
  }
  return picked;
}

// ---------------------------------------------------------------- text helpers
function cleanText(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  let s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}
function displayText(v) {
  return cleanText(v, MAX_LIE).toUpperCase();
}
// comparison key: uppercase, strip punctuation, strip leading A/AN/THE
function normKey(v) {
  let s = String(v == null ? '' : v).toUpperCase();
  try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* ignore */ }
  s = s.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const stripped = s.replace(/^(?:(?:A|AN|THE)\s+)+/, '').trim();
  return stripped || s;
}

// ---------------------------------------------------------------- network helpers
function lanAddress() {
  const virtual = /(vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier|vpn|tunnel|tap|tun\d|bluetooth|npcap|pseudo)/i;
  let best = null;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      const fam = a.family === 'IPv4' || a.family === 4;
      if (!fam || a.internal) continue;
      const ip = a.address;
      if (ip.startsWith('169.254.')) continue;
      let score = 1;
      if (ip.startsWith('192.168.')) score = 40;
      else if (ip.startsWith('10.')) score = 30;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score = 20;
      if (virtual.test(name)) score -= 15;
      if (!best || score > best.score) best = { ip, score };
    }
  }
  return best ? best.ip : null;
}
let actualPort = null;
function portSuffix() {
  return actualPort && actualPort !== 80 ? ':' + actualPort : '';
}
function lanUrl() {
  return 'http://' + (lanAddress() || 'localhost') + portSuffix() + '/';
}
function joinHostText() {
  return JOIN_HOST + portSuffix();
}

// ---------------------------------------------------------------- http
const app = express();
app.disable('x-powered-by');
app.get('/', (req, res) => sendPublic(res, 'index.html'));
app.get('/host', (req, res) => sendPublic(res, 'host.html'));
app.get('/qr.svg', async (req, res) => {
  try {
    const svg = await QRCode.toString(lanUrl(), {
      type: 'svg',
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#1b1030', light: '#ffffff' },
    });
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'no-store');
    res.send(svg);
  } catch (e) {
    res.status(500).type('text/plain').send('qr error');
  }
});
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (!res.headersSent) res.status(err && err.status ? err.status : 500).type('text/plain').send('Error');
});

function sendPublic(res, file) {
  res.sendFile(path.join(PUBLIC_DIR, file), (err) => {
    if (err && !res.headersSent) {
      res.status(404).type('text/plain').send(file + ' is not there yet (public/' + file + ' missing).');
    }
  });
}

const server = http.createServer(app);
const io = new Server(server, { serveClient: true, pingInterval: 10000, pingTimeout: 8000 });

// ---------------------------------------------------------------- game state
const game = {
  phase: 'lobby',
  mode: DEFAULT_MODE,
  deadline: null,
  phaseMs: null,     // full duration of the current phase
  timer: null,
  players: [],       // { id, token, name, score, delta, color, socketId, lie, vote, like }
  nextPlayerNum: 1,
  vipId: null,
  queue: [],         // questions for this game
  qIndex: -1,
  question: null,    // current question object
  options: null,     // [{ id, text, isTruth, authorIds: [] }]
  reveal: null,      // built at start of reveal
};

function findPlayer(id) { return game.players.find((p) => p.id === id) || null; }
function isConnected(p) { return !!p.socketId && io.sockets.sockets.has(p.socketId); }
function connectedPlayers() { return game.players.filter(isConnected); }
function socketPlayer(socket) {
  const id = socket.data && socket.data.playerId;
  if (!id) return null;
  const p = findPlayer(id);
  return p && p.socketId === socket.id ? p : null;
}
function isHost(socket) { return !!(socket.data && socket.data.isHost); }
function canControl(socket) {
  if (isHost(socket)) return true;
  const p = socketPlayer(socket);
  return !!p && p.id === game.vipId;
}
function ensureVip() {
  if (game.vipId && findPlayer(game.vipId)) return;
  game.vipId = game.players.length ? game.players[0].id : null;
}

function clearTimer() {
  if (game.timer) { clearTimeout(game.timer); game.timer = null; }
}
function setPhaseTimer(ms, fn) {
  clearTimer();
  game.deadline = Date.now() + ms;
  game.phaseMs = ms;
  game.timer = setTimeout(() => {
    game.timer = null;
    try { fn(); } catch (e) { console.error('[porkies] phase timer error', e); }
  }, ms);
}

// ---------------------------------------------------------------- snapshots
function snapshotFor(socket) {
  const me = socketPlayer(socket);
  const phase = game.phase;
  const showDelta = phase === 'reveal' || phase === 'scores' || phase === 'gameover';
  const inRound = phase === 'writing' || phase === 'voting' || phase === 'reveal' || phase === 'scores';
  const q = game.question;
  const timed = phase !== 'lobby' && phase !== 'gameover';
  return {
    phase,
    mode: game.mode,
    now: Date.now(),
    deadline: timed ? game.deadline : null,
    phaseMs: timed ? game.phaseMs : null,
    joinHost: joinHostText(),
    lanUrl: lanUrl(),
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      delta: showDelta ? p.delta : 0,
      connected: isConnected(p),
      isVip: p.id === game.vipId,
      color: p.color,
      done: phase === 'writing' ? p.lie != null : phase === 'voting' ? p.vote != null : false,
    })),
    question: inRound && q ? {
      number: game.qIndex + 1,
      total: game.queue.length,
      multiplier: currentMultiplier(),
      category: q.category,
      text: q.text,
    } : null,
    options: phase === 'voting' && game.options ? game.options.map((o) => ({
      id: o.id,
      text: o.text,
      mine: !!me && o.authorIds.includes(me.id),
    })) : null,
    reveal: (phase === 'reveal' || phase === 'scores') && game.reveal ? game.reveal : null,
    revealStepMs: modeCfg().revealStepMs,
    you: me ? {
      id: me.id,
      name: me.name,
      isVip: me.id === game.vipId,
      lie: inRound ? me.lie : null,
      vote: inRound && phase !== 'writing' ? me.vote : null,
      like: inRound && phase !== 'writing' ? me.like : null,
    } : null,
  };
}
function sendState(socket) {
  try { socket.emit('state', snapshotFor(socket)); } catch (e) { console.error('[porkies] sendState error', e); }
}
function broadcast() {
  for (const socket of io.sockets.sockets.values()) sendState(socket);
}

// ---------------------------------------------------------------- phases
function modeCfg() { return MODES[game.mode] || MODES[DEFAULT_MODE]; }
function currentMultiplier() {
  const mults = modeCfg().multipliers;
  return mults[Math.min(Math.max(game.qIndex, 0), mults.length - 1)];
}

function toLobby() {
  clearTimer();
  game.phase = 'lobby';
  game.deadline = null;
  game.phaseMs = null;
  game.queue = [];
  game.qIndex = -1;
  game.question = null;
  game.options = null;
  game.reveal = null;
  for (const p of game.players) { p.score = 0; p.delta = 0; p.lie = null; p.vote = null; p.like = null; }
  broadcast();
}

function startGame() {
  for (const p of game.players) { p.score = 0; p.delta = 0; p.lie = null; p.vote = null; p.like = null; }
  game.queue = drawQuestions(modeCfg().questions);
  game.qIndex = -1;
  nextQuestion();
}

function nextQuestion() {
  game.qIndex += 1;
  if (game.qIndex >= game.queue.length) return toGameover();
  game.question = game.queue[game.qIndex];
  game.options = null;
  game.reveal = null;
  for (const p of game.players) { p.delta = 0; p.lie = null; p.vote = null; p.like = null; }
  game.phase = 'writing';
  setPhaseTimer(modeCfg().writingMs, startVoting);
  broadcast();
}

function startVoting() {
  const q = game.question;
  const truthText = displayText(q.answer);
  const truthKeys = new Set([q.answer].concat(q.alternates).map(normKey));
  const options = [{ text: truthText, isTruth: true, authorIds: [] }];
  const byText = new Map();
  for (const p of game.players) {
    if (p.lie == null) continue;
    let o = byText.get(p.lie);
    if (!o) {
      o = { text: p.lie, isTruth: false, authorIds: [] };
      byText.set(p.lie, o);
      options.push(o);
    }
    o.authorIds.push(p.id);
  }
  // pad with decoys: one option per player plus the truth, never fewer than 4
  const target = Math.max(4, game.players.length + 1);
  const usedKeys = new Set(options.map((o) => normKey(o.text)));
  for (const k of truthKeys) usedKeys.add(k);
  for (const d of shuffle(q.decoys.slice())) {
    if (options.length >= target) break;
    const text = displayText(d);
    const key = normKey(text);
    if (!text || usedKeys.has(key)) continue;
    usedKeys.add(key);
    options.push({ text, isTruth: false, authorIds: [] });
  }
  shuffle(options);
  options.forEach((o, i) => { o.id = 'o' + (i + 1); });
  game.options = options;
  for (const p of game.players) { p.vote = null; p.like = null; }
  game.phase = 'voting';
  setPhaseTimer(modeCfg().votingMs, startReveal);
  broadcast();
}

function startReveal() {
  const mult = currentMultiplier();
  const ref = (id) => { const p = findPlayer(id); return p ? { id: p.id, name: p.name } : null; };
  for (const p of game.players) p.delta = 0;
  const lies = [];
  let truthItem = null;
  // "best porkie": the player-written lie(s) with the most hearts (min 1, ties all win)
  const likesOn = !!modeCfg().likes;
  const likeCount = (o) => (likesOn ? game.players.filter((p) => p.like === o.id).length : 0);
  let bestLikes = 0;
  for (const o of game.options || []) {
    if (o.isTruth || !o.authorIds.some(findPlayer)) continue;
    bestLikes = Math.max(bestLikes, likeCount(o));
  }
  for (const o of game.options || []) {
    const voters = game.players.filter((p) => p.vote === o.id);
    const authors = o.authorIds.map(findPlayer).filter(Boolean);
    const likes = likeCount(o);
    const bestPorkie = !o.isTruth && authors.length > 0 && bestLikes > 0 && likes === bestLikes;
    const bonus = bestPorkie ? BEST_PORKIE_POINTS * mult : 0;
    if (bonus) for (const a of authors) a.delta += bonus;
    let points;
    if (o.isTruth) {
      points = TRUTH_POINTS * mult;
      for (const v of voters) v.delta += points;
    } else {
      points = authors.length ? FOOL_POINTS * mult * voters.length : 0;
      for (const a of authors) a.delta += points;
    }
    const item = {
      id: o.id,
      text: o.text,
      isTruth: !!o.isTruth,
      authors: authors.map((a) => ref(a.id)),
      voters: voters.map((v) => ref(v.id)),
      points,
      likes,
      bestPorkie,
      bonus,
    };
    if (o.isTruth) truthItem = item;
    else if (voters.length > 0 || bestPorkie) lies.push(item); // a best porkie is shown even if nobody fell for it
  }
  lies.sort((a, b) => a.voters.length - b.voters.length); // stable: ties keep option order
  if (truthItem) lies.push(truthItem);
  game.reveal = lies;
  for (const p of game.players) p.score += p.delta;
  game.phase = 'reveal';
  setPhaseTimer(game.reveal.length * modeCfg().revealStepMs + REVEAL_EXTRA_MS, startScores);
  broadcast();
}

function startScores() {
  game.phase = 'scores';
  setPhaseTimer(modeCfg().scoresMs, nextQuestion);
  broadcast();
}

function toGameover() {
  clearTimer();
  game.phase = 'gameover';
  game.deadline = null;
  game.phaseMs = null;
  game.question = null;
  game.options = null;
  game.reveal = null;
  broadcast();
}

function skipPhase() {
  switch (game.phase) {
    case 'writing': startVoting(); return true;
    case 'voting': startReveal(); return true;
    case 'reveal': startScores(); return true;
    case 'scores': nextQuestion(); return true;
    default: return false;
  }
}

// end writing/voting early once every connected player is done. Returns true if phase advanced.
function checkEarlyEnd() {
  const conn = connectedPlayers();
  if (conn.length === 0) return false;
  if (game.phase === 'writing' && conn.every((p) => p.lie != null)) { startVoting(); return true; }
  if (game.phase === 'voting' && conn.every((p) => p.vote != null)) { startReveal(); return true; }
  return false;
}

// ---------------------------------------------------------------- sockets
function detachSocketFromPlayer(socket) {
  const p = socketPlayer(socket);
  if (p) p.socketId = null;
  if (socket.data) socket.data.playerId = null;
}

function nextColor() {
  const used = new Set(game.players.map((p) => p.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[game.players.length % PALETTE.length];
}

const handlers = {
  'host:join'(socket) {
    detachSocketFromPlayer(socket);
    socket.data.isHost = true;
    if (!checkEarlyEnd()) broadcast();
    return { ok: true };
  },

  'player:join'(socket, data) {
    const token = cleanText(data.token, 200);
    const name = cleanText(data.name, MAX_NAME);

    // reconnect by token
    const existing = token ? game.players.find((p) => p.token === token) : null;
    if (existing) {
      const current = socketPlayer(socket);
      if (current && current !== existing) current.socketId = null;
      if (existing.socketId && existing.socketId !== socket.id) {
        const old = io.sockets.sockets.get(existing.socketId);
        if (old && old.data) old.data.playerId = null; // old tab becomes a spectator
      }
      existing.socketId = socket.id;
      socket.data.playerId = existing.id;
      socket.data.isHost = false;
      if (!checkEarlyEnd()) broadcast();
      return { ok: true, id: existing.id };
    }

    if (!name) return { ok: false, error: 'name_required' };
    if (game.players.length >= MAX_PLAYERS) return { ok: false, error: 'full' };
    const lower = name.toLowerCase();
    if (game.players.some((p) => p.name.toLowerCase() === lower)) return { ok: false, error: 'name_taken' };

    detachSocketFromPlayer(socket);
    const player = {
      id: 'p' + game.nextPlayerNum++,
      token: token || crypto.randomBytes(12).toString('hex'),
      name,
      score: 0,
      delta: 0,
      color: nextColor(),
      socketId: socket.id,
      lie: null,
      vote: null,
      like: null,
    };
    game.players.push(player);
    socket.data.playerId = player.id;
    socket.data.isHost = false;
    ensureVip();
    broadcast();
    return { ok: true, id: player.id };
  },

  'player:lie'(socket, data) {
    const p = socketPlayer(socket);
    if (!p) return { ok: false, error: 'not_joined' };
    if (game.phase !== 'writing') return { ok: false, error: 'wrong_phase' };
    if (p.lie != null) return { ok: false, error: 'already' };
    const text = displayText(data.text);
    if (!text) return { ok: false, error: 'empty' };
    const key = normKey(text);
    const q = game.question;
    if ([q.answer].concat(q.alternates).some((a) => normKey(a) === key)) return { ok: false, error: 'truth' };
    p.lie = text;
    if (!checkEarlyEnd()) broadcast();
    return { ok: true };
  },

  'player:vote'(socket, data) {
    const p = socketPlayer(socket);
    if (!p) return { ok: false, error: 'not_joined' };
    if (game.phase !== 'voting') return { ok: false, error: 'wrong_phase' };
    if (p.vote != null) return { ok: false, error: 'already' };
    const o = typeof data.optionId === 'string' ? (game.options || []).find((x) => x.id === data.optionId) : null;
    if (!o) return { ok: false, error: 'invalid' };
    if (o.authorIds.includes(p.id)) return { ok: false, error: 'own' };
    p.vote = o.id;
    if (!checkEarlyEnd()) broadcast();
    return { ok: true };
  },

  // Quickfire only: one optional heart for the best porkie (not your own); final once given.
  'player:like'(socket, data) {
    const p = socketPlayer(socket);
    if (!p) return { ok: false, error: 'not_joined' };
    if (game.phase !== 'voting' || !modeCfg().likes) return { ok: false, error: 'wrong_phase' };
    if (p.like != null) return { ok: false, error: 'already' };
    const o = typeof data.optionId === 'string' ? (game.options || []).find((x) => x.id === data.optionId) : null;
    if (!o) return { ok: false, error: 'invalid' };
    if (o.authorIds.includes(p.id)) return { ok: false, error: 'own' };
    p.like = o.id;
    broadcast(); // likes never end the phase early
    return { ok: true };
  },

  'game:mode'(socket, data) {
    if (!canControl(socket)) return { ok: false, error: 'not_allowed' };
    if (game.phase !== 'lobby' && game.phase !== 'gameover') return { ok: false, error: 'wrong_phase' };
    if (typeof data.mode !== 'string' || !Object.prototype.hasOwnProperty.call(MODES, data.mode)) return { ok: false, error: 'invalid' };
    if (game.mode !== data.mode) { game.mode = data.mode; broadcast(); }
    return { ok: true };
  },

  'game:start'(socket) {
    if (!canControl(socket)) return { ok: false, error: 'not_allowed' };
    if (game.phase !== 'lobby' && game.phase !== 'gameover') return { ok: false, error: 'wrong_phase' };
    if (connectedPlayers().length < MIN_PLAYERS) return { ok: false, error: 'need_players' };
    startGame();
    return { ok: true };
  },

  'game:skip'(socket) {
    if (!canControl(socket)) return { ok: false, error: 'not_allowed' };
    if (!skipPhase()) return { ok: false, error: 'wrong_phase' };
    return { ok: true };
  },

  'game:restart'(socket) {
    if (!canControl(socket)) return { ok: false, error: 'not_allowed' };
    toLobby();
    return { ok: true };
  },

  'host:kick'(socket, data) {
    if (!isHost(socket)) return { ok: false, error: 'not_allowed' };
    const idx = game.players.findIndex((p) => p.id === data.playerId);
    if (idx < 0) return { ok: false, error: 'invalid' };
    const [p] = game.players.splice(idx, 1);
    const s = p.socketId ? io.sockets.sockets.get(p.socketId) : null;
    if (s && s.data) s.data.playerId = null;
    if (game.vipId === p.id) game.vipId = null;
    ensureVip();
    // forget their part in the current round
    if (game.options && (game.phase === 'writing' || game.phase === 'voting')) {
      for (const o of game.options) o.authorIds = o.authorIds.filter((id) => id !== p.id);
    }
    if (s) { try { s.emit('kicked'); } catch (e) { /* ignore */ } }
    if (!checkEarlyEnd()) broadcast();
    return { ok: true };
  },
};

io.on('connection', (socket) => {
  socket.data.isHost = false;
  socket.data.playerId = null;

  for (const event of Object.keys(handlers)) {
    socket.on(event, (...args) => {
      let ack = null;
      for (let i = args.length - 1; i >= 0; i--) {
        if (typeof args[i] === 'function') { ack = args[i]; break; }
      }
      const first = args[0];
      const data = first && typeof first === 'object' && !Array.isArray(first) ? first : {};
      let res;
      try {
        res = handlers[event](socket, data) || { ok: true };
      } catch (e) {
        console.error('[porkies] error handling ' + event, e);
        res = { ok: false, error: 'server_error' };
      }
      if (ack) { try { ack(res); } catch (e) { /* ignore */ } }
    });
  }

  socket.on('error', () => { /* swallow */ });

  socket.on('disconnect', () => {
    try {
      const p = socket.data && socket.data.playerId ? findPlayer(socket.data.playerId) : null;
      if (p && p.socketId === socket.id) p.socketId = null;
      if (!checkEarlyEnd()) broadcast();
    } catch (e) {
      console.error('[porkies] disconnect error', e);
    }
  });

  sendState(socket);
});

// ---------------------------------------------------------------- listen (with port fallback)
function banner() {
  const local = 'http://localhost' + portSuffix();
  const lines = [
    '',
    '  ==================================================',
    '    PORKIES  -  tell a whopper, spot the truth',
    '  ==================================================',
    '    Host screen (open on the TV):  ' + local + '/host',
    '    Players (phones, same Wi-Fi):  ' + lanUrl(),
    '                              or:  http://' + joinHostText() + '/',
    '    Questions loaded: ' + QUESTIONS.length + ' (' + loadedQuestions.source + ')' + (FAST ? '   [FAST mode]' : ''),
    '  ==================================================',
    '',
  ];
  console.log(lines.join('\n'));
}

function listen(port, allowFallback) {
  const onError = (err) => {
    server.removeListener('listening', onListening);
    if (allowFallback && err && (err.code === 'EADDRINUSE' || err.code === 'EACCES') && port !== FALLBACK_PORT) {
      console.warn('[porkies] port ' + port + ' unavailable (' + err.code + ') - falling back to ' + FALLBACK_PORT);
      listen(FALLBACK_PORT, false);
    } else {
      console.error('[porkies] could not start server on port ' + port + ': ' + (err && err.message));
      process.exit(1);
    }
  };
  const onListening = () => {
    server.removeListener('error', onError);
    server.on('error', (e) => console.error('[porkies] server error', e));
    actualPort = server.address().port;
    banner();
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '0.0.0.0');
}

const wantedPort = parseInt(process.env.PORT, 10);
listen(Number.isInteger(wantedPort) && wantedPort > 0 && wantedPort < 65536 ? wantedPort : 80, true);

process.on('uncaughtException', (e) => console.error('[porkies] uncaught exception', e));
process.on('unhandledRejection', (e) => console.error('[porkies] unhandled rejection', e));
function shutdown() { try { io.close(); server.close(); } catch (e) { /* ignore */ } process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
