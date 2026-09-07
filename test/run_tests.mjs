// Локальные тесты: npm test
// 1) оценка покерных комбинаций; 2) полный прогон стола с фейковым Telegram и хранилищем.
import assert from 'node:assert';
import * as P from '../src/poker.js';
import { PokerTable, BOT_PLAYER_ID, BOT_PLAYER_NAME } from '../src/table.js';
import worker from '../src/index.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✅ ' + name); }
  catch (err) { console.log('  ❌ ' + name + '\n     ' + err.message); process.exitCode = 1; }
}

// ---------- 1. Комбинации ----------
const best = s => P.evaluateBest(P.parseCards(s));
console.log('Комбинации:');
await test('флеш-рояль', () => assert.strictEqual(best('A♠ K♠ Q♠ J♠ 10♠ 2♥ 3♦').name, 'Флеш-рояль'));
await test('стрит-флеш', () => assert.strictEqual(best('9♥ 8♥ 7♥ 6♥ 5♥ A♠ A♦').name, 'Стрит-флеш'));
await test('каре бьёт фулл-хаус', () => assert.ok(P.compareScores(best('7♠ 7♥ 7♦ 7♣ K♠ K♥ 2♦').score, best('K♠ K♥ K♦ 7♣ 7♠ 2♥ 3♦').score) > 0));
await test('фулл-хаус', () => assert.strictEqual(best('K♠ K♥ K♦ 7♣ 7♠ 2♥ 3♦').name, 'Фулл-хаус'));
await test('флеш', () => assert.strictEqual(best('2♣ 9♣ J♣ 4♣ K♣ A♦ A♥').name, 'Флеш'));
await test('стрит', () => assert.strictEqual(best('5♠ 6♥ 7♦ 8♣ 9♠ 2♥ 2♦').name, 'Стрит'));
await test('колесо A-2-3-4-5', () => { const b = best('A♠ 2♥ 3♦ 4♣ 5♠ K♥ Q♦'); assert.strictEqual(b.name, 'Стрит'); assert.strictEqual(b.score[1], 5); });
await test('сет', () => assert.strictEqual(best('Q♠ Q♥ Q♦ 4♣ 9♠ 2♥ 7♦').name, 'Сет'));
await test('две пары', () => assert.strictEqual(best('Q♠ Q♥ 4♦ 4♣ 9♠ 2♥ 7♦').name, 'Две пары'));
await test('пара', () => assert.strictEqual(best('Q♠ Q♥ 5♦ 4♣ 9♠ 2♥ 7♦').name, 'Пара'));
await test('старшая карта', () => assert.strictEqual(best('Q♠ 3♥ 5♦ 4♣ 9♠ 2♥ 7♦').name, 'Старшая карта'));
await test('кикер решает при одинаковой паре', () => assert.ok(P.compareScores(best('A♠ A♥ K♦ 4♣ 9♠ 2♥ 7♦').score, best('A♣ A♦ Q♦ 4♥ 9♣ 2♠ 7♣').score) > 0));
await test('лучшие 5 из 7', () => assert.deepStrictEqual(best('K♠ K♥ 9♦ 9♣ 2♠ 2♥ A♦').score, [2, 13, 9, 14]));
await test('ничья делит банк', () => {
  const r = P.showdown([{ id: 1, cards: P.parseCards('2♥ 3♦') }, { id: 2, cards: P.parseCards('4♥ 5♦') }], P.parseCards('A♠ K♥ Q♦ J♣ 10♠'));
  assert.deepStrictEqual(r.winners, [1, 2]);
});
await test('колода 52 уникальные карты', () => assert.strictEqual(new Set(P.newDeck().map(P.cardToString)).size, 52));

