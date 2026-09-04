// ==================== Durable Object: покерный стол одного чата ====================
// Один объект на чат: хранит лобби/раздачу/фишки, будильник (alarm) ровно
// через 30 секунд раздаёт карты. Все апдейты чата обрабатываются строго
// по очереди, поэтому гонок между кликами нет.

import { newDeck, cardsToString, evaluateBest, showdown } from './poker.js';

export const BOT_VERSION = '2026.09.04-3';

export const JOIN_SECONDS = 30;
export const START_CHIPS = 1000;
export const ANTE = 100;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;

const PHASE_TITLES = { preflop: 'Префлоп', flop: 'Флоп', turn: 'Тёрн', river: 'Ривер', showdown: 'Вскрытие' };
const NEXT_BUTTON = { preflop: '▶️ Открыть флоп', flop: '▶️ Открыть тёрн', turn: '▶️ Открыть ривер', river: '🃏 Вскрываемся!' };

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

  // ---------- точки входа ----------

  async fetch(request) {
    const update = await request.json();
    await this.ctx.blockConcurrencyWhile(() => this.handleUpdate(update));
    return new Response('ok');
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const game = await this.storage.get('game');
      if (game && game.phase === 'lobby') await this.dealGame(game);
    });
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

  answer(callbackId, text, alert) {
    const payload = { callback_query_id: callbackId };
    if (text) payload.text = text;
    if (alert) payload.show_alert = true;
    return this.tg('answerCallbackQuery', payload);
  }

  // ---------- хранилище ----------

  loadBanks() { return this.storage.get('banks').then(b => b || {}); }
  saveBanks(banks) { return this.storage.put('banks', banks); }
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
        '/ludoman_spin — начать раздачу (30 сек на сбор игроков)\n' +
        '/ludoman_top — рейтинг по фишкам\n' +
        '/ludoman_cancel — отменить текущую раздачу\n\n' +
        'Добавь меня в группу и позови друзей.');
    }
  }

  async handleCallback(cb) {
    const [action, handStr] = String(cb.data || '').split(':');
    const handNo = Number(handStr);
    const game = await this.storage.get('game');
    if (!game || game.handNo !== handNo) {
      await this.answer(cb.id, 'Эта раздача уже закончена');
      return;
    }
    if (action === 'j') {
      if (game.phase !== 'lobby') await this.answer(cb.id, 'Карты уже розданы — жди следующую раздачу');
      else await this.handleJoin(game, cb.from, cb.id);
    } else if (action === 'c') {
      if (game.phase === 'lobby') await this.answer(cb.id, 'Карты ещё не розданы');
      else await this.handleShowCards(game, cb.from, cb.id);
    } else if (action === 'n') {
      if (game.phase === 'lobby') await this.answer(cb.id, 'Сначала соберём игроков');
      else await this.handleNext(game, cb.from, cb.id);
    } else {
      await this.answer(cb.id, '');
    }
  }

  // ---------- лобби ----------

  renderLobby(game) {
    const left = Math.max(0, Math.round((game.deadline - this.now()) / 1000));
    const lines = [
      `🎰 <b>LUDOMAN SPIN</b> — раздача #${game.handNo}`,
      `Техасский холдем, взнос ${ANTE} фишек.`,
      '',
      `⏳ Сбор игроков: ${JOIN_SECONDS} сек (осталось ${left}).`,
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
      await this.sendHtml(chatId, `Игра уже идёт (раздача #${existing.handNo}). Доиграйте её или /ludoman_cancel.`);
      return existing;
    }
    const banks = await this.loadBanks();
    const handNo = (banks.__handNo || 0) + 1;
    banks.__handNo = handNo;
    await this.saveBanks(banks);

    const game = {
      chatId, messageId: null, phase: 'lobby', handNo,
      deadline: this.now() + JOIN_SECONDS * 1000,
      players: [{ id: user.id, name: displayName(user), cards: [] }],
      deck: [], board: [], pot: 0
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
    await this.saveGame(game);
    await this.editHtml(game.chatId, game.messageId, this.renderLobby(game), this.lobbyKeyboard(game));
    const left = Math.max(0, Math.round((game.deadline - this.now()) / 1000));
    await this.answer(callbackId, `Ты в игре! Карты раздадим через ${left} сек`);
  }

  // ---------- раздача ----------

  async dealGame(game) {
    if (game.players.length < MIN_PLAYERS) {
      await this.editHtml(game.chatId, game.messageId,
        `🎰 <b>LUDOMAN SPIN</b> — раздача #${game.handNo}\n\n` +
        `😴 Не набралось игроков (нужно минимум ${MIN_PLAYERS}). Попробуйте ещё раз: /ludoman_spin`);
      await this.clearGame();
      return game;
    }
    const banks = await this.loadBanks();
    game.pot = 0;
    for (const p of game.players) {
      const entry = banks[p.id] || { name: p.name, chips: START_CHIPS, hands: 0, wins: 0 };
      entry.name = p.name;
      if (entry.chips < ANTE) {
        entry.chips = START_CHIPS; // спонсорская помощь лудоману
        p.rebuy = true;
      }
      entry.chips -= ANTE;
      entry.hands += 1;
      game.pot += ANTE;
      banks[p.id] = entry;
      p.chips = entry.chips;
    }
    await this.saveBanks(banks);

    game.deck = newDeck();
    for (const p of game.players) p.cards = [game.deck.pop(), game.deck.pop()];
    game.board = [];
    game.phase = 'preflop';
    await this.saveGame(game);
    await this.editHtml(game.chatId, game.messageId, this.renderTable(game), this.tableKeyboard(game));
    return game;
  }

  renderTable(game) {
    const lines = [
      `🎰 <b>LUDOMAN SPIN</b> — раздача #${game.handNo} · <b>${PHASE_TITLES[game.phase]}</b>`,
      `💰 Банк: <b>${game.pot}</b>`,
      '',
      `🃏 Стол: ${game.board.length ? '<b>' + cardsToString(game.board) + '</b>' : '— (карты ещё не открыты)'}`,
      '',
      '<b>Игроки:</b>'
    ];
    for (const p of game.players) {
      lines.push(`• ${escapeHtml(p.name)} — ${p.chips} 🪙${p.rebuy ? ' (получил новый стек)' : ''}`);
    }
    lines.push('', 'Свои карты смотри по кнопке — их видишь только ты. Любой игрок может открыть следующую улицу.');
    return lines.join('\n');
  }

  tableKeyboard(game) {
    return [
      [{ text: '👀 Мои карты', callback_data: `c:${game.handNo}` }],
      [{ text: NEXT_BUTTON[game.phase], callback_data: `n:${game.handNo}` }]
    ];
  }

  async handleShowCards(game, user, callbackId) {
    const player = game.players.find(p => p.id === user.id);
    if (!player) {
      await this.answer(callbackId, 'Ты не за столом в этой раздаче', true);
      return;
    }
    let text = 'Твои карты: ' + cardsToString(player.cards);
    if (game.board.length >= 3) {
      text += '\nСейчас у тебя: ' + evaluateBest(player.cards.concat(game.board)).name;
    }
    await this.answer(callbackId, text, true);
  }

  async handleNext(game, user, callbackId) {
    if (!game.players.some(p => p.id === user.id)) {
      await this.answer(callbackId, 'Улицы открывают только игроки за столом');
      return;
    }
    if (game.phase === 'preflop') {
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
      await this.answer(callbackId, 'Вскрываемся!');
      return;
    } else {
      await this.answer(callbackId, 'Раздача уже закончена');
      return;
    }
    await this.saveGame(game);
    await this.editHtml(game.chatId, game.messageId, this.renderTable(game), this.tableKeyboard(game));
    await this.answer(callbackId, `${PHASE_TITLES[game.phase]}: ${cardsToString(game.board)}`);
  }

  async finishGame(game) {
    const result = showdown(game.players, game.board);
    const banks = await this.loadBanks();
    const share = Math.floor(game.pot / result.winners.length);
    for (const id of result.winners) {
      banks[id].chips += share;
      banks[id].wins += 1;
    }
    await this.saveBanks(banks);

    const lines = [
      `🎰 <b>LUDOMAN SPIN</b> — раздача #${game.handNo} · <b>Вскрытие</b>`,
      `🃏 Стол: <b>${cardsToString(game.board)}</b>`,
      ''
    ];
    for (const r of result.results) {
      const p = game.players.find(x => x.id === r.id);
      const won = result.winners.includes(r.id);
      lines.push(`${won ? '🏆 ' : '• '}${escapeHtml(p.name)}: ${cardsToString(p.cards)} — ${r.best.name}${won ? ` <b>+${share}</b>` : ''}`);
    }
    const winnerNames = result.winners.map(id => escapeHtml(game.players.find(p => p.id === id).name));
    lines.push('',
      result.winners.length > 1
        ? `🤝 Банк ${game.pot} делят: ${winnerNames.join(', ')}`
        : `💰 Банк ${game.pot} забирает <b>${winnerNames[0]}</b>!`,
      '',
      'Стеки: ' + game.players.map(p => `${escapeHtml(p.name)} ${banks[p.id].chips}`).join(' · '),
      'Ещё раз — /ludoman_spin · рейтинг — /ludoman_top');

    await this.editHtml(game.chatId, game.messageId, lines.join('\n'), []);
    await this.clearGame();
    return result;
  }

  // ---------- команды ----------

  async handleTop(chatId) {
    const banks = await this.loadBanks();
    const rows = Object.keys(banks).filter(k => !k.startsWith('__')).map(k => banks[k]).sort((a, b) => b.chips - a.chips);
    if (!rows.length) {
      await this.sendHtml(chatId, 'Пока никто не играл. Начни: /ludoman_spin');
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = ['🏆 <b>Рейтинг лудоманов</b>', ''];
    rows.forEach((r, i) => {
      lines.push(`${medals[i] || (i + 1) + '.'} ${escapeHtml(r.name)} — <b>${r.chips}</b> 🪙 (побед ${r.wins} из ${r.hands})`);
    });
    await this.sendHtml(chatId, lines.join('\n'));
  }

  async handleCancel(chatId) {
    const game = await this.storage.get('game');
    if (!game) {
      await this.sendHtml(chatId, 'Активной игры нет.');
      return;
    }
    if (game.phase !== 'lobby') {
      const banks = await this.loadBanks();
      for (const p of game.players) {
        if (banks[p.id]) { banks[p.id].chips += ANTE; banks[p.id].hands -= 1; }
      }
      await this.saveBanks(banks);
    }
    await this.storage.deleteAlarm();
    await this.clearGame();
    await this.editHtml(chatId, game.messageId, `🎰 Раздача #${game.handNo} отменена.`, []);
  }
}
