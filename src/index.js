// ==================== Worker: приём вебхука Telegram ====================
// Проверяет секрет из заголовка Telegram и передаёт апдейт в Durable Object
// того чата, откуда он пришёл. Ответ Telegram — сразу 200.

import { PokerTable, BOT_VERSION } from './table.js';

export { PokerTable };

export const BOT_COMMANDS = [
  { command: 'ludoman_spin', description: 'Раздача: сбор до 30 сек, потом карты сами' },
  { command: 'ludoman_duel', description: 'Вызвать конкретного игрока на дуэль 1 на 1' },
  { command: 'ludoman_top', description: 'Кто чаще побеждал' },
  { command: 'ludoman_cancel', description: 'Отменить текущую раздачу' },
  { command: 'bot_version', description: 'Какая версия бота работает' }
];

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response(`Ludoman bot ${BOT_VERSION} is alive`);
    }
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch (err) {
      return new Response('bad json', { status: 400 });
    }
    const message = update.message ?? update.callback_query?.message;
    const chat = message?.chat;
    if (chat?.id === undefined) return new Response('ok');
    // Тему учитываем ТОЛЬКО в форумах. В обычной супергруппе Telegram тоже
    // проставляет message_thread_id — у ответов на сообщения, — и тогда команда
    // и клик по кнопке уезжали в разные объекты: игра «не видела» игроков.
    const threadId = chat.is_forum === true ? (message.message_thread_id ?? 0) : 0;

    const stub = env.TABLE.get(env.TABLE.idFromName(`${chat.id}:${threadId}`));
    await stub.fetch('https://table/update', { method: 'POST', body: JSON.stringify(update) });
    return new Response('ok');
  }
};
