/* UI controller for the Texas Hold'em game (depends on game.js -> window.Poker). */
(function () {
  'use strict';
  const { Game, rankLabel, suitSymbol } = window.Poker;

  // ---- Start screen state ----
  const sel = { difficulty: 'medium', opponents: 2, stack: 1000 };
  const diffHints = {
    easy: '简单：AI 经常会跟注、很少弃牌，打法随意——适合新手练习。',
    medium: '中等：会算底池赔率，按牌力下注/跟注/弃牌，比较聪明。',
    hard: '困难：用蒙特卡洛模拟估算胜率，精打细算、偶尔诈唬，非常难缠。',
  };

  function wireSeg(id, key, fmt) {
    const seg = document.getElementById(id);
    seg.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        sel[key] = fmt ? fmt(b.dataset.val) : b.dataset.val;
        if (key === 'difficulty') document.getElementById('difficulty-hint').textContent = diffHints[sel.difficulty];
      });
    });
  }
  wireSeg('difficulty-seg', 'difficulty');
  wireSeg('opponents-seg', 'opponents', (v) => parseInt(v, 10));
  wireSeg('stack-seg', 'stack', (v) => parseInt(v, 10));

  // ---- Game elements ----
  const startScreen = document.getElementById('start-screen');
  const gameScreen = document.getElementById('game-screen');
  const seatsEl = document.getElementById('seats');
  const communityEl = document.getElementById('community');
  const potEl = document.getElementById('pot-badge');
  const stageEl = document.getElementById('stage-badge');
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('log');
  const handInfoEl = document.getElementById('hand-info');
  const diffBadge = document.getElementById('difficulty-badge');
  const equityBox = document.getElementById('equity-box');
  const eqFill = document.getElementById('eq-fill');
  const eqPct = document.getElementById('eq-pct');
  const eqAdvice = document.getElementById('eq-advice');
  const toastsEl = document.getElementById('toasts');

  const btnFold = document.getElementById('btn-fold');
  const btnCall = document.getElementById('btn-call');
  const btnRaise = document.getElementById('btn-raise');
  const raiseGroup = document.querySelector('.raise-group');
  const slider = document.getElementById('raise-slider');
  const nextBtn = document.getElementById('btn-next');
  const overlay = document.getElementById('overlay');

  const STAGE_NAMES = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };
  const DIFF_NAMES = { easy: '简单', medium: '中等', hard: '困难' };

  // ---- Achievements (persisted in localStorage) ----
  const ACH_DEFS = [
    { id: 'first_win', name: '初战告捷', desc: '赢下第一手牌' },
    { id: 'allin_win', name: '孤注一掷', desc: '以全下姿态赢下一手牌' },
    { id: 'multi_win', name: '一穿多', desc: '在多人摊牌中获胜' },
    { id: 'bluff', name: '虚张声势', desc: '下注 / 加注逼退对手，直接赢池' },
    { id: 'whale', name: '大赢家', desc: '单手赢得 ≥ 起始筹码 50% 的彩池' },
    { id: 'streak3', name: '三连胜', desc: '连续赢下 3 手牌' },
    { id: 'champ_hard', name: '困难封王', desc: '在困难难度下赢下整局' },
  ];
  let achStore = {};
  try { achStore = JSON.parse(localStorage.getItem('th-achv') || '{}') || {}; } catch (e) { achStore = {}; }
  let achStreak = 0;
  const achDone = new Set();
  function saveAch() { try { localStorage.setItem('th-achv', JSON.stringify(achStore)); } catch (e) {} }
  function unlockAch(id) {
    if (!achStore[id]) { achStore[id] = Date.now(); saveAch(); return ACH_DEFS.find((d) => d.id === id); }
    return null;
  }
  function checkHandAchievements(info, g) {
    if (!info) return [];
    const newly = [];
    const grab = (id) => { const d = unlockAch(id); if (d) newly.push(d); };
    if (info.humanWon) {
      achStreak++;
      grab('first_win');
      if (info.humanAllIn) grab('allin_win');
      if (info.type === 'showdown' && info.multiway) grab('multi_win');
      if (info.type === 'fold' && info.humanAggressor) grab('bluff');
      if (info.potWon >= g.startingStack * 0.5) grab('whale');
      if (achStreak >= 3) grab('streak3');
    } else {
      achStreak = 0;
    }
    return newly;
  }
  function showToast(def) {
    if (!def || !toastsEl) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<div class="t-title">🏅 解锁成就</div><div class="t-name">${def.name}</div><div class="t-desc">${def.desc}</div>`;
    toastsEl.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 3600);
  }

  let game = null;
  let seatEls = {};

  // ---- Card rendering ----
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
  function emptySlot() {
    const d = document.createElement('div');
    d.className = 'card';
    d.style.background = 'transparent';
    d.style.border = '2px dashed rgba(255,255,255,.18)';
    return d;
  }

  // ---- Seat building / positioning ----
  function buildSeats() {
    seatsEl.innerHTML = '';
    seatEls = {};
    const n = game.players.length;
    game.players.forEach((p, i) => {
      const angle = Math.PI / 2 + (i * 2 * Math.PI) / n;
      const x = 50 + 46 * Math.cos(angle);
      const y = 50 + 42 * Math.sin(angle);
      const seat = document.createElement('div');
      seat.className = 'seat';
      seat.style.left = x + '%';
      seat.style.top = y + '%';
      seat.innerHTML =
        `<div class="cards"></div>` +
        `<div class="bet-chip" style="display:none"></div>` +
        `<div class="avatar">${p.isHuman ? '🧑' : '🤖'}<div class="dealer-btn" style="display:none">D</div></div>` +
        `<div class="name">${p.name}</div>` +
        `<div class="persona">${p.isHuman ? '' : (p.personality ? p.personality.label : '')}</div>` +
        `<div class="chips"></div>` +
        `<div class="lastact"></div>` +
        `<div class="win-tag" style="display:none"></div>`;
      seatsEl.appendChild(seat);
      seatEls[p.id] = seat;
    });
  }

  // ---- Render ----
  function render() {
    if (!game) return;
    potEl.textContent = '底池 $' + game.pot;
    stageEl.textContent = STAGE_NAMES[game.stage] || '';
    handInfoEl.textContent = '第 ' + game.handNumber + ' 手';

    // community
    communityEl.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      if (i < game.community.length) communityEl.appendChild(cardEl(game.community[i], true));
      else communityEl.appendChild(emptySlot());
    }

    const showdown = game.handOver && game.stage === 'showdown';
    const winnerIds = new Set(game.lastWinners.map((w) => w.id));

    game.players.forEach((p) => {
      const seat = seatEls[p.id];
      if (!seat) return;
      seat.className = 'seat' + (game.currentPlayer === game.players.indexOf(p) && !game.handOver && !p.folded && !p.allIn ? ' active' : '') +
        (p.folded ? ' folded' : '') + (p.allIn ? ' allin' : '');
      const cardsBox = seat.querySelector('.cards');
      cardsBox.innerHTML = '';
      const faceUp = p.isHuman || (showdown && !p.folded);
      p.hand.forEach((c) => cardsBox.appendChild(cardEl(c, faceUp)));

      const betChip = seat.querySelector('.bet-chip');
      if (p.bet > 0) { betChip.style.display = 'block'; betChip.textContent = '$' + p.bet; }
      else betChip.style.display = 'none';

      seat.querySelector('.dealer-btn').style.display = (game.players[game.dealer] === p) ? 'flex' : 'none';
      seat.querySelector('.chips').textContent = '$' + p.stack;
      seat.querySelector('.lastact').textContent = p.lastAction || '';

      const winTag = seat.querySelector('.win-tag');
      if (winnerIds.has(p.id)) { winTag.style.display = 'block'; winTag.textContent = '🏆 获胜'; }
      else winTag.style.display = 'none';
    });

    // status + log
    if (game.handOver) {
      statusEl.textContent = game.gameOver ? '游戏结束' : '本手结束 · 点击「下一手」继续';
    } else if (game.waitingForHuman) {
      statusEl.textContent = '轮到你行动';
    } else {
      const cur = game.players[game.currentPlayer];
      statusEl.textContent = (cur ? cur.name : '') + ' 行动中…';
    }
    renderLog();
  }

  function renderLog() {
    logEl.innerHTML = '';
    game.logEntries.slice(-40).forEach((line) => {
      const e = document.createElement('div');
      e.className = 'entry';
      e.textContent = line;
      logEl.appendChild(e);
    });
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---- Controls ----
  function disableControls() {
    btnFold.disabled = true;
    btnCall.disabled = true;
    btnRaise.disabled = true;
    raiseGroup.style.display = 'none';
    nextBtn.classList.add('hidden');
  }

  function enableControls() {
    const o = game.getHumanOptions();
    disableControls();
    btnFold.disabled = false;
    btnCall.disabled = false;
    btnCall.textContent = o.canCheck ? '看牌' : '跟注 $' + o.callAmount;
    // The human may raise whenever they can still put in more chips than a call
    // (a full min-raise, or an all-in for less). Re-enable the button here —
    // disableControls() above turns it off, and it must be turned back on.
    const canRaise = o.canRaise;
    btnRaise.disabled = !canRaise;
    if (canRaise) {
      raiseGroup.style.display = 'flex';
      const step = Math.max(1, game.bigBlind);
      const lo = Math.min(o.minRaiseTo, o.maxRaiseTo);
      const hi = Math.max(o.minRaiseTo, o.maxRaiseTo);
      slider.min = lo; slider.max = hi; slider.step = step;
      let v = +slider.value;
      if (isNaN(v) || v < lo || v > hi) v = o.minRaiseTo;
      slider.value = v;
      updateRaiseLabel();
    }
    updateEquity();
  }

  function updateRaiseLabel() {
    btnRaise.textContent = '加注到 $' + (+slider.value);
  }

  // Live win-probability + pot-odds advice (shown on the human's turn only).
  function updateEquity() {
    const eq = game.estimateEquityForHuman();
    if (eq == null) { equityBox.style.display = 'none'; return; }
    equityBox.style.display = 'flex';
    const pct = Math.round(eq * 100);
    eqFill.style.width = Math.max(4, pct) + '%';
    eqPct.textContent = pct + '%';
    const o = game.getHumanOptions();
    const potOdds = o.callAmount > 0 ? o.callAmount / (o.pot + o.callAmount) : 0;
    let adv;
    if (o.canCheck) adv = eq > 0.62 ? '建议：价值加注 / 下注' : eq > 0.4 ? '建议：看牌' : '建议：看牌（牌力偏弱）';
    else if (eq >= potOdds + 0.06) adv = '建议：跟注（赔率划算）';
    else if (eq >= potOdds - 0.04) adv = '建议：可跟注，也可弃牌';
    else adv = '建议：弃牌（赔率不划算）';
    eqAdvice.textContent = adv;
  }

  slider.addEventListener('input', updateRaiseLabel);

  document.querySelectorAll('.qbtn').forEach((b) => {
    b.addEventListener('click', () => {
      if (!game || !game.waitingForHuman) return;
      const o = game.getHumanOptions();
      let target;
      if (b.dataset.mult === 'max') target = o.maxRaiseTo;
      else target = o.currentBet + Math.floor(game.pot * parseFloat(b.dataset.mult));
      target = Math.max(o.minRaiseTo, Math.min(target, o.maxRaiseTo));
      slider.value = target;
      updateRaiseLabel();
    });
  });

  btnFold.addEventListener('click', () => act('fold'));
  btnCall.addEventListener('click', () => act('call'));
  btnRaise.addEventListener('click', () => act('raise', +slider.value));

  function act(action, amount) {
    if (!game || !game.waitingForHuman) return;
    disableControls();
    game.humanAct(action, amount);
    tick();
  }

  // ---- Game driver ----
  function newHand() {
    if (!game || game.gameOver) return;
    game.startHand();
    buildSeats();
    tick();
  }

  function tick() {
    render();
    if (game.handOver) {
      if (!achDone.has(game.handNumber)) {
        achDone.add(game.handNumber);
        checkHandAchievements(game.lastHandInfo, game).forEach(showToast);
      }
      if (game.gameOver) {
        const human = game.players.find((p) => p.isHuman);
        if (human && human.stack > 0 && game.difficulty === 'hard') {
          const d = unlockAch('champ_hard');
          if (d) showToast(d);
        }
        showGameOver();
        return;
      }
      statusEl.textContent = '本手结束 · 点击「下一手」继续';
      nextBtn.classList.remove('hidden');
      btnFold.disabled = true; btnCall.disabled = true; btnRaise.disabled = true; raiseGroup.style.display = 'none';
      return;
    }
    if (game.waitingForHuman) { enableControls(); return; }
    // Human already folded this hand -> keep playing it out so they can watch.
    const human = game.players.find((p) => p.isHuman);
    if (human && human.folded) statusEl.textContent = '你已弃牌 · 观战中 👀 其余玩家正在对决…';
    equityBox.style.display = 'none';
    disableControls();
    setTimeout(() => { game.step(); tick(); }, 700);
  }

  // ---- Overlays ----
  function showGameOver() {
    const winner = game.players.find((p) => p.stack > 0) || game.players[0];
    document.getElementById('overlay-title').textContent = winner && winner.isHuman ? '🏆 你赢了！' : '游戏结束';
    document.getElementById('overlay-text').textContent = winner
      ? (winner.isHuman ? `恭喜！你赢得了全部筹码（$${winner.stack}）。` : `${winner.name} 赢得了全部筹码。你可以点「再来一局」重新挑战。`)
      : '';
    overlay.classList.remove('hidden');
  }

  nextBtn.addEventListener('click', () => { nextBtn.classList.add('hidden'); newHand(); });
  document.getElementById('overlay-btn').addEventListener('click', () => location.reload());
  document.getElementById('quit-btn').addEventListener('click', () => location.reload());

  // ---- Start ----
  document.getElementById('start-btn').addEventListener('click', () => {
    const names = ['你'].concat(Array.from({ length: sel.opponents }, (_, i) => 'AI-' + (i + 1)));
    const bb = Math.round(sel.stack / 50);
    game = new Game({
      startingStack: sel.stack,
      bigBlind: bb,
      smallBlind: Math.max(1, Math.round(bb / 2)),
      difficulty: sel.difficulty,
      players: names,
    });
    diffBadge.textContent = DIFF_NAMES[sel.difficulty];
    startScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    newHand();
  });
})();