// ---------- 2. Стол с фейковым окружением ----------
console.log('Стол целиком:');
const calls = [];
let msgCounter = 100;
let now = 1_000_000;
let alarmAt = null;
const store = new Map();
const ctx = {
  storage: {
    get: async k => store.get(k),
    put: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); },
    delete: async k => { store.delete(k); },
    setAlarm: async t => { alarmAt = t; },
    deleteAlarm: async () => { alarmAt = null; }
  },
  blockConcurrencyWhile: fn => fn()
};
globalThis.fetch = async (url, opts) => {
  const method = url.split('/').pop();
  const payload = JSON.parse(opts.body);
  calls.push({ method, payload });
  const result = method === 'sendMessage' ? { message_id: ++msgCounter } : true;
  return { json: async () => ({ ok: true, result }) };
};
const table = new PokerTable(ctx, { BOT_TOKEN: 't', TELEGRAM_API: 'https://tg', WEBHOOK_SECRET: 's3cret' });
table.now = () => now;

let updateId = 1;
const CHAT = -100500;
const chat = { id: CHAT, type: 'supergroup' };
const users = { 1: { id: 1, first_name: 'Антон', username: 'first' }, 2: { id: 2, first_name: 'Вика', last_name: 'К' }, 3: { id: 3, username: 'third' }, 99: { id: 99, first_name: 'Зевака' } };
const send = u => table.handleUpdate(Object.assign({ update_id: updateId++ }, u));
const msg = (uid, text) => send({ message: { chat, from: users[uid], text } });
const click = (uid, data) => send({ callback_query: { id: 'cb' + updateId, from: users[uid], data, message: { chat, message_id: 101 } } });
const last = m => calls.filter(c => c.method === m).pop().payload;
const game = () => store.get('game');

