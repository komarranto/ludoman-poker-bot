// ==================== LUDOMAN SPIN — покерный бот для Telegram ====================
//
// ⚠️ Токен бота и секрет вебхука живут в ОТДЕЛЬНОМ файле Config.gs
// (в этом же проекте Apps Script) — см. Config.example.gs. При обновлении
// бота заменяются только Bot.gs и Poker.gs, Config.gs не трогается.
//
// Ожидаемые константы в Config.gs:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, WEB_APP_URL
//
// Как играть: в групповом чате пишем /ludoman_spin → 30 секунд на вход по
// кнопке → всем по 2 карты (смотрят через кнопку «Мои карты», видит только
// нажавший) → флоп / тёрн / ривер открываются кнопкой прямо в этом же
// сообщении → вскрытие, победитель забирает банк фишек.

const BOT_VERSION = '2026.09.04-1';

const JOIN_SECONDS = 30;      // сколько секунд собираем игроков
const START_CHIPS = 1000;     // стартовый стек фишек у нового игрока
const ANTE = 100;             // взнос в банк с каждого за раздачу
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10;

const PHASES = ['lobby', 'preflop', 'flop', 'turn', 'river', 'showdown'];
const PHASE_TITLES = {
  preflop: 'Префлоп',
  flop: 'Флоп',
  turn: 'Тёрн',
  river: 'Ривер',
  showdown: 'Вскрытие'
};
const NEXT_BUTTON = {
  preflop: '▶️ Открыть флоп',
  flop: '▶️ Открыть тёрн',
  turn: '▶️ Открыть ривер',
  river: '🃏 Вскрываемся!'
};

// ==================== TELEGRAM API ====================

function tg(method, payload) {
  const url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/' + method;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  let result;
  try {
    result = JSON.parse(response.getContentText());
  } catch (err) {
    result = { ok: false, description: 'bad json: ' + response.getContentText() };
  }
  if (!result.ok) {
    Logger.log('❌ Telegram ' + method + ': ' + result.description);
  }
  return result;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function displayName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || (user.username ? '@' + user.username : 'Игрок ' + user.id);
}

function sendHtml(chatId, text, keyboard) {
  const payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  return tg('sendMessage', payload);
}

function editHtml(chatId, messageId, text, keyboard) {
  const payload = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' };
  payload.reply_markup = { inline_keyboard: keyboard || [] };
  return tg('editMessageText', payload);
}

function answerCallback(callbackId, text, alert) {
  const payload = { callback_query_id: callbackId };
  if (text) payload.text = text;
  if (alert) payload.show_alert = true;
  return tg('answerCallbackQuery', payload);
}

// ==================== ХРАНИЛИЩЕ ====================

function gameKey(chatId) { return 'game_' + chatId; }
function banksKey(chatId) { return 'banks_' + chatId; }

function loadJson(key, fallback) {
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function saveJson(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(value));
}

function deleteKey(key) {
  PropertiesService.getScriptProperties().deleteProperty(key);
}

function loadGame(chatId) { return loadJson(gameKey(chatId), null); }
function saveGame(game) { saveJson(gameKey(game.chatId), game); }
function clearGame(chatId) { deleteKey(gameKey(chatId)); }

function loadBanks(chatId) { return loadJson(banksKey(chatId), {}); }
function saveBanks(chatId, banks) { saveJson(banksKey(chatId), banks); }

/** Выполнить fn под глобальной блокировкой скрипта */
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    Logger.log('⚠️ Не удалось получить блокировку');
    return null;
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ==================== ЛОББИ ====================

function renderLobby(game) {
  const left = Math.max(0, Math.round((game.deadline - Date.now()) / 1000));
  const lines = [];
  lines.push('🎰 <b>LUDOMAN SPIN</b> — раздача #' + game.handNo);
  lines.push('Техасский холдем, взнос ' + ANTE + ' фишек.');
  lines.push('');
  lines.push('⏳ Сбор игроков: ~' + JOIN_SECONDS + ' сек (осталось ~' + left + ').');
  lines.push('');
  if (game.players.length) {
    lines.push('<b>За столом (' + game.players.length + '):</b>');
    game.players.forEach((p, i) => lines.push((i + 1) + '. ' + escapeHtml(p.name)));
  } else {
    lines.push('Пока никого. Жми кнопку!');
  }
  return lines.join('\n');
}

