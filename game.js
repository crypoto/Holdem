/*
 * Texas Hold'em core engine.
 * Environment-agnostic: works in the browser (window.Poker) and in node (module.exports).
 */
(function (global) {
  'use strict';

  // ---- Constants & helpers -------------------------------------------------
  const SUITS = ['s', 'h', 'd', 'c'];
  const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11=J 12=Q 13=K 14=A

  function makeDeck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
    return d;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function rankLabel(r) {
    if (r === 14) return 'A';
    if (r === 13) return 'K';
    if (r === 12) return 'Q';
    if (r === 11) return 'J';
    if (r === 10) return '10';
    return String(r);
  }

  function suitSymbol(s) {
    return s === 's' ? '♠' : s === 'h' ? '♥' : s === 'd' ? '♦' : '♣';
  }

  // ---- Hand evaluation -----------------------------------------------------
  // Returns { category, tie:[...] } where category: 8=straight flush,7=four,
  // 6=full house,5=flush,4=straight,3=trips,2=two pair,1=pair,0=high card.
  function evaluate5(cards) {
    const ranks = cards.map((c) => c.rank);
    const suits = cards.map((c) => c.suit);
    const isFlush = suits.every((s) => s === suits[0]);

    const groups = {};
    ranks.forEach((r) => { groups[r] = (groups[r] || 0) + 1; });
    const entries = Object.keys(groups).map((k) => [parseInt(k, 10), groups[k]]);
    // sort by count desc, then rank desc
    entries.sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
    const counts = entries.map((e) => e[1]);
    const sortedRanks = entries.map((e) => e[0]);

    const uniq = [...new Set(ranks)].sort((a, b) => b - a);
    let straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) straightHigh = 5; // wheel
    }
    const isStraight = straightHigh > 0;

    let category, tie;
    if (isStraight && isFlush) { category = 8; tie = [straightHigh]; }
    else if (counts[0] === 4) { category = 7; tie = [sortedRanks[0], sortedRanks[1]]; }
    else if (counts[0] === 3 && counts[1] === 2) { category = 6; tie = [sortedRanks[0], sortedRanks[1]]; }
    else if (isFlush) { category = 5; tie = uniq.slice(); }
    else if (isStraight) { category = 4; tie = [straightHigh]; }
    else if (counts[0] === 3) { category = 3; tie = [sortedRanks[0], sortedRanks[1], sortedRanks[2]]; }
    else if (counts[0] === 2 && counts[1] === 2) { category = 2; tie = [sortedRanks[0], sortedRanks[1], sortedRanks[2]]; }
    else if (counts[0] === 2) { category = 1; tie = [sortedRanks[0], sortedRanks[1], sortedRanks[2], sortedRanks[3]]; }
    else { category = 0; tie = uniq.slice(); }

    return { category, tie };
  }

  // Compare two evaluations: returns >0 if a wins, <0 if b wins, 0 tie.
  function compareEval(a, b) {
    if (a.category !== b.category) return a.category - b.category;
    const n = Math.max(a.tie.length, b.tie.length);
    for (let i = 0; i < n; i++) {
      const av = a.tie[i] || 0;
      const bv = b.tie[i] || 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  }

  function evaluate7(cards) {
    let best = null;
    const n = cards.length;
    const c = [0, 1, 2, 3, 4];
    while (true) {
      const hand = c.map((k) => cards[k]);
      const e = evaluate5(hand);
      if (best === null || compareEval(e, best) > 0) best = e;
      let i = 4;
      while (i >= 0 && c[i] === i + n - 5) i--;
      if (i < 0) break;
      c[i]++;
      for (let j = i + 1; j < 5; j++) c[j] = c[j - 1] + 1;
    }
    return best;
  }

  function handName(cat) {
    return ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight',
      'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'][cat];
  }

  // ---- AI personalities (style layer on top of skill/equity) --------------
  const PERSONA = {
    balanced:    { key: 'balanced',    agg: 0.5,  bluff: 0.05 },
    tight:       { key: 'tight',       agg: 0.25, bluff: 0.02 },
    loose:       { key: 'loose',       agg: 0.7,  bluff: 0.18 },
    callstation: { key: 'callstation', agg: 0.1,  bluff: 0.02 },
    boss:        { key: 'boss',        agg: 0.6,  bluff: 0.22 },
  };
  const PERSONA_KEYS = ['tight', 'loose', 'callstation', 'boss', 'balanced'];
  const PERSONA_LABEL = { tight: '紧弱', loose: '松凶', callstation: '跟注站', boss: '诈唬老板', balanced: '稳健' };

  // ---- Game ----------------------------------------------------------------
  class Game {
    constructor(opts = {}) {
      this.startingStack = opts.startingStack || 1000;
      this.bigBlind = opts.bigBlind || 20;
      this.smallBlind = opts.smallBlind || Math.max(10, Math.floor(this.bigBlind / 2));
      this.fastMode = !!opts.fastMode;
      this.multiMode = !!opts.multiMode;

      const difficulty = opts.difficulty || 'medium';
      const names = opts.players || ['You', 'AI-1', 'AI-2', 'AI-3'];
      this.players = names.map((name, i) => ({
        id: 'p' + i,
        seat: i,
        name,
        isHuman: i === 0,
        aiLevel: i === 0 ? 'medium' : difficulty,
        controlledBy: i === 0 ? 'local' : 'ai',
        stack: this.startingStack,
        bet: 0,
        contributed: 0,
        hand: [],
        folded: false,
        allIn: false,
        hasActed: false,
        lastAction: '',
        handScore: null,
      }));
      this.totalChips = this.players.length * this.startingStack;
      this.difficulty = difficulty;

      this.players.forEach((p) => {
        if (p.isHuman) p.personality = { key: 'human', label: '你' };
        else {
          const k = PERSONA_KEYS[Math.floor(Math.random() * PERSONA_KEYS.length)];
          p.personality = { key: k, label: PERSONA_LABEL[k] };
        }
      });

      this.deck = [];
      this.community = [];
      this.pot = 0;
      this.currentBet = 0;
      this.lastRaiseSize = this.bigBlind;
      this.stage = 'preflop';
      this.handOver = false;
      this.waitingForHuman = false;
      this.waitingForRemote = false;
      this.gameOver = false;
      this.dealer = 0;
      this.bigBlindPos = 0;
      this.currentPlayer = 0;
      this.handNumber = 0;
      this.logEntries = [];
      this.lastWinners = [];
      this.lastHandInfo = null;
    }

    log(msg) { this.logEntries.push(msg); if (this.logEntries.length > 60) this.logEntries.shift(); }

    // ----- betting helpers -----
    nextActiveAfter(i) {
      const n = this.players.length;
      for (let k = 1; k <= n; k++) {
        const idx = (i + k) % n;
        const p = this.players[idx];
        if (!p.folded && !p.allIn) return idx;
      }
      return -1;
    }

    firstActor() {
      if (this.stage === 'preflop') {
        // Heads-up: small blind (= button) acts first preflop.
        if (this.players.length === 2) return this.sbPos;
        return this.nextActiveAfter(this.bigBlindPos);
      }
      return this.nextActiveAfter(this.dealer);
    }

    putChips(p, amt) {
      if (amt <= 0) return;
      amt = Math.min(amt, p.stack);
      p.stack -= amt;
      p.bet += amt;
      p.contributed += amt;
      this.pot += amt;
      if (p.stack === 0) p.allIn = true;
    }

    // ----- hand lifecycle -----
    startHand() {
      if (this.gameOver) return;

      // Reset player states FIRST so that all subsequent nextActiveAfter() calls
      // (button rotation + blind positioning) see a clean table.
      this.players.forEach((p) => {
        p.bet = 0; p.contributed = 0; p.folded = false; p.allIn = false;
        p.hasActed = false; p.hand = []; p.lastAction = ''; p.handScore = null;
      });

      if (this.handNumber > 0) this.dealer = this.nextActiveAfter(this.dealer);
      this.handNumber++;

      // Heads-up: button posts the small blind, other player posts the big blind.
      // Multiway: small blind = next after button, big blind = next after small blind.
      if (this.players.length === 2) {
        this.sbPos = this.dealer;
        this.bbPos = this.nextActiveAfter(this.dealer);
      } else {
        this.sbPos = this.nextActiveAfter(this.dealer);
        this.bbPos = this.nextActiveAfter(this.sbPos);
      }
      this.bigBlindPos = this.bbPos;

      this.deck = shuffle(makeDeck());
      this.community = [];
      this.pot = 0;
      this.currentBet = 0;
      this.lastRaiseSize = this.bigBlind;
      this.stage = 'preflop';
      this.handOver = false;
      this.waitingForHuman = false;
      this.waitingForRemote = false;
      this.lastWinners = [];
      this.lastHandInfo = null;
      this.logEntries = [];

      for (let r = 0; r < 2; r++) for (const p of this.players) p.hand.push(this.deck.pop());

      this.putChips(this.players[this.sbPos], this.smallBlind);
      this.players[this.sbPos].lastAction = 'SB';
      this.putChips(this.players[this.bbPos], this.bigBlind);
      this.players[this.bbPos].lastAction = 'BB';
      this.currentBet = this.bigBlind;
      this._lastBlinds = {
        hand: this.handNumber, dealer: this.dealer, sbPos: this.sbPos, bbPos: this.bbPos,
        sbBet: this.players[this.sbPos].bet, bbBet: this.players[this.bbPos].bet, n: this.players.length,
        bets: this.players.map((p) => p.bet),
      };

      this.currentPlayer = this.firstActor();
      this.log(`— Hand #${this.handNumber} · Dealer: ${this.players[this.dealer].name} —`);
    }

    dealCommunity(k) {
      for (let i = 0; i < k; i++) this.community.push(this.deck.pop());
    }

    activePlayers() { return this.players.filter((p) => !p.folded && !p.allIn); }
    nonFolded() { return this.players.filter((p) => !p.folded); }

    // core per-player action driver
    step() {
      if (this.handOver || this.gameOver) return;
      let p = this.players[this.currentPlayer];
      if (p.folded || p.allIn) {
        const nxt = this.nextActiveAfter(this.currentPlayer);
        if (nxt === -1) { this.afterAction(); return; }
        this.currentPlayer = nxt;
        p = this.players[this.currentPlayer];
      }

      if (p.controlledBy === 'remote') {
        this.waitingForRemote = true;
        return;
      }
      if (p.controlledBy === 'local' && !this.fastMode) {
        this.waitingForHuman = true;
        return;
      }

      const level = p.controlledBy === 'local' ? 'medium' : (p.aiLevel || 'medium');
      const decision = this.decideAI(p, level);
      this.applyAction(p, decision);
    }

    humanAct(action, amount) {
      if (!this.waitingForHuman) return false;
      this.waitingForHuman = false;
      const p = this.players[this.currentPlayer];
      this.applyAction(p, { action, amount: amount || 0 });
      return true;
    }

    // Remote (multiplayer) player submits their action.
    remoteAct(seatIndex, action, amount) {
      if (!this.waitingForRemote) return false;
      const p = this.players[this.currentPlayer];
      if (!p || p.seat !== seatIndex) return false;
      this.waitingForRemote = false;
      this.applyAction(p, { action, amount: amount || 0 });
      return true;
    }

    applyAction(p, d) {
      const callAmount = this.currentBet - p.bet;
      if (d.action === 'fold') {
        p.folded = true; p.lastAction = 'Fold';
        this.log(`${p.name} folds.`);
      } else if (d.action === 'check') {
        p.lastAction = 'Check';
        this.log(`${p.name} checks.`);
      } else if (d.action === 'call') {
        this.putChips(p, callAmount); p.lastAction = 'Call';
        this.log(`${p.name} calls ${callAmount}.`);
      } else if (d.action === 'raise' || d.action === 'bet') {
        let to = d.amount;
        const inc = to - this.currentBet;
        this.lastRaiseSize = Math.max(this.lastRaiseSize, inc);
        this.currentBet = to;
        this.putChips(p, to - p.bet); p.lastAction = 'Raise';
        this.log(`${p.name} raises to ${to}.`);
      } else if (d.action === 'allin') {
        const to = p.bet + p.stack;
        const inc = to - this.currentBet;
        if (to > this.currentBet) {
          this.lastRaiseSize = Math.max(this.lastRaiseSize, inc);
          this.currentBet = to;
        }
        this.putChips(p, p.stack); p.allIn = true; p.lastAction = 'All-in';
        this.log(`${p.name} is all-in (${to}).`);
      }
      p.hasActed = true;
      this.afterAction();
    }

    afterAction() {
      const nonFolded = this.nonFolded();
      if (nonFolded.length === 1) { this.endHandByFold(nonFolded[0]); return; }

      const active = this.activePlayers();
      if (active.length === 0) { this.runOutBoard(); return; }

      const complete = active.every((p) => p.bet === this.currentBet && p.hasActed);
      if (complete) { this.advanceStreet(); return; }

      const nxt = this.nextActiveAfter(this.currentPlayer);
      if (nxt === -1) { this.afterAction(); return; }
      this.currentPlayer = nxt;
    }

    advanceStreet() {
      this.players.forEach((p) => { p.bet = 0; p.hasActed = false; p.lastAction = ''; });
      this.currentBet = 0;
      this.lastRaiseSize = this.bigBlind;

      if (this.stage === 'preflop') { this.dealCommunity(3); this.stage = 'flop'; }
      else if (this.stage === 'flop') { this.dealCommunity(1); this.stage = 'turn'; }
      else if (this.stage === 'turn') { this.dealCommunity(1); this.stage = 'river'; }
      else if (this.stage === 'river') { this.stage = 'showdown'; this.showdown(); return; }

      this.currentPlayer = this.firstActor();
    }

    runOutBoard() {
      while (this.community.length < 5) {
        if (this.community.length === 0) this.dealCommunity(3);
        else this.dealCommunity(1);
      }
      this.stage = 'showdown';
      this.showdown();
    }

    showdown() {
      const contenders = this.nonFolded();
      contenders.forEach((p) => { p.handScore = evaluate7(p.hand.concat(this.community)); });
      const results = this.distributePots(this.players);
      const winners = [];
      this.players.forEach((p) => {
        if (results[p.id]) { p.stack += results[p.id]; if (results[p.id] > 0) winners.push(p); }
      });
      this.lastWinners = winners;
      if (winners.length) {
        const names = winners.map((w) => w.name).join(', ');
        const best = winners[0].handScore;
        this.log(`Showdown: ${names} win ${winners.reduce((s, w) => s + results[w.id], 0)} with ${handName(best.category)}.`);
      }
      const human = this.players.find((p) => p.isHuman);
      const humanWon = human ? winners.some((w) => w.isHuman) : false;
      this.lastHandInfo = {
        type: 'showdown',
        humanWon,
        potWon: (human && humanWon) ? (results[human.id] || 0) : 0,
        multiway: humanWon && contenders.length >= 2,
        humanAllIn: human ? human.allIn : false,
        numContenders: contenders.length,
      };
      this.pot = 0;
      this.handOver = true;
      this.finalize();
    }

    endHandByFold(winner) {
      const potWon = this.pot;
      winner.stack += potWon;
      this.lastWinners = [winner];
      this.log(`${winner.name} wins ${potWon} (everyone else folded).`);
      this.lastHandInfo = {
        type: 'fold',
        humanWon: winner.isHuman,
        potWon,
        humanAggressor: winner.isHuman && (winner.lastAction === 'Raise' || winner.lastAction === 'All-in'),
      };
      this.pot = 0;
      this.handOver = true;
      this.finalize();
    }

    // Side-pot distribution. players: array with {id, contributed, folded, handScore}
    distributePots(players) {
      const results = {};
      players.forEach((p) => { results[p.id] = 0; });
      const contribs = players.map((p) => p.contributed).filter((c) => c > 0);
      const levels = [...new Set(contribs)].sort((a, b) => a - b);
      let prev = 0;
      for (const L of levels) {
        const layer = L - prev;
        const funders = players.filter((p) => p.contributed >= L);
        if (funders.length === 0) { prev = L; continue; }
        const potThisLayer = layer * funders.length;
        const eligible = players.filter((p) => !p.folded && p.contributed >= L);
        const contenders = eligible.length > 0 ? eligible : players.filter((p) => !p.folded);
        if (contenders.length > 0) {
          let best = null;
          contenders.forEach((p) => { if (best === null || compareEval(p.handScore, best) > 0) best = p.handScore; });
          const winners = contenders.filter((p) => compareEval(p.handScore, best) === 0);
          const share = Math.floor(potThisLayer / winners.length);
          let remainder = potThisLayer - share * winners.length;
          winners.forEach((w) => { results[w.id] += share; });
          let i = 0;
          while (remainder > 0) { results[winners[i % winners.length].id] += 1; remainder--; i++; }
        }
        prev = L;
      }
      return results;
    }

    finalize() {
      // In multiplayer, seat indices must stay stable -> never remove players.
      // Busted players simply sit at 0 chips until someone holds all chips.
      const live = this.players.filter((p) => p.stack > 0);
      if (live.length <= 1) {
        this.gameOver = true;
        this.log(`Game over. ${live[0] ? live[0].name : ''} is the winner!`);
        return;
      }
      if (this.multiMode) return;
      const dealerId = this.players[this.dealer] ? this.players[this.dealer].id : null;
      if (live.length !== this.players.length) {
        this.players = live;
        const di = this.players.findIndex((p) => p.id === dealerId);
        this.dealer = di >= 0 ? di : 0;
      }
    }

    // ----- AI -----
    simulateEquity(hole, community, numOpp, trials) {
      const known = hole.concat(community);
      const deck = makeDeck().filter((c) => !known.some((k) => k.rank === c.rank && k.suit === c.suit));
      const need = 5 - community.length;
      let wins = 0, ties = 0;
      for (let t = 0; t < trials; t++) {
        shuffle(deck);
        let idx = 0;
        const oppHands = [];
        for (let o = 0; o < numOpp; o++) { oppHands.push([deck[idx++], deck[idx++]]); }
        const board = community.slice();
        for (let k = 0; k < need; k++) board.push(deck[idx++]);
        const myScore = evaluate7(hole.concat(board));
        let bestOpp = null;
        for (const oh of oppHands) {
          const s = evaluate7(oh.concat(board));
          if (bestOpp === null || compareEval(s, bestOpp) > 0) bestOpp = s;
        }
        const c = compareEval(myScore, bestOpp);
        if (c > 0) wins++; else if (c === 0) ties++;
      }
      return wins / trials + (ties / trials) / 2;
    }

    heuristicStrength(hole, community, level) {
      const r = hole.map((c) => c.rank).sort((a, b) => b - a);
      if (community.length === 0) {
        const isPair = r[0] === r[1];
        const high = Math.max(r[0], r[1]);
        let s = isPair ? 0.5 + (high - 2) / 24 : (high - 2) / 24 * 0.8;
        if (r[0] === 14 || r[1] === 14) s += 0.08;
        return Math.min(1, s + (Math.random() - 0.5) * 0.2);
      }
      const cat = evaluate7(hole.concat(community)).category;
      const base = [0.2, 0.38, 0.5, 0.6, 0.65, 0.7, 0.85, 0.9, 0.96][cat];
      return Math.min(1, Math.max(0, base + (Math.random() - 0.5) * 0.2));
    }

    // Core equity/skill-based decision (no personality styling).
    baseDecision(player, level) {
      const callAmount = Math.max(0, this.currentBet - player.bet);
      const pot = this.pot;
      const numOpp = this.players.filter((p) => !p.folded && p !== player).length;
      const stack = player.stack;
      const trials = level === 'hard' ? 200 : level === 'medium' ? 60 : 0;
      let eq;
      if (trials > 0) eq = this.simulateEquity(player.hand, this.community, numOpp, trials);
      else eq = this.heuristicStrength(player.hand, this.community, level);

      const potOdds = callAmount > 0 ? callAmount / (pot + callAmount) : 0;
      const canRaise = stack > callAmount;
      const minRaiseTo = this.currentBet === 0 ? this.bigBlind : this.currentBet + this.lastRaiseSize;
      const maxRaiseTo = player.bet + stack;

      let action = 'check', amount = 0;

      if (level === 'easy') {
        if (callAmount === 0) {
          if (Math.random() < 0.72) action = 'check';
          else { action = 'raise'; amount = Math.min(maxRaiseTo, Math.max(this.bigBlind, Math.floor(pot * 0.3) + this.bigBlind)); }
        } else {
          if (eq > 0.45 || Math.random() < 0.5) action = 'call';
          else action = 'fold';
        }
      } else if (level === 'medium') {
        if (callAmount === 0) {
          if (eq > 0.55) { action = 'raise'; amount = Math.min(maxRaiseTo, Math.floor(pot * 0.6) + this.bigBlind); }
          else action = 'check';
        } else {
          if (eq > 0.78 && canRaise && Math.random() < 0.7) {
            action = 'raise'; amount = Math.min(maxRaiseTo, this.currentBet + Math.max(this.bigBlind, Math.floor(pot * 0.6)));
          } else if (eq >= potOdds + 0.02) action = 'call';
          else action = Math.random() < 0.15 ? 'call' : 'fold';
        }
      } else { // hard
        if (callAmount === 0) {
          if (eq > 0.62) { action = 'raise'; amount = Math.min(maxRaiseTo, Math.max(this.bigBlind, Math.floor(pot * (0.5 + Math.random() * 0.3)) + this.bigBlind)); }
          else if (eq < 0.25 && Math.random() < 0.12) { action = 'raise'; amount = Math.min(maxRaiseTo, Math.floor(pot * 0.5) + this.bigBlind); } // bluff
          else action = 'check';
        } else {
          if (eq > 0.8 && canRaise) {
            action = 'raise'; amount = Math.min(maxRaiseTo, this.currentBet + Math.max(this.bigBlind, Math.floor(pot * (0.6 + Math.random() * 0.4)) + this.bigBlind));
          } else if (eq >= potOdds + 0.04) action = 'call';
          else if (eq >= potOdds - 0.05 && Math.random() < 0.3) action = 'call';
          else action = 'fold';
        }
      }
      return { action, amount };
    }

    // Build a size-appropriate raise (used by personality overrides).
    raiseDecision(player, bluff) {
      const pot = this.pot;
      const maxRaiseTo = player.bet + player.stack;
      const minRaiseTo = this.currentBet === 0 ? this.bigBlind : this.currentBet + this.lastRaiseSize;
      let amount = bluff
        ? Math.min(maxRaiseTo, Math.floor(pot * 0.5) + this.bigBlind)
        : Math.min(maxRaiseTo, this.currentBet + Math.max(this.bigBlind, Math.floor(pot * 0.6)));
      amount = Math.max(minRaiseTo, Math.min(amount, maxRaiseTo));
      return { action: 'raise', amount };
    }

    // Personality layer on top of the base decision.
    decideAI(player, level) {
      let d = this.baseDecision(player, level);
      const pr = PERSONA[player.personality ? player.personality.key : 'balanced'] || PERSONA.balanced;
      const callAmount = Math.max(0, this.currentBet - player.bet);
      const canRaise = player.stack > callAmount;
      const r = Math.random();
      if (pr.key === 'callstation') {
        if (d.action === 'fold' && callAmount > 0 && r < 0.85) d = { action: 'call', amount: 0 };
      } else if (pr.key === 'loose') {
        if (d.action === 'call' && canRaise && r < pr.agg) d = this.raiseDecision(player, false);
        else if (d.action === 'check' && canRaise && r < pr.bluff) d = this.raiseDecision(player, true);
        else if (d.action === 'fold' && callAmount > 0 && r < 0.35) d = { action: 'call', amount: 0 };
      } else if (pr.key === 'tight') {
        if (d.action === 'raise' && r > pr.agg) d = { action: callAmount > 0 ? 'call' : 'check', amount: 0 };
      } else if (pr.key === 'boss') {
        if (d.action === 'check' && canRaise && r < pr.bluff) d = this.raiseDecision(player, true);
        else if (d.action === 'call' && canRaise && r < 0.3) d = this.raiseDecision(player, false);
      }

      // normalize raise bounds
      if (d.action === 'raise') {
        const maxRaiseTo = player.bet + player.stack;
        const minRaiseTo = this.currentBet === 0 ? this.bigBlind : this.currentBet + this.lastRaiseSize;
        if (maxRaiseTo <= minRaiseTo || maxRaiseTo <= this.currentBet) { d.action = 'allin'; d.amount = maxRaiseTo; }
        else {
          d.amount = Math.max(minRaiseTo, Math.min(d.amount, maxRaiseTo));
          if (d.amount >= maxRaiseTo) { d.action = 'allin'; d.amount = maxRaiseTo; }
        }
      }
      if (d.action === 'check' && callAmount > 0) d.action = 'call';
      if (d.action === 'call' && callAmount === 0) d.action = 'check';
      return d;
    }

    // Win-probability estimate for the human (reused for the on-screen meter).
    estimateEquityForHuman() {
      const h = this.players.find((p) => p.isHuman);
      if (!h || h.folded) return null;
      const numOpp = this.players.filter((p) => !p.folded && !p.isHuman).length;
      if (numOpp === 0) return 1;
      if (this.difficulty === 'easy') {
        return Math.min(1, Math.max(0, this.heuristicStrength(h.hand, this.community, 'medium')));
      }
      const trials = this.difficulty === 'hard' ? 200 : 80;
      return this.simulateEquity(h.hand, this.community, numOpp, trials);
    }

    getOptionsForSeat(seatIndex) {
      const p = this.players[seatIndex];
      const callAmount = this.currentBet - p.bet;
      const minRaiseTo = this.currentBet === 0 ? this.bigBlind : this.currentBet + this.lastRaiseSize;
      const maxRaiseTo = p.bet + p.stack;
      return {
        callAmount,
        minRaiseTo,
        maxRaiseTo,
        canCheck: callAmount === 0,
        canRaise: p.stack > callAmount,
        pot: this.pot,
        currentBet: this.currentBet,
        toCall: callAmount,
      };
    }

    getHumanOptions() {
      return this.getOptionsForSeat(this.currentPlayer);
    }

    handOfSeat(seatIndex) {
      const p = this.players.find((x) => x.seat === seatIndex);
      return p ? p.hand.slice() : [];
    }

    // Public state broadcast to remote clients (no hidden hole cards).
    getPublicState() {
      const revealed = {};
      if (this.handOver && this.stage === 'showdown') {
        this.nonFolded().forEach((p) => { revealed[p.seat] = p.hand.slice(); });
      }
      const live = this.players.find((p) => p.stack > 0);
      return {
        stage: this.stage,
        community: this.community.slice(),
        pot: this.pot,
        currentBet: this.currentBet,
        handNumber: this.handNumber,
        dealer: this.players[this.dealer] ? this.players[this.dealer].seat : 0,
        handOver: this.handOver,
        gameOver: this.gameOver,
        winnerSeat: this.gameOver && live ? live.seat : null,
        winnerName: this.gameOver && live ? live.name : '',
        bets: this.players.map((p) => p.bet),
        stacks: this.players.map((p) => p.stack),
        folded: this.players.map((p) => p.folded),
        allIn: this.players.map((p) => p.allIn),
        lastActions: this.players.map((p) => p.lastAction),
        currentPlayer: this.players[this.currentPlayer] ? this.players[this.currentPlayer].seat : 0,
        winners: this.lastWinners.map((w) => w.seat),
        revealed,
        lastLog: this.logEntries[this.logEntries.length - 1] || '',
      };
    }
  }

  const api = {
    Game, makeDeck, shuffle, evaluate5, evaluate7, compareEval,
    rankLabel, suitSymbol, handName,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Poker = api;
})(typeof window !== 'undefined' ? window : globalThis);