await test('/ludoman_spin: лобби одним sendMessage, автор за столом, будильник на +30 сек', async () => {
  await msg(1, '/ludoman_spin@LudomanBot');
  assert.strictEqual(game().phase, 'lobby');
  assert.strictEqual(game().players.length, 1);
  assert.strictEqual(game().messageId, 101);
  assert.strictEqual(alarmAt, now + 30_000);
  assert.strictEqual(calls.filter(c => c.method === 'editMessageText').length, 0);
  assert.ok(last('sendMessage').text.includes('Антон'));
});
await test('повторный /ludoman_spin не создаёт вторую игру', async () => {
  await msg(2, '/ludoman_spin');
  assert.strictEqual(game().handNo, 1);
  assert.ok(last('sendMessage').text.includes('уже идёт'));
});
await test('кнопка «Присоединиться»: добавляет, повтор отклоняет, будильник через 5 сек', async () => {
  now += 3000;
  await click(2, 'j:1');
  assert.strictEqual(alarmAt, now + 5000, 'после второго игрока проверка через 5 сек');
  now += 2000;
  await click(3, 'j:1'); await click(2, 'j:1');
  assert.strictEqual(game().players.length, 3);
  assert.strictEqual(alarmAt, now + 5000, 'новый вход сдвигает таймер');
  assert.ok(last('answerCallbackQuery').text.includes('уже за столом'));
  assert.ok(last('editMessageText').text.includes('Вика К') && last('editMessageText').text.includes('@third'));
});
await test('будильник до 5 сек тишины не раздаёт, а ждёт', async () => {
  now += 2000;
  await table.alarm();
  assert.strictEqual(game().phase, 'lobby');
  assert.strictEqual(alarmAt, game().lastJoinAt + 5000);
});
await test('5 сек тишины при ≥2 игроках: раздача раньше 30 сек, карты открыты, проценты ~100, кнопок нет', async () => {
  now += 3000;
  assert.ok(now < game().deadline, 'ещё не 30 сек');
  await table.alarm();
  assert.strictEqual(game().phase, 'preflop');
  assert.ok(game().players.every(p => p.cards.length === 2));
  assert.strictEqual(game().deck.length, 46);
  const text = last('editMessageText').text;
  for (const p of game().players) assert.ok(text.includes(P.cardsToString(p.cards)), 'карты открыты всем');
  const sum = game().chances.reduce((a, b) => a + b, 0);
  assert.ok(sum >= 97 && sum <= 103, 'сумма шансов ' + sum);
  assert.ok(text.includes('%'));
  assert.deepStrictEqual(last('editMessageText').reply_markup.inline_keyboard, []);
  assert.strictEqual(alarmAt, now + 5500, 'перед флопом пауза длиннее обычной');
});
await test('опоздавший не может присоединиться', async () => {
  await click(99, 'j:1');
  assert.ok(last('answerCallbackQuery').text.includes('уже розданы'));
});
await test('улицы крутятся сами: флоп → тёрн → барабанная дробь → ривер в том же сообщении', async () => {
  now += 5500; await table.alarm();
  assert.strictEqual(game().board.length, 3); assert.ok(last('editMessageText').text.includes('Флоп'));
  now += 4000; await table.alarm();
  assert.strictEqual(game().board.length, 4); assert.ok(last('editMessageText').text.includes('Тёрн'));
  now += 4000; await table.alarm();
  assert.strictEqual(game().board.length, 4, 'дробь не открывает карту');
  assert.strictEqual(game().phase, 'turn');
  assert.ok(game().riverDrama);
  assert.ok(last('editMessageText').text.includes('Барабанная дробь'));
  assert.strictEqual(alarmAt, now + 6000, 'пауза перед ривером длиннее обычной');
  now += 6000; await table.alarm();
  assert.strictEqual(game().board.length, 5);
  assert.strictEqual(game().phase, 'river');
  assert.strictEqual(last('editMessageText').message_id, 101);
  assert.ok(game().chances.some(c => c === 100) || game().chances.filter(c => c > 0).length > 1, 'на ривере шансы определены');
});
await test('вскрытие: победитель в статистике, эмодзи по силе руки, игра очищается', async () => {
  const expected = P.showdown(game().players, game().board);
  now += 4000; await table.alarm();
  assert.strictEqual(game(), undefined);
  const stats = store.get('stats');
  for (const id of expected.winners) assert.strictEqual(stats[id].wins, 1);
  assert.strictEqual([1, 2, 3].reduce((s, id) => s + stats[id].hands, 0), 3);
  const text = last('editMessageText').text;
  assert.ok(text.includes('🏆'));
  expected.results.forEach(r => {
    if (r.best.score[0] >= 5) assert.ok(text.includes('🔥'), 'ожидался огонь на сильной руке');
    if (r.best.score[0] === 0) assert.ok(text.includes('💀'), 'ожидался череп на слабой руке');
  });
});
await test('клик по старой раздаче — вежливый отказ', async () => {
  await click(1, 'j:1');
  assert.ok(last('answerCallbackQuery').text.includes('уже закончена'));
});
await test('/ludoman_top показывает рейтинг по победам', async () => {
  await msg(1, '/ludoman_top');
  assert.ok(last('sendMessage').text.includes('🥇') && last('sendMessage').text.includes('побед'));
});
await test('лобби из одного игрока: подсказка про бота, потом ждёт 30 сек', async () => {
  await msg(1, '/ludoman_spin');
  assert.ok(last('sendMessage').text.includes(BOT_PLAYER_NAME));
  assert.strictEqual(alarmAt, now + 30_000);
});
await test('никто не подключился — раздача против Старика Лудомана, а не отмена', async () => {
  now += 30_000; await table.alarm();
  assert.strictEqual(game().phase, 'preflop');
  assert.strictEqual(game().players.length, 2);
  const bot = game().players.find(p => p.id === BOT_PLAYER_ID);
  assert.ok(bot && bot.name === BOT_PLAYER_NAME && bot.cards.length === 2);
  assert.ok(last('editMessageText').text.includes(BOT_PLAYER_NAME));
});
await test('бот-соперник не попадает в рейтинг /ludoman_top', async () => {
  now += 5500; await table.alarm(); // флоп
  now += 4000; await table.alarm(); // тёрн
  now += 4000; await table.alarm(); // барабанная дробь
  now += 6000; await table.alarm(); // ривер
  now += 4000; await table.alarm(); // вскрытие
  assert.strictEqual(game(), undefined);
  const stats = store.get('stats');
  assert.strictEqual(stats[BOT_PLAYER_ID], undefined, 'у бота не должно быть записи в статистике');
  await msg(1, '/ludoman_top');
  assert.ok(!last('sendMessage').text.includes(BOT_PLAYER_NAME));
});
await test('/ludoman_cancel снимает будильник и чистит игру', async () => {
  await msg(1, '/ludoman_spin'); await click(2, 'j:3');
  await msg(1, '/ludoman_cancel');
  assert.strictEqual(game(), undefined);
  assert.strictEqual(alarmAt, null);
});
await test('дубль update_id не обрабатывается дважды', async () => {
  const n = calls.length;
  await table.handleUpdate({ update_id: 5, message: { chat, from: users[1], text: '/ludoman_top' } });
  assert.strictEqual(calls.length, n);
});
await test('шансы: AA против KK против 72 на префлопе', () => {
  const pl = [{ cards: P.parseCards('A♠ A♥') }, { cards: P.parseCards('K♦ K♣') }, { cards: P.parseCards('7♠ 2♦') }];
  const c = P.winChances(pl, [], 2000);
  assert.ok(c[0] > 60 && c[1] > 12 && c[1] < 30 && c[2] < 15, 'шансы ' + c);
});
await test('шансы: на ривере ровно 100/0, ничья делится', () => {
  const pl = [{ cards: P.parseCards('2♥ 3♦') }, { cards: P.parseCards('4♥ 5♦') }];
  assert.deepStrictEqual(P.winChances(pl, P.parseCards('A♠ K♥ Q♦ J♣ 10♠')), [50, 50]);
  assert.deepStrictEqual(P.winChances([{ cards: P.parseCards('A♠ A♥') }, { cards: P.parseCards('7♠ 2♦') }], P.parseCards('A♦ K♠ 9♣ 4♥ 3♥')), [100, 0]);
});

