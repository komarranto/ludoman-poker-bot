// ==================== Durable Object: покерный стол одного чата ====================
// Один объект на чат. Лобби 30 секунд → карты всем открыто → улицы
// крутятся сами по будильнику, в том же сообщении, с шансами на победу.

import { newDeck, cardsToString, evaluateBest, showdown, winChances } from './poker.js';

export const BOT_VERSION = '2026.09.04-5';

export const JOIN_SECONDS = 30;
export const IDLE_START_MS = 5000; // никто не вошёл 5 сек при ≥2 игроках — стартуем раньше
export const STREET_DELAY_MS = 4000; // пауза между улицами
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;

const PHASE_TITLES = { preflop: 'Префлоп', flop: 'Флоп', turn: 'Тёрн', river: 'Ривер' };

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || (user.username ? '@' + user.username : 'Игрок ' + user.id);
}

export class PokerTable {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const update = await request.json();
    await this.ctx.blockConcurrencyWhile(() => this.handleUpdate(update));
    return new Response('ok');
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(() => this.advance());
  }

  now() { return Date.now(); }

  // ---------- Telegram ----------

  async tg(method, payload) {
    const res = await fetch(`${this.env.TELEGRAM_API}/bot${this.env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    let result;
    try { result = await res.json(); } catch (err) { result = { ok: false, description: 'bad json' }; }
    if (!result.ok) console.log(`Telegram ${method}: ${result.description}`);
    return result;
  }

  sendHtml(chatId, text, keyboard) {
    const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    return this.tg('sendMessage', payload);
  }

  editHtml(chatId, messageId, text, keyboard) {
    return this.tg('editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard || [] }
    });
  }

  answer(callbackId, text) {
    const payload = { callback_query_id: callbackId };
    if (text) payload.text = text;
    return this.tg('answerCallbackQuery', payload);
  }

  // ---------- хранилище ----------

  loadStats() { return this.storage.get('stats').then(s => s || {}); }
  saveStats(stats) { return this.storage.put('stats', stats); }
  saveGame(game) { return this.storage.put('game', game); }
  clearGame() { return this.storage.delete('game'); }

  async isDuplicate(updateId) {
    if (updateId === undefined || updateId === null) return false;
    const recent = (await this.storage.get('recentUpdateIds')) || [];
    if (recent.includes(updateId)) return true;
    recent.push(updateId);
    await this.storage.put('recentUpdateIds', recent.slice(-100));
    return false;
  }

  // ---------- маршрутизация ----------

  async handleUpdate(update) {
    if (await this.isDuplicate(update.update_id)) return;

    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message || !message.text) return;

    const command = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    const chatId = message.chat.id;

    if (command === '/ludoman_spin') await this.startLobby(message.chat, message.from);
    else if (command === '/ludoman_top') await this.handleTop(chatId);
    else if (command === '/ludoman_cancel') await this.handleCancel(chatId);
    else if (command === '/bot_version') await this.sendHtml(chatId, `🤖 Ludoman bot, версия <b>${BOT_VERSION}</b>`);
    else if (command === '/start' || command === '/help') {
      await this.sendHtml(chatId,
        '🎰 <b>Ludoman Spin</b> — техасский холдем прямо в чате.\n\n' +
        '/ludoman_spin — раздача: 30 сек на вход, карты всем открыто, улицы крутятся сами\n' +
        '/ludoman_top — кто чаще побеждал\n' +
        '/ludoman_cancel — отменить текущую раздачу\n\n' +
        'Добавь меня в группу и позови друзей.');
    }
  }

  async handleCallback(cb) {
    const [action, handStr] = String(cb.data || '').split(':');
    const game = await this.storage.get('game');
    if (!game || game.handNo !== Number(handStr)) {
      await this.answer(cb.id, 'Эта раздача уже закончена');
      return;
    }
    if (action === 'j') {
      if (game.phase !== 'lobby') await this.answer(cb.id, 'Карты уже розданы — жди следующую раздачу');
      else await this.handleJoin(game, cb.from, cb.id);
    } else {
      await this.answer(cb.id, '');
    }
  }

  // ---------- лобби ----------

  renderLobby(game) {
    const left = Math.max(0, Math.round((game.deadline - this.now()) / 1000));
    const lines = [
      `🎰 <b>LUDOMAN SPIN</b> — раздача #${game.handNo}`,
      'Техасский холдем: карты всем открыто, улицы крутятся сами.',
      '',
      `⏳ Сбор игроков: до ${JOIN_SECONDS} сек (осталось ${left}). Если 5 сек никто не входит — стартуем.`,
      ''
    ];
    if (game.players.length) {
      lines.push(`<b>За столом (${game.players.length}):</b>`);
      game.players.forEach((p, i) => lines.push(`${i + 1}. ${escapeHtml(p.name)}`));
    } else {
      lines.push('Пока никого. Жми кнопку!');
    }
    return lines.join('\n');
  }

  lobbyKeyboard(game) {
    return [[{ text: `🙋 Присоединиться (${game.players.length})`, callback_data: `j:${game.handNo}` }]];
  }

  async startLobby(chat, user) {
    const chatId = chat.id;
    const existing = await this.storage.get('game');
    if (existing) {
      await this.sendHtml(chatId, `Игра уже идёт (раздача #${existing.handNo}). Дождитесь конца или /ludoman_cancel.`);
      return existing;
    }
    const stats = await this.loadStats();
    const handNo = (stats.__handNo || 0) + 1;
    stats.__handNo = handNo;
    await this.saveStats(stats);

    const game = {
      chatId, messageId: null, phase: 'lobby', handNo,
      deadline: this.now() + JOIN_SECONDS * 1000,
      lastJoinAt: this.now(),
      players: [{ id: user.id, name: displayName(user), cards: [] }],
      deck: [], board: [], chances: []
    };
    const sent = await this.sendHtml(chatId, this.renderLobby(game), this.lobbyKeyboard(game));
    if (!sent.ok) return null;
    game.messageId = sent.result.message_id;
    await this.saveGame(game);
    await this.storage.setAlarm(game.deadline);
    return game;
  }

  async handleJoin(game, user, callbackId) {
    if (game.players.some(p => p.id === user.id)) {
      await this.answer(callbackId, 'Ты уже за столом 😉');
      return;
    }
    if (game.players.length >= MAX_PLAYERS) {
      await this.answer(callbackId, `Стол полон (${MAX_PLAYERS})`);
      return;
    }
    game.players.push({ id: user.id, name: displayName(user), cards: [] });
    game.lastJoinAt = this.now();
    await this.saveGame(game);
    await this.storage.setAlarm(this.nextLobbyCheck(game));
    await this.editHtml(game.chatId, game.messageId, this.renderLobby(game), this.lobbyKeyboard(game));
    const left = Math.max(0, Math.round((this.nextLobbyCheck(game) - this.now()) / 1000));
    await this.answer(callbackId, `Ты в игре! Раздача через ${left} сек, если никто больше не войдёт`);
  }

  // ---------- раздача и автопрокрутка ----------

  /** Достаточно ли игроков и прошло ли 5 сек тишины после последнего входа */
  idleLongEnough(game) {
    return game.players.length >= MIN_PLAYERS && this.now() - game.lastJoinAt >= IDLE_START_MS;
  }

  /** Когда следующий раз проверить лобби: через 5 сек после входа, но не позже дедлайна */
  nextLobbyCheck(game) {
    if (game.players.length < MIN_PLAYERS) return game.deadline;
    return Math.min(game.deadline, game.lastJoinAt + IDLE_START_MS);
  }

  /** Шаг будильника: лобби → префлоп → флоп → тёрн → ривер → вскрытие */
  async advance() {
    const game = await this.storage.get('game');
    if (!game) return;

    if (game.phase === 'lobby') {
      if (this.now() < game.deadline && !this.idleLongEnough(game)) {
        // Кто-то вошёл недавно — ждём ещё, но не дольше общего дедлайна
        await this.storage.setAlarm(this.nextLobbyCheck(game));
        return;
      }
      if (game.players.length < MIN_PLAYERS) {
        await this.editHtml(game.chatId, game.messageId,
          `🎰 <b>LUDOMAN SPIN</b> — раздача #${game.handNo}\n\n` +
          `😴 Не набралось игроков (нужно минимум ${MIN_PLAYERS}). Попробуйте ещё раз: /ludoman_spin`);
        await this.clearGame();
        return;
      }
      game.deck = newDeck();
      for (const p of game.players) p.cards = [game.deck.pop(), game.deck.pop()];
      game.board = [];
      game.phase = 'preflop';
    } else if (game.phase === 'preflop') {
      game.board.push(game.deck.pop(), game.deck.pop(), game.deck.pop());
      game.phase = 'flop';
    } else if (game.phase === 'flop') {
      game.board.push(game.deck.pop());
      game.phase = 'turn';
    } else if (game.phase === 'turn') {
      game.board.push(game.deck.pop());
      game.phase = 'river';
    } else if (game.phase === 'river') {
      await this.finishGame(game);
      return;
    }

    game.chances = winChances(game.players, game.board);
    await this.saveGame(game);
    await this.editHtml(game.chatId, game.messageId, this.renderTable(game), []);
    await this.storage.setAlarm(this.now() + STREET_DELAY_MS);
  }

  renderTable(game) {
    const lines = [
      `🎰 <b>LUDOMAN SPIN</b> — раздача #${game.handNo} · <b>${PHASE_TITLES[game.phase]}</b>`,
      '',
      `🃏 Стол: ${game.board.length ? '<b>' + cardsToString(game.board) + '</b>' : '— (карты ещё не открыты)'}`,
      ''
    ];
    game.players.forEach((p, i) => {
      const hand = game.board.length >= 3 ? ' · ' + evaluateBest(p.cards.concat(game.board)).name : '';
      lines.push(`<b>${game.chances[i]}%</b> ${escapeHtml(p.name)}: ${cardsToString(p.cards)}${hand}`);
    });
    return lines.join('\n');
  }

  async finishGame(game) {
    const result = showdown(game.players, game.board);
    const stats = await this.loadStats();
    for (const p of game.players) {
      const s = stats[p.id] || { name: p.name, hands: 0, wins: 0 };
      s.name = p.name;
      s.hands += 1;
      if (result.winners.includes(p.id)) s.wins += 1;
      stats[p.id] = s;
    }
    await this.saveStats(stats);

    const lines = [
      `🎰 <b>LUDOMAN SPIN</b> — раздача #${game.handNo} · <b>Вскрытие</b>`,
      '',
      `🃏 Стол: <b>${cardsToString(game.board)}</b>`,
      ''
    ];
    for (const r of result.results) {
      const p = game.players.find(x => x.id === r.id);
      const won = result.winners.includes(r.id);
      lines.push(`${won ? '🏆' : '▫️'} ${escapeHtml(p.name)}: ${cardsToString(p.cards)} · ${r.best.name}`);
    }
    const winnerNames = result.winners.map(id => escapeHtml(game.players.find(p => p.id === id).name));
    lines.push('',
      result.winners.length > 1
        ? `🤝 Ничья: ${winnerNames.join(', ')}`
        : `👑 Победа: <b>${winnerNames[0]}</b>!`,
      '',
      'Ещё раз — /ludoman_spin · рейтинг — /ludoman_top');

    await this.editHtml(game.chatId, game.messageId, lines.join('\n'), []);
    await this.clearGame();
    return result;
  }

  // ---------- команды ----------

  async handleTop(chatId) {
    const stats = await this.loadStats();
    const rows = Object.keys(stats).filter(k => !k.startsWith('__')).map(k => stats[k])
      .sort((a, b) => (b.wins - a.wins) || (a.hands - b.hands));
    if (!rows.length) {
      await this.sendHtml(chatId, 'Пока никто не играл. Начни: /ludoman_spin');
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = ['🏆 <b>Рейтинг лудоманов</b>', ''];
    rows.forEach((r, i) => {
      lines.push(`${medals[i] || (i + 1) + '.'} ${escapeHtml(r.name)} — побед <b>${r.wins}</b> из ${r.hands}`);
    });
    await this.sendHtml(chatId, lines.join('\n'));
  }

  async handleCancel(chatId) {
    const game = await this.storage.get('game');
    if (!game) {
      await this.sendHtml(chatId, 'Активной игры нет.');
      return;
    }
    await this.storage.deleteAlarm();
    await this.clearGame();
    await this.editHtml(chatId, game.messageId, `🎰 Раздача #${game.handNo} отменена.`, []);
  }
}
