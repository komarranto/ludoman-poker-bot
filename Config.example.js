// ==================== Config.gs — ЛИЧНЫЕ НАСТРОЙКИ (ШАБЛОН) ====================
// Скопируй в Config.js (локально) / Config.gs (в Apps Script) и впиши значения.
// Реальный Config.js в git не попадает (.gitignore).

const TELEGRAM_BOT_TOKEN = '123456789:AAAA-your-bot-token-from-BotFather';
// Любая случайная строка — защищает вебхук от посторонних запросов
const TELEGRAM_WEBHOOK_SECRET = 'change-me-random-secret';
// Адрес веб-приложения (заполняет deploy.sh после первого деплоя)
const WEB_APP_URL = '';