await test('комментарий бота: каре на борде подсвечивается в renderTable', () => {
  const crafted = {
    handNo: 99, phase: 'flop',
    board: P.parseCards('K♠ K♥ K♦'),
    players: [{ id: 1, name: 'Тестер', cards: P.parseCards('K♣ 2♦') }],
    chances: [100]
  };
  assert.ok(table.renderTable(crafted).includes('каре намечается'));
});
await test('бэдбит: фаворит префлопа проигрывает — помечен в вскрытии', async () => {
  const crafted = {
    chatId: CHAT, messageId: 999, handNo: 98,
    board: P.parseCards('2♦ 2♣ 5♠ 6♥ 9♦'),
    players: [
      { id: 1, name: 'Фаворит', cards: P.parseCards('A♠ A♥') },
      { id: 2, name: 'Андердог', cards: P.parseCards('2♠ 2♥') }
    ],
    preflopChances: [85, 15]
  };
  await table.finishGame(crafted);
  const text = last('editMessageText').text;
  assert.ok(text.includes('Фаворит') && text.includes('😱 БЭДБИТ!'));
  assert.ok(!text.match(/Андердог[^\\n]*БЭДБИТ/));
});

console.log('Дуэли:');
await test('/ludoman_duel без ника — подсказка по использованию', async () => {
  await msg(1, '/ludoman_duel');
  assert.ok(last('sendMessage').text.includes('/ludoman_duel @username'));
  assert.strictEqual(game(), undefined);
});
await test('/ludoman_duel на самого себя отклоняется', async () => {
  await msg(1, '/ludoman_duel @first');
  assert.ok(last('sendMessage').text.includes('Сам с собой'));
  assert.strictEqual(game(), undefined);
});
await test('/ludoman_duel создаёт вызов без ожидания сбора', async () => {
  await msg(1, '/ludoman_duel @third');
  assert.strictEqual(game().phase, 'duel_wait');
  assert.strictEqual(game().targetUsername, 'third');
  assert.strictEqual(game().players.length, 1);
  assert.ok(last('sendMessage').text.includes('вызывает @third'));
  assert.strictEqual(alarmAt, now + 60000);
});
await test('чужой клик по «Принять вызов» отклоняется', async () => {
  await click(2, 'd:' + game().handNo);
  assert.ok(last('answerCallbackQuery').text.includes('не тебе'));
  assert.strictEqual(game().phase, 'duel_wait');
});
await test('адресат принимает — раздача сразу, без 30 и без 5 сек', async () => {
  const before = now;
  await click(3, 'd:' + game().handNo);
  assert.strictEqual(now, before, 'время не сдвигалось');
  assert.strictEqual(game().phase, 'preflop');
  assert.strictEqual(game().players.length, 2);
  assert.ok(game().players.every(p => p.cards.length === 2));
  assert.ok(last('answerCallbackQuery').text.includes('принят'));
  assert.ok(last('editMessageText').text.includes('Префлоп'));
});
await test('после раздачи улицы дуэли крутятся как обычно', async () => {
  now += 5500; await table.alarm();
  assert.strictEqual(game().board.length, 3);
  await msg(1, '/ludoman_cancel');
  assert.strictEqual(game(), undefined);
});
await test('вызов сгорает по таймауту, если не приняли', async () => {
  await msg(1, '/ludoman_duel @third');
  const handNo = game().handNo;
  now += 60000;
  await table.alarm();
  assert.strictEqual(game(), undefined);
  assert.ok(last('editMessageText').text.includes('не принял'));
  await click(3, 'd:' + handNo);
  assert.ok(last('answerCallbackQuery').text.includes('уже закончена'));
});