function lobbyKeyboard(game) {
  return [[{ text: '🙋 Присоединиться (' + game.players.length + ')', callback_data: 'j:' + game.messageId }]];
}

function startLobby(chat, user) {
  const chatId = chat.id;
  const existing = loadGame(chatId);
  if (existing) {
    sendHtml(chatId, 'Игра уже идёт (раздача #' + existing.handNo + '). Доиграйте её или /ludoman_cancel.');
    return existing;
  }

  const banks = loadBanks(chatId);
  const handNo = (banks.__handNo || 0) + 1;
  banks.__handNo = handNo;
  saveBanks(chatId, banks);

  const game = {
    chatId: chatId,
    messageId: null,
    phase: 'lobby',
    handNo: handNo,
    createdAt: Date.now(),
    deadline: Date.now() + JOIN_SECONDS * 1000,
    players: [{ id: user.id, name: displayName(user), cards: [] }],
    deck: [],
    board: [],
    pot: 0
  };

  const sent = sendHtml(chatId, renderLobby(game), [[{ text: '🙋 Присоединиться (1)', callback_data: 'j:0' }]]);
  if (!sent.ok) return null;
  game.messageId = sent.result.message_id;
  editHtml(chatId, game.messageId, renderLobby(game), lobbyKeyboard(game));
  saveGame(game);

  // Таймер: триггер сработает через ~30–60 сек (точность Apps Script — до минуты).
  // Плюс любой клик по кнопке после дедлайна тоже запускает раздачу.
  try {
    ScriptApp.newTrigger('onLobbyTimeout').timeBased().after(JOIN_SECONDS * 1000 + 1000).create();
  } catch (err) {
    Logger.log('⚠️ Не удалось создать триггер: ' + err);
  }
  return game;
}

function handleJoin(game, user, callbackId) {
  if (game.players.some(p => p.id === user.id)) {
    answerCallback(callbackId, 'Ты уже за столом 😉');
    return;
  }
  if (game.players.length >= MAX_PLAYERS) {
    answerCallback(callbackId, 'Стол полон (' + MAX_PLAYERS + ')');
    return;
  }
  game.players.push({ id: user.id, name: displayName(user), cards: [] });
  saveGame(game);
  editHtml(game.chatId, game.messageId, renderLobby(game), lobbyKeyboard(game));
  answerCallback(callbackId, 'Ты в игре! Карты раздадим через ' + Math.max(0, Math.round((game.deadline - Date.now()) / 1000)) + ' сек');
}

// ==================== РАЗДАЧА ====================

/** Списать анте, раздать по 2 карты, перейти в префлоп */
function dealGame(game) {
  if (game.players.length < MIN_PLAYERS) {
    editHtml(game.chatId, game.messageId,
      '🎰 <b>LUDOMAN SPIN</b> — раздача #' + game.handNo + '\n\n' +
      '😴 Не набралось игроков (нужно минимум ' + MIN_PLAYERS + '). Попробуйте ещё раз: /ludoman_spin');
    clearGame(game.chatId);
    return game;
  }

  const banks = loadBanks(game.chatId);
  game.pot = 0;
  game.players.forEach(p => {
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
  });
  saveBanks(game.chatId, banks);

  game.deck = newDeck();
  game.players.forEach(p => { p.cards = [game.deck.pop(), game.deck.pop()]; });
  game.board = [];
  game.phase = 'preflop';
  saveGame(game);
  editHtml(game.chatId, game.messageId, renderTable(game), tableKeyboard(game));
  return game;
}

