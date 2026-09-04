// Локальные тесты: npm test
// 1) оценка покерных комбинаций; 2) полный прогон стола с фейковым Telegram и хранилищем.
import assert from 'node:assert';
import * as P from '../src/poker.js';
import { PokerTable } from '../src/table.js';
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
const users = { 1: { id: 1, first_name: 'Антон' }, 2: { id: 2, first_name: 'Вика', last_name: 'К' }, 3: { id: 3, username: 'third' }, 99: { id: 99, first_name: 'Зевака' } };
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
await test('кнопка «Присоединиться»: добавляет, повтор отклоняет', async () => {
  await click(2, 'j:1'); await click(3, 'j:1'); await click(2, 'j:1');
  assert.strictEqual(game().players.length, 3);
  assert.ok(last('answerCallbackQuery').text.includes('уже за столом'));
  assert.ok(last('editMessageText').text.includes('Вика К') && last('editMessageText').text.includes('@third'));
});
await test('до раздачи карты не показываются', async () => {
  await click(1, 'c:1');
  assert.ok(last('answerCallbackQuery').text.includes('ещё не розданы'));
});
await test('будильник раздаёт по 2 карты и списывает анте', async () => {
  now += 30_000;
  await table.alarm();
  assert.strictEqual(game().phase, 'preflop');
  assert.ok(game().players.every(p => p.cards.length === 2));
  assert.strictEqual(game().pot, 300);
  assert.strictEqual(game().deck.length, 46);
  assert.strictEqual(store.get('banks')[1].chips, 900);
  assert.ok(last('editMessageText').text.includes('Префлоп'));
});
await test('«Мои карты» — alert только игроку', async () => {
  await click(2, 'c:1');
  const a = last('answerCallbackQuery');
  assert.strictEqual(a.show_alert, true);
  assert.ok(a.text.includes('Твои карты: ' + P.cardsToString(game().players[1].cards)));
  await click(99, 'c:1');
  assert.ok(last('answerCallbackQuery').text.includes('не за столом'));
});
await test('опоздавший не может присоединиться', async () => {
  await click(99, 'j:1');
  assert.ok(last('answerCallbackQuery').text.includes('уже розданы'));
});
await test('флоп → тёрн → ривер в том же сообщении', async () => {
  await click(1, 'n:1'); assert.strictEqual(game().board.length, 3); assert.ok(last('editMessageText').text.includes('Флоп'));
  await click(2, 'n:1'); assert.strictEqual(game().board.length, 4);
  await click(3, 'n:1'); assert.strictEqual(game().board.length, 5);
  assert.strictEqual(game().phase, 'river');
  assert.strictEqual(last('editMessageText').message_id, 101);
});
await test('вскрытие: победитель получает банк, игра очищается', async () => {
  const expected = P.showdown(game().players, game().board);
  await click(1, 'n:1');
  assert.strictEqual(game(), undefined);
  const banks = store.get('banks');
  assert.strictEqual([1, 2, 3].reduce((s, id) => s + banks[id].chips, 0), 3000 - (300 % expected.winners.length));
  expected.winners.forEach(id => assert.ok(banks[id].chips > 900));
  assert.ok(last('editMessageText').text.includes('🏆'));
});
await test('клик по старой раздаче — вежливый отказ', async () => {
  await click(1, 'n:1');
  assert.ok(last('answerCallbackQuery').text.includes('уже закончена'));
});
await test('/ludoman_top показывает рейтинг', async () => {
  await msg(1, '/ludoman_top');
  assert.ok(last('sendMessage').text.includes('🥇'));
});
await test('лобби из одного игрока по будильнику отменяется', async () => {
  await msg(1, '/ludoman_spin');
  now += 30_000; await table.alarm();
  assert.strictEqual(game(), undefined);
  assert.ok(last('editMessageText').text.includes('Не набралось'));
});
await test('/ludoman_cancel возвращает анте и снимает будильник', async () => {
  await msg(1, '/ludoman_spin'); await click(2, 'j:3');
  now += 30_000; await table.alarm();
  const before = store.get('banks')[1].chips;
  await msg(1, '/ludoman_cancel');
  assert.strictEqual(store.get('banks')[1].chips, before + 100);
  assert.strictEqual(game(), undefined);
  assert.strictEqual(alarmAt, null);
});
await test('дубль update_id не обрабатывается дважды', async () => {
  const n = calls.length;
  await table.handleUpdate({ update_id: 5, message: { chat, from: users[1], text: '/ludoman_top' } });
  assert.strictEqual(calls.length, n);
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
await test('POST с секретом уходит в объект нужного чата', async () => {
  const r = await worker.fetch(new Request('https://x/', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 's3cret' }, body: JSON.stringify({ update_id: 9, message: { chat: { id: 42 }, text: '/x' } }) }), env);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(calls.pop().id, 'id:42');
});

console.log('\n' + (process.exitCode ? 'ЕСТЬ ОШИБКИ' : 'Все тесты прошли') + ': ' + passed);
