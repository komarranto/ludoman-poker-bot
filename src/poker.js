// ==================== ПОКЕР: ЧИСТАЯ ЛОГИКА ====================
// Колода, раздача, оценка комбинаций техасского холдема.
// Файл без зависимостей от Telegram и Apps Script — его гоняют тесты в Node.

// U+FE0F (variation selector-16) просит цветной emoji-глиф вместо чёрно-белого
// текстового символа. На телефонах ОС и так подставляет цветной вариант,
// а на десктопных клиентах (Windows/macOS Telegram) без селектора мастио
// рисуются моно-цветом системным шрифтом — с ним показываются красными/чёрными.
const SUITS = ['♠\uFE0F', '♥\uFE0F', '♦\uFE0F', '♣\uFE0F'];
const RANK_LABELS = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const HAND_NAMES = [
  'Старшая карта',
  'Пара',
  'Две пары',
  'Сет',
  'Стрит',
  'Флеш',
  'Фулл-хаус',
  'Каре',
  'Стрит-флеш',
  'Флеш-рояль'
];

/** Новая перемешанная колода из 52 карт: {r: 2..14, s: 0..3} */
function newDeck(random) {
  const rnd = random || Math.random;
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) {
      deck.push({ r: r, s: s });
    }
  }
  // Fisher–Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

function cardToString(card) {
  return RANK_LABELS[card.r] + SUITS[card.s];
}

function cardsToString(cards) {
  return cards.map(cardToString).join(' ');
}

/** Разобрать строку вида "A♠" или "10h" в карту — для тестов */
function parseCard(str) {
  const s = str.trim();
  const suitChar = s.slice(-1);
  const rankStr = s.slice(0, -1).toUpperCase();
  const suitMap = { '♠': 0, 'S': 0, '♥': 1, 'H': 1, '♦': 2, 'D': 2, '♣': 3, 'C': 3 };
  const rankMap = { 'J': 11, 'Q': 12, 'K': 13, 'A': 14, 'T': 10 };
  const r = rankMap[rankStr] || parseInt(rankStr, 10);
  return { r: r, s: suitMap[suitChar] };
}

function parseCards(str) {
  return str.split(/\s+/).filter(Boolean).map(parseCard);
}

/**
 * Оценить ровно 5 карт. Возвращает массив для лексикографического
 * сравнения: [категория, кикеры по убыванию значимости].
 * Категории: 0 старшая ... 8 стрит-флеш, 9 флеш-рояль.
 */
function evaluateFive(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const isFlush = cards.every(c => c.s === cards[0].s);

  // Стрит (с учётом колеса A-2-3-4-5)
  const uniq = ranks.filter((r, i) => ranks.indexOf(r) === i);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) {
      straightHigh = uniq[0];
    } else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) {
      straightHigh = 5;
    }
  }

  if (isFlush && straightHigh) {
    return straightHigh === 14 ? [9, 14] : [8, straightHigh];
  }

  // Группировка по количеству
  const counts = {};
  ranks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  const groups = Object.keys(counts)
    .map(r => ({ r: Number(r), n: counts[r] }))
    .sort((a, b) => (b.n - a.n) || (b.r - a.r));

  if (groups[0].n === 4) {
    return [7, groups[0].r, groups[1].r];
  }
  if (groups[0].n === 3 && groups[1].n === 2) {
    return [6, groups[0].r, groups[1].r];
  }
  if (isFlush) {
    return [5].concat(ranks);
  }
  if (straightHigh) {
    return [4, straightHigh];
  }
  if (groups[0].n === 3) {
    return [3, groups[0].r, groups[1].r, groups[2].r];
  }
  if (groups[0].n === 2 && groups[1].n === 2) {
    return [2, groups[0].r, groups[1].r, groups[2].r];
  }
  if (groups[0].n === 2) {
    return [1, groups[0].r, groups[1].r, groups[2].r, groups[3].r];
  }
  return [0].concat(ranks);
}

function compareScores(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Лучшая комбинация из 5–7 карт: перебираем все пятёрки.
 * Возвращает { score, name, cards }.
 */
function evaluateBest(cards) {
  let best = null;
  const n = cards.length;
  const pick = [];
  const walk = function (start) {
    if (pick.length === 5) {
      const hand = pick.map(i => cards[i]);
      const score = evaluateFive(hand);
      if (!best || compareScores(score, best.score) > 0) {
        best = { score: score, cards: hand };
      }
      return;
    }
    for (let i = start; i < n; i++) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  best.name = HAND_NAMES[best.score[0]];
  return best;
}

/**
 * Определить победителей среди игроков по борду.
 * players: [{ id, cards: [2 карты] }], board: [5 карт].
 * Возвращает { results: [{id, best}], winners: [id, ...] }.
 */
function showdown(players, board) {
  const results = players.map(p => ({ id: p.id, best: evaluateBest(p.cards.concat(board)) }));
  let top = null;
  results.forEach(r => {
    if (!top || compareScores(r.best.score, top) > 0) top = r.best.score;
  });
  const winners = results.filter(r => compareScores(r.best.score, top) === 0).map(r => r.id);
  return { results: results, winners: winners };
}

/**
 * Шансы на победу каждого игрока при текущем борде.
 * Неизвестные карты — все, кроме карманов и борда. Флоп/тёрн считаем точно
 * (перебор всех доборов), префлоп — Монте-Карло на `samples` раздач.
 * Возвращает массив процентов (0..100) в порядке players; ничья делится поровну.
 */
function winChances(players, board, samples, random) {
  const rnd = random || Math.random;
  const known = new Set(players.flatMap(p => p.cards).concat(board).map(c => c.r * 4 + c.s));
  const unknown = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) if (!known.has(r * 4 + s)) unknown.push({ r, s });
  const need = 5 - board.length;
  const wins = players.map(() => 0);
  let total = 0;

  const settle = extra => {
    const full = board.concat(extra);
    const scores = players.map(p => evaluateBest(p.cards.concat(full)).score);
    let top = scores[0];
    scores.forEach(sc => { if (compareScores(sc, top) > 0) top = sc; });
    const winners = scores.map(sc => compareScores(sc, top) === 0);
    const k = winners.filter(Boolean).length;
    winners.forEach((w, i) => { if (w) wins[i] += 1 / k; });
    total++;
  };

  if (need === 0) {
    settle([]);
  } else if (need <= 2) {
    // точный перебор доборов
    const pick = [];
    const walk = start => {
      if (pick.length === need) { settle(pick.map(i => unknown[i])); return; }
      for (let i = start; i < unknown.length; i++) { pick.push(i); walk(i + 1); pick.pop(); }
    };
    walk(0);
  } else {
    const n = samples || 1500;
    for (let t = 0; t < n; t++) {
      // частичный Fisher–Yates: первые need карт случайны
      const pool = unknown.slice();
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(rnd() * (pool.length - i));
        const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      }
      settle(pool.slice(0, need));
    }
  }
  return wins.map(w => Math.round(100 * w / total));
}

export { winChances, newDeck, cardToString, cardsToString, parseCard, parseCards, evaluateFive, evaluateBest, compareScores, showdown, HAND_NAMES };
