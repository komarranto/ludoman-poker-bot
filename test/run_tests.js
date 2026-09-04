// Локальные тесты: node test/run_tests.js
// 1) оценка покерных комбинаций; 2) полный прогон игры через фейковый Telegram/Apps Script.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (err) { console.log('  ❌ ' + name + '\n     ' + err.message); process.exitCode = 1; }
}

// ---------- 1. Комбинации ----------
const P = require(path.join(root, 'Poker.js'));
const best = s => P.evaluateBest(P.parseCards(s));

console.log('Комбинации:');
test('флеш-рояль', () => assert.strictEqual(best('A♠ K♠ Q♠ J♠ 10♠ 2♥ 3♦').name, 'Флеш-рояль'));
test('стрит-флеш', () => assert.strictEqual(best('9♥ 8♥ 7♥ 6♥ 5♥ A♠ A♦').name, 'Стрит-флеш'));
test('каре бьёт фулл-хаус', () => assert.ok(P.compareScores(best('7♠ 7♥ 7♦ 7♣ K♠ K♥ 2♦').score, best('K♠ K♥ K♦ 7♣ 7♠ 2♥ 3♦').score) > 0));
test('фулл-хаус', () => assert.strictEqual(best('K♠ K♥ K♦ 7♣ 7♠ 2♥ 3♦').name, 'Фулл-хаус'));
test('флеш', () => assert.strictEqual(best('2♣ 9♣ J♣ 4♣ K♣ A♦ A♥').name, 'Флеш'));
test('стрит', () => assert.strictEqual(best('5♠ 6♥ 7♦ 8♣ 9♠ 2♥ 2♦').name, 'Стрит'));
test('колесо A-2-3-4-5', () => { const b = best('A♠ 2♥ 3♦ 4♣ 5♠ K♥ Q♦'); assert.strictEqual(b.name, 'Стрит'); assert.strictEqual(b.score[1], 5); });
test('сет', () => assert.strictEqual(best('Q♠ Q♥ Q♦ 4♣ 9♠ 2♥ 7♦').name, 'Сет'));
test('две пары', () => assert.strictEqual(best('Q♠ Q♥ 4♦ 4♣ 9♠ 2♥ 7♦').name, 'Две пары'));
test('пара', () => assert.strictEqual(best('Q♠ Q♥ 5♦ 4♣ 9♠ 2♥ 7♦').name, 'Пара'));
test('старшая карта', () => assert.strictEqual(best('Q♠ 3♥ 5♦ 4♣ 9♠ 2♥ 7♦').name, 'Старшая карта'));
test('кикер решает при одинаковой паре', () => assert.ok(P.compareScores(best('A♠ A♥ K♦ 4♣ 9♠ 2♥ 7♦').score, best('A♣ A♦ Q♦ 4♥ 9♣ 2♠ 7♣').score) > 0));
test('лучшие 5 из 7: две пары на борде + карман', () => { const b = best('K♠ K♥ 9♦ 9♣ 2♠ 2♥ A♦'); assert.deepStrictEqual(b.score, [2, 13, 9, 14]); });
test('ничья делит банк', () => {
  const board = P.parseCards('A♠ K♥ Q♦ J♣ 10♠');
  const r = P.showdown([{ id: 1, cards: P.parseCards('2♥ 3♦') }, { id: 2, cards: P.parseCards('4♥ 5♦') }], board);
  assert.deepStrictEqual(r.winners, [1, 2]);
});
test('колода 52 уникальные карты', () => { const d = P.newDeck(); assert.strictEqual(new Set(d.map(P.cardToString)).size, 52); });

