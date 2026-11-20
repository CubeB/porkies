/* Porkies — player (phone controller) client. Renders purely from the server `state` event. */
(function () {
  'use strict';

  // ---------- tiny helpers ----------
  function $(id) { return document.getElementById(id); }

  function show(el, on) {
    var hide = !on;
    if (el.hidden !== hide) el.hidden = hide;
  }

  function setText(el, text) {
    text = text == null ? '' : String(text);
    if (el.textContent !== text) el.textContent = text;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text); // textContent only: user text is never parsed as HTML
    return e;
  }

  function fmt(n) {
    n = Number(n) || 0;
    try { return n.toLocaleString('en-GB'); } catch (e) { return String(n); }
  }

  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function safeColor(c) {
    return /^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#ff4f9a';
  }

  // localStorage can throw (private mode / blocked); fall back to memory.
  var mem = {};
  var store = {
    get: function (k) {
      try { var v = window.localStorage.getItem(k); return v == null ? (mem[k] || '') : v; }
      catch (e) { return mem[k] || ''; }
    },
    set: function (k, v) {
      mem[k] = v;
      try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ }
    }
  };

  var TOKEN_KEY = 'porkies_token';
  var NAME_KEY = 'porkies_name';

  function makeToken() {
    var out = '';
    try {
      // crypto.randomUUID needs a secure context (we're on plain http over LAN); getRandomValues doesn't.
      var a = new Uint8Array(16);
      window.crypto.getRandomValues(a);
      for (var i = 0; i < a.length; i++) out += (a[i] + 256).toString(16).slice(1);
    } catch (e) {
      while (out.length < 32) out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
  }

  var token = store.get(TOKEN_KEY);
  if (!token) { token = makeToken(); store.set(TOKEN_KEY, token); }

  // ---------- elements ----------
  var ui = {
    banner: $('banner'), topbar: $('topbar'), topName: $('top-name'), topScore: $('top-score'),
    footer: $('footer'), skipBtn: $('skip-btn'),
    joinForm: $('join-form'), nameInput: $('name-input'), joinErr: $('join-error'), joinBtn: $('join-btn'),
    lobbyName: $('lobby-name'), lobbyCount: $('lobby-count'), lobbyPlayers: $('lobby-players'),
    lobbyVip: $('lobby-vip'), startBtn: $('start-btn'), startHint: $('start-hint'), lobbyWait: $('lobby-wait'),
    lieForm: $('lie-form'), lieInput: $('lie-input'), lieErr: $('lie-error'), lieBtn: $('lie-btn'),
    lieDone: $('lie-done'), lieMine: $('lie-mine'),
    writingPendingWrap: $('writing-pending-wrap'), writingPending: $('writing-pending'),
    votePrompt: $('vote-prompt'), voteErr: $('vote-error'), voteOptions: $('vote-options'),
    modeTitle: $('mode-title'), modeSwitch: $('mode-switch'), modeDesc: $('mode-desc'),
    votingPendingWrap: $('voting-pending-wrap'), votingPending: $('voting-pending'),
    scoreDelta: $('score-delta'), scoreNotes: $('score-notes'), scoreTotal: $('score-total'),
    scoreRank: $('score-rank'), scoreBoard: $('score-board'),
    finalPlace: $('final-place'), finalScore: $('final-score'), finalWinner: $('final-winner'),
    finalBoard: $('final-board'), againBtn: $('again-btn'), againWait: $('again-wait')
  };
  var screens = {};
  ['join', 'lobby', 'writing', 'voting', 'reveal', 'scores', 'gameover'].forEach(function (n) {
    screens[n] = $('s-' + n);
  });

  // ---------- client state ----------
  var state = null;        // last server snapshot
  var clockOffset = 0;     // serverNow - Date.now()
  var connected = false;
  var everConnected = false;
  var joining = false;     // a player:join is in flight
  var wasJoined = false;   // had a `you` in the previous snapshot
  var currentScreen = '';
  var roundKey = '';       // resets per-question UI (typed lie, errors, pending vote)
  var lieSending = false;
  var voteSending = false;
  var pendingVote = null;  // optimistic highlight while the ack is in flight
  var likeSending = false;
  var pendingLike = null;  // same, for the Quickfire heart
  var optionsSig = '';
  var listSigs = {};
  var busy = {};           // per-button in-flight flags for start/skip/restart
  var startError = '';
  var skipArmedTimer = null;

  var MODES = {
    classic: '7 questions · 60s to write, 30s to vote',
    quickfire: '12 questions · 25s to write, 15s to vote · ❤ best-porkie bonus'
  };
  function modeName() { return state && MODES[state.mode] ? state.mode : 'classic'; }

  ui.nameInput.value = store.get(NAME_KEY);

  function setError(node, msg) {
    setText(node, msg || '');
    show(node, !!msg);
  }

  // ---------- socket ----------
  if (typeof window.io !== 'function') {
    setError(ui.joinErr, "Couldn't load the game. Check you're on the same Wi-Fi as the host, then refresh.");
    ui.joinBtn.disabled = true;
    return;
  }

  var socket = window.io();

  // Emit with an ack; never queue while offline (avoids stale sends after a reconnect).
  function send(event, payload, cb) {
    if (!socket.connected) { if (cb) cb({ ok: false, error: 'offline' }); return; }
    var finished = false;
    var timer = setTimeout(function () {
      if (finished) return;
      finished = true;
      if (cb) cb({ ok: false, error: 'timeout' });
    }, 8000);
    socket.emit(event, payload || {}, function (res) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (cb) cb(res && typeof res === 'object' ? res : { ok: false, error: 'unknown' });
    });
  }

  var JOIN_ERRORS = {
    name_required: 'Pop your name in first!',
    name_taken: "Someone's already using that name. Try another one.",
    full: 'Sorry, the game is full (12 players max).',
    offline: 'Not connected yet. Hang on a second and try again.',
    timeout: 'No answer from the game. Try again.'
  };

  function join(name, isAuto) {
    if (joining) return;
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 12);
    if (!name) {
      if (!isAuto) setError(ui.joinErr, JOIN_ERRORS.name_required);
      return;
    }
    joining = true;
    setError(ui.joinErr, '');
    renderJoin();
    send('player:join', { name: name, token: token }, function (res) {
      joining = false;
      if (res.ok) {
        store.set(NAME_KEY, name);
        setError(ui.joinErr, '');
        if (document.activeElement === ui.nameInput) ui.nameInput.blur();
      } else {
        setError(ui.joinErr, JOIN_ERRORS[res.error] || "Couldn't join. Try again.");
      }
      render();
    });
  }

  socket.on('connect', function () {
    connected = true;
    everConnected = true;
    joining = false;
    lieSending = false;
    voteSending = false;
    likeSending = false;
    busy = {};
    render();
    // Auto-(re)join: resumes the same player via the stored token.
    var name = store.get(NAME_KEY);
    if (name) join(name, true);
  });

  socket.on('disconnect', function () {
    connected = false;
    joining = false;
    render();
  });

  socket.on('connect_error', function () {
    connected = false;
    render();
  });

  socket.on('state', function (s) {
    if (!s || typeof s !== 'object') return;
    state = s;
    if (typeof s.now === 'number') clockOffset = s.now - Date.now();
    render();
  });

  // ---------- derived data ----------
  function players() { return state && Array.isArray(state.players) ? state.players : []; }

  function me() {
    if (!state || !state.you) return null;
    var list = players();
    for (var i = 0; i < list.length; i++) if (list[i].id === state.you.id) return list[i];
    return null;
  }

  function vip() {
    var list = players();
    for (var i = 0; i < list.length; i++) if (list[i].isVip) return list[i];
    return null;
  }

  function amVip() {
    if (!state || !state.you) return false;
    var m = me();
    return !!(state.you.isVip || (m && m.isVip));
  }

  // Standard competition ranking: ties share a place.
  function rankOf(p) {
    var list = players(), r = 1;
    for (var i = 0; i < list.length; i++) if ((list[i].score || 0) > (p.score || 0)) r++;
    return r;
  }

  function sortedByScore() {
    return players().slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  }

  function hasId(arr, id) {
    if (!Array.isArray(arr)) return false;
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return true;
    return false;
  }

  function names(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(arr[i].name);
    if (out.length <= 1) return out.join('');
    return out.slice(0, -1).join(', ') + ' & ' + out[out.length - 1];
  }

  // ---------- list rendering (rebuilt only when their content changes) ----------
  function renderList(key, node, sig, build) {
    if (listSigs[key] === sig) return;
    listSigs[key] = sig;
    while (node.firstChild) node.removeChild(node.firstChild);
    build(node);
  }

  function playerRow(p, opts) {
    var li = el('li');
    if (state.you && p.id === state.you.id) li.classList.add('me');
    if (!p.connected) li.classList.add('off');
    if (opts.rank) li.appendChild(el('span', 'pos', ordinal(rankOf(p))));
    var dot = el('span', 'dot');
    dot.style.background = safeColor(p.color);
    li.appendChild(dot);
    li.appendChild(el('span', 'pname', p.name));
    if (p.isVip && opts.tags) li.appendChild(el('span', 'tag vip', 'VIP'));
    if (!p.connected) li.appendChild(el('span', 'tag', 'away'));
    if (opts.score) li.appendChild(el('span', 'pts', fmt(p.score)));
    return li;
  }

  function renderPlayers(key, node, list, opts) {
    var sig = JSON.stringify([state.you && state.you.id, list.map(function (p) {
      return [p.id, p.name, p.color, p.connected, p.isVip, opts.score ? p.score : 0];
    })]);
    renderList(key, node, sig, function (n) {
      list.forEach(function (p) { n.appendChild(playerRow(p, opts)); });
    });
  }

  function renderPending(key, wrap, node) {
    var myId = state.you ? state.you.id : null;
    var list = players().filter(function (p) { return p.connected && !p.done && p.id !== myId; });
    show(wrap, list.length > 0);
    renderList(key, node, JSON.stringify(list.map(function (p) { return [p.id, p.name]; })), function (n) {
      list.forEach(function (p) { n.appendChild(el('li', '', p.name)); });
    });
  }

  // ---------- question header ----------
  function renderQuestion(section) {
    var q = state.question;
    var meta = section.querySelector('.q-meta');
    var mult = section.querySelector('.q-mult');
    var text = section.querySelector('.q-text');
    if (!q) { setText(meta, ''); show(mult, false); setText(text, ''); return; }
    setText(meta, (q.category ? q.category + ' · ' : '') + 'Question ' + q.number + ' of ' + q.total);
    show(mult, q.multiplier > 1);
    setText(mult, '×' + q.multiplier + ' POINTS');
    var qt = String(q.text || '');
    if (text.getAttribute('data-q') !== qt) {
      text.setAttribute('data-q', qt);
      while (text.firstChild) text.removeChild(text.firstChild);
      var parts = qt.split('_____');
      for (var i = 0; i < parts.length; i++) {
        if (i > 0) {
          var blank = el('span', 'blank');
          blank.setAttribute('role', 'img');
          blank.setAttribute('aria-label', 'blank');
          text.appendChild(blank);
        }
        if (parts[i]) text.appendChild(document.createTextNode(parts[i]));
      }
    }
  }

  // ---------- countdown ----------
  function tick() {
    var timers = document.querySelectorAll('.timer');
    var txt = '', urgent = false;
    if (state && state.deadline && (state.phase === 'writing' || state.phase === 'voting')) {
      var left = Math.max(0, Math.ceil((state.deadline - (Date.now() + clockOffset)) / 1000));
      txt = String(left);
      urgent = left <= 10;
    }
    for (var i = 0; i < timers.length; i++) {
      setText(timers[i], txt);
      timers[i].classList.toggle('urgent', urgent);
    }
  }
  setInterval(tick, 250);

  // ---------- screens ----------
  function renderJoin() {
    ui.joinBtn.disabled = joining || !connected;
    setText(ui.joinBtn, joining ? 'JOINING…' : (connected ? 'JOIN' : 'CONNECTING…'));
  }

  function renderLobby() {
    var list = players(), v = vip();
    setText(ui.lobbyName, state.you.name);
    setText(ui.lobbyCount, 'Players (' + list.length + ')');
    renderPlayers('lobby', ui.lobbyPlayers, list, { tags: true });
    var isVip = amVip();
    var mode = modeName();
    var modeBtns = ui.modeSwitch.children;
    for (var i = 0; i < modeBtns.length; i++) {
      var on = modeBtns[i].getAttribute('data-mode') === mode;
      modeBtns[i].classList.toggle('on', on);
      modeBtns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      modeBtns[i].disabled = !isVip || !!busy.mode || !connected;
    }
    ui.modeSwitch.classList.toggle('readonly', !isVip);
    setText(ui.modeTitle, isVip ? 'Game mode — you choose' : 'Game mode');
    setText(ui.modeDesc, MODES[mode]);
    show(ui.lobbyVip, isVip);
    show(ui.lobbyWait, !isVip);
    if (isVip) {
      var enough = list.length >= 2;
      ui.startBtn.disabled = !enough || !!busy.start || !connected;
      if (enough && startError) setText(ui.startHint, startError);
      else setText(ui.startHint, enough ? "You're the VIP — start when everyone's in!" : 'Need at least 2 players to start.');
      if (!enough) startError = '';
    } else {
      setText(ui.lobbyWait, v ? 'Waiting for ' + v.name + ' to start…' : 'Waiting for the game to start…');
    }
  }

  function renderWriting() {
    renderQuestion(screens.writing);
    var lie = state.you.lie;
    show(ui.lieForm, !lie);
    show(ui.lieDone, !!lie);
    if (lie) {
      setText(ui.lieMine, lie);
      renderPending('wpend', ui.writingPendingWrap, ui.writingPending);
    } else {
      ui.lieBtn.disabled = lieSending || !connected;
      setText(ui.lieBtn, lieSending ? 'SENDING…' : 'SUBMIT');
    }
  }

  function renderVoting() {
    renderQuestion(screens.voting);
    var opts = Array.isArray(state.options) ? state.options : [];
    var vote = state.you.vote || pendingVote;
    var locked = !!state.you.vote || voteSending || !connected;
    var likesOn = state.mode === 'quickfire';
    var like = likesOn ? (state.you.like || pendingLike) : null;
    var canLike = likesOn; // hearts are available from the start so the last voter isn't locked out
    var likeLocked = !!like || likeSending || !connected;

    var sig = JSON.stringify(opts.map(function (o) { return [o.id, o.text, !!o.mine]; }));
    if (sig !== optionsSig) {
      optionsSig = sig;
      while (ui.voteOptions.firstChild) ui.voteOptions.removeChild(ui.voteOptions.firstChild);
      opts.forEach(function (o) {
        var row = el('div', 'opt-row');
        var b = el('button', 'opt');
        b.type = 'button';
        b.setAttribute('data-id', o.id);
        b.appendChild(el('span', 'opt-text', o.text));
        b.appendChild(el('span', 'opt-tag', ''));
        row.appendChild(b);
        var h = el('button', 'heart', '❤');
        h.type = 'button';
        h.hidden = true;
        h.disabled = true;
        h.setAttribute('data-like', o.id);
        h.setAttribute('aria-label', 'Give a heart to this one');
        row.appendChild(h);
        ui.voteOptions.appendChild(row);
      });
    }

    var byId = {};
    opts.forEach(function (o) { byId[o.id] = o; });
    var rows = ui.voteOptions.children;
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i].firstChild, heart = rows[i].lastChild, o = byId[b.getAttribute('data-id')];
      if (!o) continue;
      var showHeart = canLike && !o.mine;
      show(heart, showHeart);
      heart.classList.toggle('liked', showHeart && like === o.id);
      heart.disabled = !showHeart || likeLocked;
      var chosen = vote === o.id;
      b.classList.toggle('mine', !!o.mine);
      b.classList.toggle('chosen', chosen);
      b.disabled = !!o.mine || locked;
      var tag = b.lastChild;
      setText(tag, o.mine ? 'your lie' : (chosen ? 'your pick' : ''));
      show(tag, !!o.mine || chosen);
    }
    ui.voteOptions.classList.toggle('voted', !!vote);

    ui.votePrompt.classList.toggle('like-hint', canLike && !like);
    if (state.you.vote) {
      setText(ui.votePrompt, !canLike ? 'Vote locked in! Waiting for the others…'
        : like ? 'Vote and ❤ locked in! Waiting for the others…'
        : 'Vote locked in! Now give a ❤ to the best porkie');
      renderPending('vpend', ui.votingPendingWrap, ui.votingPending);
    } else {
      setText(ui.votePrompt, opts.length ? (canLike && !like ? 'Tap the truth — and ❤ the best porkie' : 'Which one is the truth?') : 'Getting the answers ready…');
      show(ui.votingPendingWrap, false);
    }
  }

  function scoreNotes() {
    var notes = [];
    var rv = Array.isArray(state.reveal) ? state.reveal : null;
    if (!rv) return notes;
    var id = state.you.id, truth = null, fooled = 0, fellFor = null, bestBonus = 0;
    rv.forEach(function (item) {
      if (item.isTruth) { truth = item; return; }
      if (item.bestPorkie && hasId(item.authors, id)) bestBonus += Number(item.bonus) || 0;
      if (hasId(item.authors, id)) fooled += Array.isArray(item.voters) ? item.voters.length : 0;
      if (hasId(item.voters, id)) fellFor = item;
    });
    if (truth && hasId(truth.voters, id)) {
      notes.push(['good', 'You spotted the truth!']);
    } else if (fellFor) {
      var authors = Array.isArray(fellFor.authors) ? fellFor.authors : [];
      notes.push(['bad', authors.length
        ? 'You fell for ' + names(authors) + "'s lie: " + fellFor.text
        : 'You fell for the computer\'s lie: ' + fellFor.text]);
    } else if (!state.you.vote) {
      notes.push(['info', "You didn't vote."]);
    }
    if (fooled > 0) notes.push(['good', 'Your lie fooled ' + fooled + (fooled === 1 ? ' player!' : ' players!')]);
    if (bestBonus > 0) notes.push(['good', '❤ Best porkie bonus! +' + fmt(bestBonus)]);
    if (truth && !hasId(truth.voters, id)) notes.push(['info', 'The truth: ' + truth.text]);
    return notes;
  }

  function renderScores() {
    var m = me();
    var delta = m ? (m.delta || 0) : 0;
    setText(ui.scoreDelta, '+' + fmt(delta));
    ui.scoreDelta.classList.toggle('zero', delta <= 0);
    var notes = scoreNotes();
    renderList('notes', ui.scoreNotes, JSON.stringify(notes), function (n) {
      notes.forEach(function (x) { n.appendChild(el('li', x[0], x[1])); });
    });
    setText(ui.scoreTotal, fmt(m ? m.score : 0));
    setText(ui.scoreRank, m ? ordinal(rankOf(m)) + ' of ' + players().length : '–');
    renderPlayers('sboard', ui.scoreBoard, sortedByScore(), { score: true, rank: true });
  }

  function renderGameover() {
    var m = me(), list = sortedByScore();
    setText(ui.finalPlace, m ? ordinal(rankOf(m)) : '–');
    setText(ui.finalScore, m ? fmt(m.score) + ' points' : '');
    var top = list.length ? (list[0].score || 0) : 0;
    var winners = list.filter(function (p) { return (p.score || 0) === top; });
    var iWon = m && hasId(winners, m.id);
    var txt;
    if (!winners.length) txt = '–';
    else if (winners.length === 1) txt = iWon ? '🏆 You! 🏆' : '🏆 ' + winners[0].name;
    else txt = '🏆 Tie: ' + names(winners);
    setText(ui.finalWinner, txt);
    renderPlayers('fboard', ui.finalBoard, list, { score: true, rank: true });
    var isVip = amVip(), v = vip();
    show(ui.againBtn, isVip);
    ui.againBtn.disabled = !!busy.restart || !connected;
    show(ui.againWait, !isVip);
    setText(ui.againWait, v ? 'Waiting for ' + v.name + ' to start a new game…' : 'Thanks for playing!');
  }

  var SKIPPABLE = { writing: 1, voting: 1, reveal: 1, scores: 1 };

  function disarmSkip() {
    if (skipArmedTimer) { clearTimeout(skipArmedTimer); skipArmedTimer = null; }
    ui.skipBtn.classList.remove('armed');
    setText(ui.skipBtn, 'skip ›');
  }

  function render() {
    show(ui.banner, everConnected && !connected);

    var joined = !!(state && state.you);
    var name = joined ? 'lobby' : 'join';
    if (joined && screens[state.phase]) name = state.phase;

    // Removed from the game while still connected (kicked).
    if (wasJoined && !joined && connected && !joining && state) {
      setError(ui.joinErr, "You've left the game. Tap JOIN to hop back in.");
    }
    wasJoined = joined;

    // Per-question reset of local input state.
    // (Only while joined, so a brief you:null during a reconnect doesn't wipe a half-typed lie.)
    var key = joined && state.question ? String(state.question.number) : '';
    if (joined && key !== roundKey) {
      roundKey = key;
      ui.lieInput.value = '';
      setError(ui.lieErr, '');
      setError(ui.voteErr, '');
      pendingVote = null;
      pendingLike = null;
      lieSending = false;
      voteSending = false;
      likeSending = false;
    }

    if (name !== currentScreen) {
      currentScreen = name;
      for (var n in screens) show(screens[n], n === name);
      disarmSkip();
      if (name !== 'lobby') startError = '';
      if (name !== 'voting') { setError(ui.voteErr, ''); pendingVote = null; pendingLike = null; }
      // Drop the keyboard when the screen with the focused input goes away.
      var a = document.activeElement;
      if (a && a.tagName === 'INPUT' && a.offsetParent === null) a.blur();
      window.scrollTo(0, 0);
    }

    // Top bar
    show(ui.topbar, joined);
    if (joined) {
      var m = me();
      var color = safeColor(m && m.color);
      document.documentElement.style.setProperty('--you', color);
      setText(ui.topName, state.you.name);
      // Hidden during reveal so the new total doesn't spoil the big-screen animation.
      var hideScore = state.phase === 'lobby' || state.phase === 'reveal';
      setText(ui.topScore, hideScore ? '' : fmt(m ? m.score : 0));
    }

    // VIP skip
    var canSkip = joined && amVip() && SKIPPABLE[state.phase] === 1;
    show(ui.footer, canSkip);
    ui.skipBtn.disabled = !!busy.skip || !connected;

    if (name === 'join') renderJoin();
    else if (name === 'lobby') renderLobby();
    else if (name === 'writing') renderWriting();
    else if (name === 'voting') renderVoting();
    else if (name === 'scores') renderScores();
    else if (name === 'gameover') renderGameover();

    tick();
  }

  // ---------- actions ----------
  ui.joinForm.addEventListener('submit', function (e) {
    e.preventDefault();
    join(ui.nameInput.value, false);
  });

  var LIE_ERRORS = {
    truth: 'You stumbled on the actual truth! Write a lie instead.',
    empty: 'Type a lie first!',
    wrong_phase: "Too late — time's up!",
    offline: 'Not connected — hang on and try again.',
    timeout: 'That didn\'t go through. Try again.'
  };

  ui.lieForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (lieSending) return;
    var text = ui.lieInput.value.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!text) { setError(ui.lieErr, LIE_ERRORS.empty); return; }
    var sentKey = roundKey;
    lieSending = true;
    setError(ui.lieErr, '');
    render();
    send('player:lie', { text: text }, function (res) {
      if (sentKey !== roundKey) return; // answer for a question that's already gone
      lieSending = false;
      if (res.ok) {
        if (document.activeElement === ui.lieInput) ui.lieInput.blur();
      } else if (res.error !== 'already') {
        setError(ui.lieErr, LIE_ERRORS[res.error] || "Couldn't send that. Try again.");
        if (res.error === 'truth') { ui.lieInput.value = ''; }
      }
      render();
    });
  });

  ui.lieInput.addEventListener('input', function () {
    if (!ui.lieErr.hidden) setError(ui.lieErr, '');
  });
  ui.nameInput.addEventListener('input', function () {
    if (!ui.joinErr.hidden) setError(ui.joinErr, '');
  });

  var VOTE_ERRORS = {
    own: "That's your own lie! Pick another.",
    invalid: "That one isn't available. Pick another.",
    wrong_phase: 'Too late — voting has closed!',
    offline: 'Not connected — hang on and try again.',
    timeout: "That didn't go through. Try again."
  };

  var LIKE_ERRORS = {
    own: "You can't ❤ your own lie!",
    invalid: "That one isn't available. Pick another.",
    wrong_phase: 'Too late — voting has closed!',
    offline: 'Not connected — hang on and try again.',
    timeout: "That didn't go through. Try again."
  };

  function sendLike(id) {
    if (!state || !state.you || state.mode !== 'quickfire' || !state.you.vote) return;
    if (state.you.like || likeSending) return;
    var sentKey = roundKey;
    likeSending = true;
    pendingLike = id;
    setError(ui.voteErr, '');
    render();
    send('player:like', { optionId: id }, function (res) {
      if (sentKey !== roundKey) return;
      likeSending = false;
      if (!res.ok) {
        pendingLike = null;
        if (res.error !== 'already') setError(ui.voteErr, LIKE_ERRORS[res.error] || "Couldn't send your ❤. Try again.");
      }
      render();
    });
  }

  ui.modeSwitch.addEventListener('click', function (e) {
    var b = e.target;
    while (b && b !== ui.modeSwitch && !(b.getAttribute && b.getAttribute('data-mode'))) b = b.parentNode;
    if (!b || b === ui.modeSwitch || b.disabled) return;
    var mode = b.getAttribute('data-mode');
    if (!state || !amVip() || busy.mode || mode === modeName()) return;
    startError = '';
    busy.mode = true;
    render();
    send('game:mode', { mode: mode }, function (res) {
      busy.mode = false;
      if (!res.ok) startError = "Couldn't change the mode. Try again.";
      render();
    });
  });

  ui.voteOptions.addEventListener('click', function (e) {
    var b = e.target;
    while (b && b !== ui.voteOptions && !(b.getAttribute && (b.getAttribute('data-id') || b.getAttribute('data-like')))) b = b.parentNode;
    if (b && b !== ui.voteOptions && b.getAttribute('data-like')) {
      if (!b.disabled && !b.hidden) sendLike(b.getAttribute('data-like'));
      return;
    }
    if (!b || b === ui.voteOptions || b.disabled) return;
    if (!state || !state.you || state.you.vote || voteSending) return;
    var id = b.getAttribute('data-id');
    var sentKey = roundKey;
    voteSending = true;
    pendingVote = id;
    setError(ui.voteErr, '');
    render();
    send('player:vote', { optionId: id }, function (res) {
      if (sentKey !== roundKey) return;
      voteSending = false;
      if (!res.ok) {
        pendingVote = null;
        if (res.error !== 'already') setError(ui.voteErr, VOTE_ERRORS[res.error] || "Couldn't vote. Try again.");
      }
      render();
    });
  });

  function simpleAction(flag, event, onError) {
    if (busy[flag]) return;
    busy[flag] = true;
    render();
    send(event, {}, function (res) {
      busy[flag] = false;
      if (!res.ok && onError) onError(res.error);
      render();
    });
  }

  ui.startBtn.addEventListener('click', function () {
    startError = '';
    simpleAction('start', 'game:start', function (err) {
      startError = err === 'need_players' ? 'Need at least 2 players to start.' : "Couldn't start the game. Try again.";
    });
  });

  ui.againBtn.addEventListener('click', function () {
    simpleAction('restart', 'game:restart');
  });

  // Skip needs two taps so a stray thumb doesn't end the round.
  ui.skipBtn.addEventListener('click', function () {
    if (!ui.skipBtn.classList.contains('armed')) {
      ui.skipBtn.classList.add('armed');
      setText(ui.skipBtn, 'tap again to skip');
      skipArmedTimer = setTimeout(disarmSkip, 3000);
      return;
    }
    disarmSkip();
    simpleAction('skip', 'game:skip');
  });

  // Phones suspend timers/sockets in the background; resync when we come back.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (!socket.connected && typeof socket.connect === 'function') socket.connect();
    tick();
  });

  render();
})();
