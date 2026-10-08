/* Multiplayer for the Texas Hold'em game (PeerJS P2P).
 *
 * Architecture: HOST-AUTHORITATIVE. The host's browser runs the real Game
 * engine (game.js). Guests are thin clients: they receive the public table
 * state + their own hole cards, and submit actions. Empty seats are filled
 * by AI. No server needed — PeerJS provides free P2P signaling.
 *
 * Note on trust: the host's machine knows everyone's hole cards (engine runs
 * there). Fine for playing with friends; not suitable for ranked play.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const { Game, rankLabel, suitSymbol } = window.Poker;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const startScreen = $('start-screen'), gameScreen = $('game-screen');
  const seatsEl = $('seats'), communityEl = $('community'), potEl = $('pot-badge'), stageEl = $('stage-badge');
  const statusEl = $('status'), logEl = $('log'), handInfoEl = $('hand-info'), diffBadge = $('difficulty-badge');
  const btnFold = $('btn-fold'), btnCall = $('btn-call'), btnRaise = $('btn-raise');
  const raiseGroup = document.querySelector('.raise-group'), slider = $('raise-slider');
  const equityBox = $('equity-box');
  const lobby = $('lobby'), lobbyTitle = $('lobby-title'), lobbyCode = $('lobby-code-val'), lobbyPlayers = $('lobby-players');
  const lobbyStart = $('lobby-start'), lobbyLeave = $('lobby-leave'), overlay = $('overlay');
  const STAGE_NAMES = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };

  // ---- state ----
  const M = {
    mode: 'solo', seat: 0, peer: null, conn: null,
    seats: [], game: null, playersInfo: [],
    myCards: [], gstate: null, _lastOpts: null, _onAction: null,
    roomSeats: 4, difficulty: 'medium', stack: 1000, started: false, timer: null, over: false,
  };

  function sendTo(conn, obj) { if (conn && conn.send) { try { conn.send(JSON.stringify(obj)); } catch (e) {} } }
  function randCode() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }

  // Optional custom signaling server via URL params, e.g.
  //   index.html?peerhost=my.server.com&peerport=443&peerpath=/&peersecure=1
  // Lets you bypass the default 0.peerjs.com if it is unreachable.
  function peerOpts() {
    try {
      const q = (typeof location !== 'undefined' && location.search) ? location.search : '';
      if (!q) return null;
      const get = (k) => {
        const m = new RegExp('[?&]' + k + '=([^&]*)').exec(q);
        return m ? decodeURIComponent(m[1]) : null;
      };
      const host = get('peerhost');
      if (!host) return null;
      return {
        host,
        port: parseInt(get('peerport') || '443', 10),
        path: get('peerpath') || '/',
        secure: get('peersecure') !== '0',
      };
    } catch (e) { return null; }
  }
  function makePeer(id) {
    try {
      const o = peerOpts();
      if (o) return id ? new Peer(id, o) : new Peer(null, o);
      return id ? new Peer(id) : new Peer();
    } catch (e) { return null; }
  }
  // Warn if the signaling server never answers, so failures aren't mysterious.
  function armConnectWatchdog(label) {
    let done = false;
    setTimeout(() => {
      if (done) return;
      const h = $('multi-hint');
      if (h) h.textContent = label + '超时：连不上信令服务器。请换网络/关闭加速器重试；'
        + '若长期不通，可在网址后加 ?peerhost=你的服务器&peerport=443 指向自建信令服务器。';
    }, 9000);
    return () => { done = true; };
  }

  // ---- cards ----
  function cardEl(card, faceUp) {
    const d = document.createElement('div');
    if (!faceUp) { d.className = 'card back'; return d; }
    const isRed = card.suit === 'h' || card.suit === 'd';
    d.className = 'card ' + (isRed ? 'red' : 'black');
    d.innerHTML =
      `<div class="corner">${rankLabel(card.rank)}<br>${suitSymbol(card.suit)}</div>` +
      `<div class="pip">${suitSymbol(card.suit)}</div>`;
    return d;
  }
  function backCard() { const d = document.createElement('div'); d.className = 'card back'; return d; }
  function emptySlot() {
    const d = document.createElement('div');
    d.className = 'card';
    d.style.background = 'transparent';
    d.style.border = '2px dashed rgba(255,255,255,.18)';
    return d;
  }

  // ---- seat layout + rendering (shared by host & guest) ----
  function buildSeatsStatic() {
    seatsEl.innerHTML = '';
    const n = M.playersInfo.length || 1;
    M.playersInfo.forEach((p) => {
      const angle = Math.PI / 2 + (p.seat * 2 * Math.PI) / n;
      const x = 50 + 46 * Math.cos(angle), y = 50 + 42 * Math.sin(angle);
      const seat = document.createElement('div');
      seat.className = 'seat';
      seat.style.left = x + '%';
      seat.style.top = y + '%';
      seat.dataset.seat = p.seat;
      seat.innerHTML =
        `<div class="cards"></div>` +
        `<div class="bet-chip" style="display:none"></div>` +
        `<div class="avatar">${p.isSelf ? '🧑' : (p.isAI ? '🤖' : '🧑')}<div class="dealer-btn" style="display:none">D</div></div>` +
        `<div class="name">${p.name}</div>` +
        `<div class="persona">${p.isAI ? (p.persona || '') : ''}</div>` +
        `<div class="chips"></div>` +
        `<div class="lastact"></div>` +
        `<div class="win-tag" style="display:none"></div>`;
      seatsEl.appendChild(seat);
    });
  }

  function renderState(s, myCards) {
    potEl.textContent = '底池 $' + s.pot;
    stageEl.textContent = STAGE_NAMES[s.stage] || '';
    handInfoEl.textContent = '第 ' + s.handNumber + ' 手';

    communityEl.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      if (i < s.community.length) communityEl.appendChild(cardEl(s.community[i], true));
      else communityEl.appendChild(emptySlot());
    }

    const winnerSet = new Set(s.winners || []);
    M.playersInfo.forEach((p) => {
      const seatEl = seatsEl.querySelector('[data-seat="' + p.seat + '"]');
      if (!seatEl) return;
      const i = p.seat;
      const folded = !!s.folded[i], allIn = !!s.allIn[i];
      const isActive = !s.handOver && !folded && !allIn && s.currentPlayer === i;
      seatEl.className = 'seat' + (isActive ? ' active' : '') + (folded ? ' folded' : '') + (allIn ? ' allin' : '');

      const cardsBox = seatEl.querySelector('.cards');
      cardsBox.innerHTML = '';
      let show = [];
      if (p.seat === M.seat) show = myCards || [];
      else if (s.revealed && s.revealed[p.seat]) show = s.revealed[p.seat];
      if (show && show.length) show.forEach((c) => cardsBox.appendChild(cardEl(c, true)));
      else { cardsBox.appendChild(backCard()); cardsBox.appendChild(backCard()); }

      const betChip = seatEl.querySelector('.bet-chip');
      if (s.bets[i] > 0) { betChip.style.display = 'block'; betChip.textContent = '$' + s.bets[i]; }
      else betChip.style.display = 'none';
      seatEl.querySelector('.dealer-btn').style.display = (s.dealer === i) ? 'flex' : 'none';
      seatEl.querySelector('.chips').textContent = '$' + s.stacks[i];
      seatEl.querySelector('.lastact').textContent = s.lastActions[i] || '';
      const winTag = seatEl.querySelector('.win-tag');
      if (winnerSet.has(i)) { winTag.style.display = 'block'; winTag.textContent = '🏆 获胜'; }
      else winTag.style.display = 'none';
    });

    if (s.handOver) {
      statusEl.textContent = s.gameOver ? '游戏结束' : (M.mode === 'host' ? '本手结束 · 即将开始下一手…' : '本手结束 · 等待房主继续…');
    } else if (s.currentPlayer === M.seat) {
      statusEl.textContent = '轮到你行动';
    } else {
      const cur = M.playersInfo.find((x) => x.seat === s.currentPlayer);
      statusEl.textContent = (cur ? cur.name : '') + ' 行动中…';
    }
    if (s.lastLog && logEl) {
      logEl.innerHTML = '';
      const e = document.createElement('div');
      e.className = 'entry';
      e.textContent = s.lastLog;
      logEl.appendChild(e);
    }
  }

  // ---- controls ----
  function multiDisable() {
    btnFold.disabled = true; btnCall.disabled = true; btnRaise.disabled = true;
    raiseGroup.style.display = 'none';
  }
  function multiEnable(opts, onAction) {
    M._lastOpts = opts;
    M._onAction = onAction;
    btnFold.disabled = false;
    btnCall.disabled = false;
    btnCall.textContent = opts.canCheck ? '看牌' : '跟注 $' + opts.callAmount;
    const canRaise = opts.canRaise;
    btnRaise.disabled = !canRaise;
    if (canRaise) {
      raiseGroup.style.display = 'flex';
      slider.min = Math.min(opts.minRaiseTo, opts.maxRaiseTo);
      slider.max = Math.max(opts.minRaiseTo, opts.maxRaiseTo);
      slider.step = Math.max(1, opts.bigBlind || 1);
      slider.value = Math.max(+slider.min, Math.min(+slider.max, opts.minRaiseTo));
      multiRaiseLabel();
    }
  }
  function multiRaiseLabel() { btnRaise.textContent = '加注到 $' + (+slider.value); }
  function fireAction(action, amount) {
    if (!M._onAction) return;
    const fn = M._onAction; M._onAction = null;
    multiDisable();
    fn(action, amount);
  }
  btnFold.addEventListener('click', () => fireAction('fold', 0));
  btnCall.addEventListener('click', () => fireAction('call', 0));
  btnRaise.addEventListener('click', () => fireAction('raise', +slider.value));
  slider.addEventListener('input', multiRaiseLabel);
  document.querySelectorAll('.qbtn').forEach((b) => {
    b.addEventListener('click', () => {
      if (!M._lastOpts || !M._onAction) return;
      const o = M._lastOpts;
      let target;
      if (b.dataset.mult === 'max') target = o.maxRaiseTo;
      else target = o.currentBet + Math.floor((o.pot || 0) * parseFloat(b.dataset.mult));
      target = Math.max(o.minRaiseTo, Math.min(target, o.maxRaiseTo));
      slider.value = target;
      multiRaiseLabel();
    });
  });

  // ---- screens ----
  function showGame() {
    startScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    equityBox.style.display = 'none';
  }
  function showOverlay(title, text) {
    $('overlay-title').textContent = title;
    $('overlay-text').textContent = text;
    overlay.classList.remove('hidden');
  }

  // ---- HOST ----
  function hostStart() {
    const names = M.seats.map((s, i) => (i === 0 ? '你' : (s && s.conn ? (s.name || '玩家' + i) : 'AI-' + i)));
    const bb = Math.round(M.stack / 50);
    M.game = new Game({
      startingStack: M.stack,
      bigBlind: bb,
      smallBlind: Math.max(1, Math.round(bb / 2)),
      difficulty: M.difficulty,
      players: names,
      multiMode: true,
    });
    M.game.players.forEach((p) => {
      if (p.seat === 0) p.controlledBy = 'local';
      else if (M.seats[p.seat] && M.seats[p.seat].conn) p.controlledBy = 'remote';
      else p.controlledBy = 'ai';
    });
    M.playersInfo = M.game.players.map((p) => ({
      seat: p.seat, name: p.name,
      isAI: p.controlledBy === 'ai',
      persona: p.controlledBy === 'ai' && p.personality ? p.personality.label : '',
      isSelf: p.seat === 0,
    }));
    buildSeatsStatic();

    M.game.players.forEach((p) => {
      const s = M.seats[p.seat];
      if (s && s.conn) sendTo(s.conn, {
        type: 'welcome', seat: p.seat,
        names: M.playersInfo.map((x) => ({ name: x.name, isAI: x.isAI, persona: x.persona })),
        stack: M.stack, bb, sb: Math.max(1, Math.round(bb / 2)),
      });
    });
    M.started = true;
    lobby.classList.add('hidden');
    showGame();
    diffBadge.textContent = '联机 ' + M.seats.length + ' 人';
    hostNextHand();
  }

  function hostNextHand() {
    M.game.startHand();
    hostTick();
  }

  function hostTick() {
    if (!M.game) return;
    const pub = M.game.getPublicState();
    renderState(pub, M.game.handOfSeat(0));
    M.game.players.forEach((p) => {
      const s = M.seats[p.seat];
      if (s && s.conn) sendTo(s.conn, { type: 'state', s: Object.assign({}, pub, { myCards: M.game.handOfSeat(p.seat) }) });
    });

    if (M.game.handOver) {
      if (M.game.gameOver) { hostGameOver(); return; }
      clearTimeout(M.timer);
      M.timer = setTimeout(() => { if (M.game && !M.game.gameOver) hostNextHand(); }, 4200);
      return;
    }
    if (M.game.waitingForHuman) {
      const o = M.game.getHumanOptions(); o.bigBlind = M.game.bigBlind;
      multiEnable(o, (action, amount) => { M.game.humanAct(action, amount); hostTick(); });
      return;
    }
    if (M.game.waitingForRemote) {
      const seat = M.game.players[M.game.currentPlayer].seat;
      const o = M.game.getOptionsForSeat(M.game.currentPlayer); o.bigBlind = M.game.bigBlind;
      const conn = M.seats[seat] && M.seats[seat].conn;
      if (conn) { sendTo(conn, { type: 'turn', o }); return; }
      // guest disconnected -> auto-play that seat as AI
      M.game.players[seat].controlledBy = 'ai';
      M.game.waitingForRemote = false;
    }
    M.timer = setTimeout(() => { if (M.game && !M.game.handOver && !M.game.gameOver) { M.game.step(); hostTick(); } }, 620);
  }

  function hostGameOver() {
    const live = M.game.players.find((p) => p.stack > 0);
    const title = live && live.seat === 0 ? '🏆 你赢了！' : '游戏结束';
    const text = live ? (live.seat === 0 ? '恭喜，你赢得了整局！' : live.name + ' 赢得了整局。') : '';
    showOverlay(title, text);
  }

  function createRoom() {
    if (typeof Peer === 'undefined') { $('multi-hint').textContent = '联机库（PeerJS）未加载，请检查网络后刷新页面。'; return; }
    M.mode = 'host';
    M.seats = [{ conn: null, name: '你' }];
    for (let i = 1; i < M.roomSeats; i++) M.seats.push(null);
    M.peer = makePeer('thp-' + randCode());
    if (!M.peer) { $('multi-hint').textContent = '联机库加载失败，请强制刷新（Ctrl+F5）后重试。'; return; }
    const clearWatch = armConnectWatchdog('创建房间');
    M.peer.on('open', (id) => {
      clearWatch();
      lobbyTitle.textContent = '你的房间 · 等待朋友加入';
      lobbyCode.textContent = id;
      lobbyStart.classList.remove('hidden');
      updateLobbyList();
      lobby.classList.remove('hidden');
    });
    M.peer.on('connection', (conn) => {
      conn.on('data', (raw) => {
        let d; try { d = JSON.parse(raw); } catch (e) { return; }
        if (d.type === 'join') {
          const seat = M.seats.findIndex((s) => s === null);
          if (seat < 0) { sendTo(conn, { type: 'full' }); return; }
          M.seats[seat] = { conn, name: d.name || '玩家' + seat };
          updateLobbyList();
        } else if (d.type === 'action') {
          const seat = M.seats.findIndex((s) => s && s.conn === conn);
          if (seat >= 0 && M.game && !M.game.gameOver) {
            if (M.game.remoteAct(seat, d.action, d.amount)) hostTick();
          }
        }
      });
      conn.on('close', () => {
        const seat = M.seats.findIndex((s) => s && s.conn === conn);
        if (seat >= 0) {
          M.seats[seat] = null;
          updateLobbyList();
          if (M.game && M.game.players[seat]) {
            M.game.players[seat].controlledBy = 'ai';
            if (M.game.waitingForRemote && M.game.currentPlayer === seat) {
              M.game.waitingForRemote = false;
              hostTick();
            }
          }
        }
      });
    });
    M.peer.on('error', (e) => {
      const m = e && e.message ? e.message : String(e);
      $('multi-hint').textContent = '创建房间失败：' + m
        + '（若提示网络/服务器错误，多半是信令服务器不通，可换网络重试）';
    });
  }

  function updateLobbyList() {
    if (!lobbyPlayers) return;
    lobbyPlayers.innerHTML = '';
    M.seats.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'lobby-row';
      d.textContent = '座位 ' + (i + 1) + (i === 0 ? '：你（房主）' : (s && s.conn ? '：' + s.name + ' ✓' : '：等待加入…'));
      lobbyPlayers.appendChild(d);
    });
  }

  // ---- GUEST ----
  function guestOnData(raw) {
    let d; try { d = JSON.parse(raw); } catch (e) { return; }
    if (d.type === 'welcome') {
      M.seat = d.seat;
      M.playersInfo = d.names.map((n, i) => ({ seat: i, name: n.name, isAI: n.isAI, persona: n.persona || '', isSelf: i === M.seat }));
      buildSeatsStatic();
      lobby.classList.add('hidden');
      showGame();
      diffBadge.textContent = '联机 · 座位' + (M.seat + 1);
      statusEl.textContent = '等待房主开始…';
    } else if (d.type === 'state') {
      M.gstate = d.s;
      M.myCards = d.s.myCards || [];
      renderState(d.s, M.myCards);
      if (d.s.gameOver) {
        const title = d.s.winnerSeat === M.seat ? '🏆 你赢了！' : '游戏结束';
        const text = d.s.winnerSeat === M.seat ? '恭喜，你赢得了整局！' : (d.s.winnerName ? d.s.winnerName + ' 赢得了整局。' : '');
        showOverlay(title, text);
      }
    } else if (d.type === 'turn') {
      multiEnable(d.o, (action, amount) => {
        sendTo(M.conn, { type: 'action', action, amount });
      });
    } else if (d.type === 'full') {
      $('multi-hint').textContent = '房间已满，无法加入。';
    }
  }

  function joinRoom(code) {
    if (!code) return;
    if (typeof Peer === 'undefined') { $('multi-hint').textContent = '联机库（PeerJS）未加载，请检查网络后刷新页面。'; return; }
    M.mode = 'guest';
    M.peer = makePeer(null);
    if (!M.peer) { $('multi-hint').textContent = '联机库加载失败，请强制刷新（Ctrl+F5）后重试。'; return; }
    const clearWatch = armConnectWatchdog('加入房间');
    M.peer.on('open', () => {
      clearWatch();
      const conn = M.peer.connect(code);
      M.conn = conn;
      conn.on('open', () => sendTo(conn, { type: 'join', name: '玩家' }));
      conn.on('data', guestOnData);
      conn.on('close', () => { if (!M.over) statusEl.textContent = '与房主断开连接'; });
      lobbyTitle.textContent = '已连接 · 等待房主开始';
      lobbyCode.textContent = '房间：' + code;
      lobbyStart.classList.add('hidden');
      lobby.classList.remove('hidden');
    });
    M.peer.on('error', (e) => {
      const t = (e && e.type) ? e.type : '';
      if (t === 'peer-unavailable') {
        $('multi-hint').textContent = '加入失败：房间码不对，或房主还没建房成功 / 已离开。';
      } else if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') {
        $('multi-hint').textContent = '加入失败：连不上信令服务器（网络问题），换网络或关掉加速器再试。';
      } else {
        $('multi-hint').textContent = '加入失败：' + ((e && e.message) ? e.message : (t || '未知错误'));
      }
    });
    $('multi-hint').textContent = '正在连接房间…';
  }

  // ---- wiring ----
  function segVal(segId) {
    const seg = $(segId);
    const act = seg ? seg.querySelector('.active') : null;
    return act ? act.dataset.val : null;
  }
  $('btn-create-room').addEventListener('click', () => {
    M.roomSeats = parseInt(segVal('multi-seats-seg') || '4', 10);
    M.difficulty = segVal('difficulty-seg') || 'medium';
    M.stack = parseInt(segVal('stack-seg') || '1000', 10);
    createRoom();
  });
  $('btn-join-room').addEventListener('click', () => { $('join-input-wrap').style.display = 'block'; });
  $('btn-join-go').addEventListener('click', () => { const c = $('join-code').value.trim(); if (c) joinRoom(c); });
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join-go').click(); });
  lobbyStart.addEventListener('click', () => { if (M.mode === 'host' && M.peer && !M.started) hostStart(); });
  lobbyLeave.addEventListener('click', () => location.reload());
  $('overlay-btn').addEventListener('click', () => location.reload());
})();