// ---------- 3. Worker ----------
console.log('Worker:');
const env = {
  WEBHOOK_SECRET: 's3cret',
  TABLE: { idFromName: n => 'id:' + n, get: id => ({ fetch: async (u, o) => { calls.push({ method: 'DO', id, body: JSON.parse(o.body) }); return new Response('ok'); } }) }
};
await test('GET отвечает версией', async () => {
  const r = await worker.fetch(new Request('https://x/', { method: 'GET' }), env);
  assert.ok((await r.text()).includes('alive'));
});
await test('POST без секрета — 403', async () => {
  const r = await worker.fetch(new Request('https://x/', { method: 'POST', body: '{}' }), env);
  assert.strictEqual(r.status, 403);
});
await test('POST с секретом уходит в объект нужного чата (без темы)', async () => {
  const r = await worker.fetch(new Request('https://x/', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's3cret' }, body: JSON.stringify({ update_id: 9, message: { chat: { id: 42 }, text: '/x' } }) }), env);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(calls.pop().id, 'id:42:0');
});
await test('апдейт из темы форума уходит в свой изолированный объект', async () => {
  const r = await worker.fetch(new Request('https://x/', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's3cret' }, body: JSON.stringify({ update_id: 10, message: { chat: { id: 42, is_forum: true }, message_thread_id: 3332, text: '/x' } }) }), env);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(calls.pop().id, 'id:42:3332', 'разные темы одного чата не должны делить состояние');
});
await test('в обычной группе message_thread_id у ответа игнорируется — команда и клик в одном объекте', async () => {
  const hit = async body => {
    await worker.fetch(new Request('https://x/', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's3cret' }, body: JSON.stringify(body) }), env);
    return calls.pop().id;
  };
  // /ludoman_spin отправили ответом на чьё-то сообщение — Telegram проставил тред
  const fromCommand = await hit({ update_id: 11, message: { chat: { id: 77, type: 'supergroup' }, message_thread_id: 900, text: '/ludoman_spin' } });
  // клик по кнопке приходит без треда
  const fromClick = await hit({ update_id: 12, callback_query: { id: 'cb', data: 'j:1', from: { id: 5 }, message: { chat: { id: 77, type: 'supergroup' }, message_id: 3 } } });
  assert.strictEqual(fromCommand, 'id:77:0');
  assert.strictEqual(fromClick, fromCommand, 'иначе игрок не может зайти в игру');
});
await test('в форуме тред учитывается и у команды, и у клика', async () => {
  const hit = async body => {
    await worker.fetch(new Request('https://x/', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's3cret' }, body: JSON.stringify(body) }), env);
    return calls.pop().id;
  };
  const fromCommand = await hit({ update_id: 13, message: { chat: { id: 88, is_forum: true }, message_thread_id: 3332, text: '/ludoman_spin' } });
  const fromClick = await hit({ update_id: 14, callback_query: { id: 'cb', data: 'j:1', from: { id: 5 }, message: { chat: { id: 88, is_forum: true }, message_thread_id: 3332, message_id: 3 } } });
  assert.strictEqual(fromCommand, 'id:88:3332');
  assert.strictEqual(fromClick, fromCommand);
});

console.log('\n' + (process.exitCode ? 'ЕСТЬ ОШИБКИ' : 'Все тесты прошли') + ': ' + passed);