function renderTable(game) {
  const lines = [];
  lines.push('🎰 <b>LUDOMAN SPIN</b> — раздача #' + game.handNo + ' · <b>' + PHASE_TITLES[game.phase] + '</b>');
  lines.push('💰 Банк: <b>' + game.pot + '</b>');
  lines.push('');
  lines.push('🃏 Стол: ' + (game.board.length ? '<b>' + cardsToString(game.board) + '</b>' : '— (карты ещё не открыты)'));
  lines.push('');
  lines.push('<b>Игроки:</b>');
  game.players.forEach(p => {
    lines.push('• ' + escapeHtml(p.name) + ' — ' + p.chips + ' 🪙' + (p.rebuy ? ' (получил новый стек)' : ''));
  });
  lines.push('');
  lines.push('Свои карты смотри по кнопке — их видишь только ты. Любой игрок может открыть следующую улицу.');
  return lines.join('\n');
}

function tableKeyboard(game) {
  return [
    [{ text: '👀 Мои карты', callback_data: 'c:' + game.messageId }],
    [{ text: NEXT_BUTTON[game.phase], callback_data: 'n:' + game.messageId }]
  ];
}

function handleShowCards(game, user, callbackId) {
  const player = game.players.find(p => p.id === user.id);
  if (!player) {
    answerCallback(callbackId, 'Ты не за столом в этой раздаче', true);
    return;
  }
  let text = 'Твои карты: ' + cardsToString(player.cards);
  if (game.board.length >= 3) {
    const best = evaluateBest(player.cards.concat(game.board));
    text += '\nСейчас у тебя: ' + best.name;
  }
  answerCallback(callbackId, text, true);
}

function handleNext(game, user, callbackId) {
  if (!game.players.some(p => p.id === user.id)) {
    answerCallback(callbackId, 'Улицы открывают только игроки за столом');
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
    finishGame(game);
    answerCallback(callbackId, 'Вскрываемся!');
    return;
  } else {
    answerCallback(callbackId, 'Раздача уже закончена');
    return;
  }
  saveGame(game);
  editHtml(game.chatId, game.messageId, renderTable(game), tableKeyboard(game));
  answerCallback(callbackId, PHASE_TITLES[game.phase] + ': ' + cardsToString(game.board));
}

function finishGame(game) {
  const result = showdown(game.players, game.board);
  const banks = loadBanks(game.chatId);
  const share = Math.floor(game.pot / result.winners.length);
  result.winners.forEach(id => {
    banks[id].chips += share;
    banks[id].wins += 1;
  });
  saveBanks(game.chatId, banks);
  game.phase = 'showdown';

  const lines = [];
  lines.push('🎰 <b>LUDOMAN SPIN</b> — раздача #' + game.handNo + ' · <b>Вскрытие</b>');
  lines.push('🃏 Стол: <b>' + cardsToString(game.board) + '</b>');
  lines.push('');
  result.results.forEach(r => {
    const p = game.players.find(x => x.id === r.id);
    const won = result.winners.indexOf(r.id) !== -1;
    lines.push((won ? '🏆 ' : '• ') + escapeHtml(p.name) + ': ' + cardsToString(p.cards) + ' — ' + r.best.name +
      (won ? ' <b>+' + share + '</b>' : ''));
  });
  lines.push('');
  const winnerNames = result.winners.map(id => escapeHtml(game.players.find(p => p.id === id).name));
  lines.push(result.winners.length > 1
    ? '🤝 Банк ' + game.pot + ' делят: ' + winnerNames.join(', ')
    : '💰 Банк ' + game.pot + ' забирает <b>' + winnerNames[0] + '</b>!');
  lines.push('');
  lines.push('Стеки: ' + game.players.map(p => escapeHtml(p.name) + ' ' + banks[p.id].chips).join(' · '));
  lines.push('Ещё раз — /ludoman_spin · рейтинг — /ludoman_top');

  editHtml(game.chatId, game.messageId, lines.join('\n'), []);
  clearGame(game.chatId);
  return result;
}

/** Если лобби в этом чате уже просрочено — раздать карты. Возвращает актуальную игру. */
function dealIfExpired(game) {
  if (game && game.phase === 'lobby' && Date.now() >= game.deadline) {
    return dealGame(game);
  }
  return game;
}

