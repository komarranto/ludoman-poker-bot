// Фейковый Telegram API для локальной проверки: node test/mock_telegram.mjs
// Логирует все вызовы бота в test/mock_telegram.log и отвечает как настоящий.
import http from 'node:http';
import fs from 'node:fs';
let msgId = 500;
const log = fs.createWriteStream(new URL('./mock_telegram.log', import.meta.url), { flags: 'w' });
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const method = req.url.split('/').pop();
    log.write(JSON.stringify({ method, payload: JSON.parse(body || '{}') }) + '\n');
    const result = method === 'sendMessage' ? { message_id: ++msgId } : true;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  });
}).listen(8081, () => console.log('mock telegram on :8081'));