// ---------- 2. Прогон игры с фейковым окружением ----------
console.log('Игра целиком:');
const calls = [];
const store = {};
let now = 1_000_000;
let msgCounter = 100;
const env = {
  console,
  Date: { now: () => now },
  Math, JSON, Object, Number, String, Array, Set, encodeURIComponent, parseInt,
  Logger: { log: () => {} },
  UrlFetchApp: {
    fetch: (url, opts) => {
      const method = url.split('/').pop();
      const payload = JSON.parse(opts.payload);
      calls.push({ method, payload });
      const result = method === 'sendMessage' ? { message_id: ++msgCounter } : true;
      return { getContentText: () => JSON.stringify({ ok: true, result }) };
    }
  },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (k in store ? store[k] : null),
    setProperty: (k, v) => { store[k] = v; },
    deleteProperty: k => { delete store[k]; },
    getKeys: () => Object.keys(store)
  }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  ScriptApp: {
    triggers: [],
    newTrigger(fn) { return { timeBased: () => ({ after: () => ({ create: () => { env.ScriptApp.triggers.push({ getHandlerFunction: () => fn }); } }) }) }; },
    getProjectTriggers() { return this.triggers.slice(); },
    deleteTrigger(t) { this.triggers = this.triggers.filter(x => x !== t); }
  },
  ContentService: { createTextOutput: t => t },
  TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_WEBHOOK_SECRET: 's3cret', WEB_APP_URL: '',
  module: undefined
};
env.Date.now = () => now;
vm.createContext(env);
vm.runInContext(fs.readFileSync(path.join(root, 'Poker.js'), 'utf8'), env, { filename: 'Poker.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'Bot.js'), 'utf8'), env, { filename: 'Bot.js' });

let updateId = 1;
const CHAT = -100500;
const chat = { id: CHAT, type: 'supergroup' };
const users = { 1: { id: 1, first_name: 'Антон' }, 2: { id: 2, first_name: 'Вика', last_name: 'К' }, 3: { id: 3, username: 'third' }, 99: { id: 99, first_name: 'Зевака' } };
const post = update => env.handleTelegramUpdate({ parameter: { secret: 's3cret' }, postData: { contents: JSON.stringify(Object.assign({ update_id: updateId++ }, update)) } });
const msg = (uid, text) => post({ message: { chat, from: users[uid], text } });
const click = (uid, data, messageId) => post({ callback_query: { id: 'cb' + updateId, from: users[uid], data, message: { chat, message_id: messageId } } });
const lastEdit = () => calls.filter(c => c.method === 'editMessageText').pop().payload;
const lastAnswer = () => calls.filter(c => c.method === 'answerCallbackQuery').pop().payload;

test('неверный секрет отбрасывается', () => {
  const r = env.handleTelegramUpdate({ parameter: { secret: 'wrong' }, postData: { contents: '{}' } });
  assert.strictEqual(r, 'ignored');
});

let game;
test('/ludoman_spin создаёт лобби, автор уже за столом, ставит триггер', () => {
  msg(1, '/ludoman_spin@LudomanBot');
  game = JSON.parse(store['game_' + CHAT]);
  assert.strictEqual(game.phase, 'lobby');
  assert.strictEqual(game.players.length, 1);
  assert.strictEqual(game.messageId, 101);
  assert.strictEqual(env.ScriptApp.triggers.length, 1);
  assert.strictEqual(calls.filter(c => c.method === 'editMessageText').length, 0, 'лобби должно уходить одним sendMessage');
  assert.ok(calls.filter(c => c.method === 'sendMessage').pop().payload.text.includes('Антон'));
});
test('повторный /ludoman_spin не создаёт вторую игру', () => {
  msg(2, '/ludoman_spin');
  assert.strictEqual(JSON.parse(store['game_' + CHAT]).handNo, 1);
  assert.ok(calls.filter(c => c.method === 'sendMessage').pop().payload.text.includes('уже идёт'));
});
test('кнопка «Присоединиться» добавляет игроков, повтор — нет', () => {
  click(2, 'j:1', 101);
  click(3, 'j:1', 101);
  click(2, 'j:1', 101);
  game = JSON.parse(store['game_' + CHAT]);
  assert.strictEqual(game.players.length, 3);
  assert.ok(lastAnswer().text.includes('уже за столом'));
  assert.ok(lastEdit().text.includes('Вика К') && lastEdit().text.includes('@third'));
});
test('до дедлайна карты не раздаются', () => {
  now += 10_000;
  click(1, 'c:1', 101);
  assert.ok(lastAnswer().text.includes('ещё не розданы'));
});
test('таймер раздаёт по 2 карты, списывает анте, удаляет триггер', () => {
  now += 25_000;
  env.onLobbyTimeout();
  game = JSON.parse(store['game_' + CHAT]);
  assert.strictEqual(game.phase, 'preflop');
  assert.ok(game.players.every(p => p.cards.length === 2));
  assert.strictEqual(game.pot, 300);
  assert.strictEqual(game.deck.length, 52 - 6);
  const banks = JSON.parse(store['banks_' + CHAT]);
  assert.strictEqual(banks[1].chips, 900);
  assert.strictEqual(env.ScriptApp.triggers.length, 0);
  assert.ok(lastEdit().text.includes('Префлоп'));
});
test('«Мои карты» показывает alert только игроку', () => {
  click(2, 'c:1', 101);
  const a = lastAnswer();
  assert.strictEqual(a.show_alert, true);
  assert.ok(a.text.includes('Твои карты: ' + env.cardsToString(game.players[1].cards)));
  click(99, 'c:1', 101);
  assert.ok(lastAnswer().text.includes('не за столом'));
});
test('опоздавший не может присоединиться', () => {
  click(99, 'j:1', 101);
  assert.ok(lastAnswer().text.includes('уже розданы'));
});
test('флоп → тёрн → ривер открываются в том же сообщении', () => {
  click(1, 'n:1', 101);
  assert.strictEqual(JSON.parse(store['game_' + CHAT]).board.length, 3);
  assert.ok(lastEdit().text.includes('Флоп'));
  click(2, 'n:1', 101);
  assert.strictEqual(JSON.parse(store['game_' + CHAT]).board.length, 4);
  click(3, 'n:1', 101);
  game = JSON.parse(store['game_' + CHAT]);
  assert.strictEqual(game.board.length, 5);
  assert.strictEqual(game.phase, 'river');
  assert.strictEqual(lastEdit().message_id, 101);
});
test('вскрытие: победитель получает банк, игра очищается', () => {
  const expected = env.showdown(game.players, game.board);
  click(1, 'n:1', 101);
  assert.strictEqual(store['game_' + CHAT], undefined);
  const banks = JSON.parse(store['banks_' + CHAT]);
  const total = [1, 2, 3].reduce((s, id) => s + banks[id].chips, 0);
  assert.strictEqual(total, 3000 - (300 % expected.winners.length));
  expected.winners.forEach(id => assert.ok(banks[id].chips > 900));
  assert.ok(lastEdit().text.includes('🏆'));
});
test('клик по старой раздаче — вежливый отказ', () => {
  click(1, 'n:1', 101);
  assert.ok(lastAnswer().text.includes('уже закончена'));
});
test('/ludoman_top показывает рейтинг', () => {
  msg(1, '/ludoman_top');
  assert.ok(calls.filter(c => c.method === 'sendMessage').pop().payload.text.includes('🥇'));
});
test('лобби из одного игрока по таймеру отменяется', () => {
  msg(1, '/ludoman_spin');
  now += 60_000;
  msg(2, '/ludoman_top'); // любое сообщение после дедлайна = ленивая раздача
  assert.strictEqual(store['game_' + CHAT], undefined);
  assert.ok(calls.filter(c => c.method === 'editMessageText').some(c => c.payload.text.includes('Не набралось')));
});
test('/ludoman_cancel возвращает анте после раздачи', () => {
  msg(1, '/ludoman_spin'); click(2, 'j:3', msgCounter);
  now += 40_000; env.onLobbyTimeout();
  const before = JSON.parse(store['banks_' + CHAT])[1].chips;
  msg(1, '/ludoman_cancel');
  assert.strictEqual(JSON.parse(store['banks_' + CHAT])[1].chips, before + 100);
  assert.strictEqual(store['game_' + CHAT], undefined);
});
test('дубль update_id не обрабатывается дважды', () => {
  const dup = { update_id: 5, message: { chat, from: users[1], text: '/ludoman_top' } };
  const n = calls.length;
  env.handleTelegramUpdate({ parameter: { secret: 's3cret' }, postData: { contents: JSON.stringify(dup) } });
  assert.strictEqual(calls.length, n);
});

console.log('\n' + (process.exitCode ? 'ЕСТЬ ОШИБКИ' : 'Все тесты прошли') + ': ' + passed);