/** Обработчик таймера: раздаёт все просроченные лобби и чистит отработавшие триггеры */
function onLobbyTimeout() {
  withLock(function () {
    const props = PropertiesService.getScriptProperties();
    const keys = props.getKeys().filter(k => k.indexOf('game_') === 0);
    let pending = 0;
    keys.forEach(key => {
      const game = loadJson(key, null);
      if (!game || game.phase !== 'lobby') return;
      if (Date.now() >= game.deadline) {
        dealGame(game);
      } else {
        pending++;
      }
    });
    if (pending === 0) {
      ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === 'onLobbyTimeout') ScriptApp.deleteTrigger(t);
      });
    }
  });
}

// ==================== КОМАНДЫ ====================

function handleTop(chatId) {
  const banks = loadBanks(chatId);
  const rows = Object.keys(banks)
    .filter(k => k.indexOf('__') !== 0)
    .map(k => banks[k])
    .sort((a, b) => b.chips - a.chips);
  if (!rows.length) {
    sendHtml(chatId, 'Пока никто не играл. Начни: /ludoman_spin');
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  const lines = ['🏆 <b>Рейтинг лудоманов</b>', ''];
  rows.forEach((r, i) => {
    lines.push((medals[i] || (i + 1) + '.') + ' ' + escapeHtml(r.name) + ' — <b>' + r.chips + '</b> 🪙 (побед ' + r.wins + ' из ' + r.hands + ')');
  });
  sendHtml(chatId, lines.join('\n'));
}

function handleCancel(chatId) {
  const game = loadGame(chatId);
  if (!game) {
    sendHtml(chatId, 'Активной игры нет.');
    return;
  }
  if (game.phase !== 'lobby') {
    // Возвращаем анте
    const banks = loadBanks(chatId);
    game.players.forEach(p => { if (banks[p.id]) { banks[p.id].chips += ANTE; banks[p.id].hands -= 1; } });
    saveBanks(chatId, banks);
  }
  clearGame(chatId);
  editHtml(chatId, game.messageId, '🎰 Раздача #' + game.handNo + ' отменена.', []);
}

function handleBotVersion(chatId) {
  sendHtml(chatId, '🤖 Ludoman bot, версия <b>' + BOT_VERSION + '</b>');
}

// ==================== ВЕБХУК ====================

function doPost(e) {
  try {
    handleTelegramUpdate(e);
  } catch (error) {
    Logger.log('❌ Ошибка в doPost: ' + error);
  }
  // Намеренно без return: ContentService-ответ Apps Script отдаёт через 302,
  // Telegram редиректы не следует и ретраит апдейт часами.
}

function doGet() {
  return ContentService.createTextOutput('Ludoman bot ' + BOT_VERSION + ' is alive');
}

function handleTelegramUpdate(e) {
  if (!e.parameter || e.parameter.secret !== TELEGRAM_WEBHOOK_SECRET) {
    Logger.log('⚠️ Отклонён запрос на вебхук с неверным secret');
    return 'ignored';
  }
  const update = JSON.parse(e.postData.contents);
  if (!markUpdateProcessed(update.update_id)) {
    return 'ok';
  }

  if (update.callback_query) {
    withLock(function () { handleCallback(update.callback_query); });
    return 'ok';
  }

  const message = update.message;
  if (!message || !message.text) return 'ok';

  // /команда или /команда@botname — оставляем только имя команды
  const command = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  const chatId = message.chat.id;

  withLock(function () {
    const game = dealIfExpired(loadGame(chatId));
    if (command === '/ludoman_spin') {
      startLobby(message.chat, message.from);
    } else if (command === '/ludoman_top') {
      handleTop(chatId);
    } else if (command === '/ludoman_cancel') {
      handleCancel(chatId);
    } else if (command === '/bot_version') {
      handleBotVersion(chatId);
    } else if (command === '/start' || command === '/help') {
      sendHtml(chatId, '🎰 <b>Ludoman Spin</b> — техасский холдем прямо в чате.\n\n' +
        '/ludoman_spin — начать раздачу (30 сек на сбор игроков)\n' +
        '/ludoman_top — рейтинг по фишкам\n' +
        '/ludoman_cancel — отменить текущую раздачу\n\n' +
        'Добавь меня в группу и позови друзей.');
    }
    return game;
  });
  return 'ok';
}

function handleCallback(cb) {
  const chatId = cb.message && cb.message.chat.id;
  const parts = String(cb.data || '').split(':');
  const action = parts[0];
  const messageId = Number(parts[1]);

  let game = loadGame(chatId);
  if (!game || game.messageId !== messageId) {
    answerCallback(cb.id, 'Эта раздача уже закончена');
    return;
  }
  game = dealIfExpired(game);
  if (!game || !loadGame(chatId)) {
    answerCallback(cb.id, 'Сбор окончен');
    return;
  }

  if (action === 'j') {
    if (game.phase !== 'lobby') {
      answerCallback(cb.id, 'Карты уже розданы — жди следующую раздачу');
    } else {
      handleJoin(game, cb.from, cb.id);
    }
  } else if (action === 'c') {
    if (game.phase === 'lobby') {
      answerCallback(cb.id, 'Карты ещё не розданы');
    } else {
      handleShowCards(game, cb.from, cb.id);
    }
  } else if (action === 'n') {
    if (game.phase === 'lobby') {
      answerCallback(cb.id, 'Сначала соберём игроков');
    } else {
      handleNext(game, cb.from, cb.id);
    }
  } else {
    answerCallback(cb.id, '');
  }
}

/** Защита от повторной доставки апдейтов Telegram */
function markUpdateProcessed(updateId) {
  if (updateId === undefined || updateId === null) return true;
  const props = PropertiesService.getScriptProperties();
  let recent = loadJson('recentTelegramUpdateIds', []);
  const id = String(updateId);
  if (recent.includes(id)) return false;
  recent.push(id);
  if (recent.length > 200) recent = recent.slice(recent.length - 200);
  props.setProperty('recentTelegramUpdateIds', JSON.stringify(recent));
  return true;
}

// ==================== РАЗОВАЯ НАСТРОЙКА ====================

/**
 * Запустить один раз из редактора Apps Script (без аргументов): выдаёт
 * скрипту права (UrlFetch, триггеры, свойства) и регистрирует вебхук
 * и список команд в Telegram. Адрес берётся из WEB_APP_URL в Config.gs.
 */
function setupTelegramWebhook() {
  const webAppUrl = (typeof WEB_APP_URL === 'string') ? WEB_APP_URL : '';
  if (!webAppUrl || webAppUrl.indexOf('script.google.com/macros/s/') === -1) {
    throw new Error('WEB_APP_URL не задан в Config.gs (адрес вида https://script.google.com/macros/s/.../exec).');
  }
  const separator = webAppUrl.includes('?') ? '&' : '?';
  const hookUrl = webAppUrl + separator + 'secret=' + encodeURIComponent(TELEGRAM_WEBHOOK_SECRET);

  Logger.log('setWebhook: ' + JSON.stringify(tg('setWebhook', {
    url: hookUrl,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  })));
  Logger.log('setMyCommands: ' + JSON.stringify(tg('setMyCommands', { commands: botCommands() })));

  // Прогрев прав на триггеры и свойства — чтобы doPost потом не упал на consent
  PropertiesService.getScriptProperties().setProperty('setupAt', new Date().toISOString());
  ScriptApp.getProjectTriggers();
  Logger.log('✅ Готово. Проверь в чате: /bot_version');
}

function botCommands() {
  return [
    { command: 'ludoman_spin', description: 'Раздача в техасский холдем: 30 сек на вход' },
    { command: 'ludoman_top', description: 'Рейтинг по фишкам' },
    { command: 'ludoman_cancel', description: 'Отменить текущую раздачу' },
    { command: 'bot_version', description: 'Какая версия бота работает' }
  ];
}
