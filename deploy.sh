#!/bin/bash
# Деплой Ludoman Spin бота одной командой:
#   ./deploy.sh            — залить код, обновить деплой, перерегистрировать вебхук
# Нужны: Config.js с токеном (см. Config.example.js), clasp в ../node_modules, curl.
set -euo pipefail
cd "$(dirname "$0")"
CLASP="../node_modules/.bin/clasp"
[ -x "$CLASP" ] || CLASP="clasp"

if [ ! -f Config.js ]; then
  cp Config.example.js Config.js
  secret=$(LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 32)
  sed -i '' "s/change-me-random-secret/$secret/" Config.js
  echo "Создан Config.js. Впиши в него TELEGRAM_BOT_TOKEN от @BotFather и запусти ./deploy.sh ещё раз."
  exit 1
fi

TOKEN=$(grep "TELEGRAM_BOT_TOKEN" Config.js | sed -E "s/.*'([^']*)'.*/\1/")
SECRET=$(grep "TELEGRAM_WEBHOOK_SECRET" Config.js | sed -E "s/.*'([^']*)'.*/\1/")
if [[ "$TOKEN" == *"your-bot-token"* || -z "$TOKEN" ]]; then
  echo "В Config.js не заполнен TELEGRAM_BOT_TOKEN. Возьми токен у @BotFather и впиши его."
  exit 1
fi

echo "→ Проверяю токен бота…"
me=$(curl -s "https://api.telegram.org/bot$TOKEN/getMe")
echo "$me" | grep -q '"ok":true' || { echo "Telegram не принял токен: $me"; exit 1; }
BOT_USERNAME=$(echo "$me" | sed -E 's/.*"username":"([^"]+)".*/\1/')
echo "   бот: @$BOT_USERNAME"

VERSION=$(grep "const BOT_VERSION" Bot.js | sed -E "s/.*'([^']*)'.*/\1/")

# Первый деплой создаёт deployment и запоминает его id, дальше — обновляет тот же
DEPLOYMENT_ID=""
[ -f .deploy.env ] && source .deploy.env
if [ -z "$DEPLOYMENT_ID" ]; then
  echo "→ Первый деплой: создаю deployment…"
  # Сначала заливаем код без URL, чтобы получить deployment id
  "$CLASP" push -f
  out=$("$CLASP" deploy -d "v$VERSION")
  echo "$out"
  DEPLOYMENT_ID=$(echo "$out" | grep -oE 'AKfycb[A-Za-z0-9_-]+' | head -1)
  [ -n "$DEPLOYMENT_ID" ] || { echo "Не смогла вытащить deployment id из вывода clasp"; exit 1; }
  echo "DEPLOYMENT_ID=$DEPLOYMENT_ID" > .deploy.env
fi
WEB_APP_URL="https://script.google.com/macros/s/$DEPLOYMENT_ID/exec"

# Прописываем адрес веб-приложения в Config.js (нужен setupTelegramWebhook в редакторе)
sed -i '' -E "s#const WEB_APP_URL = '[^']*'#const WEB_APP_URL = '$WEB_APP_URL'#" Config.js

echo "→ Заливаю код (v$VERSION) и обновляю deployment $DEPLOYMENT_ID…"
"$CLASP" push -f
"$CLASP" redeploy "$DEPLOYMENT_ID" -d "v$VERSION" >/dev/null

echo "→ Регистрирую вебхук и команды в Telegram…"
curl -s -X POST "https://api.telegram.org/bot$TOKEN/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"$WEB_APP_URL?secret=$SECRET\",\"allowed_updates\":[\"message\",\"callback_query\"],\"drop_pending_updates\":true}"
echo
curl -s -X POST "https://api.telegram.org/bot$TOKEN/setMyCommands" \
  -H 'Content-Type: application/json' \
  -d '{"commands":[{"command":"ludoman_spin","description":"Раздача в техасский холдем: 30 сек на вход"},{"command":"ludoman_top","description":"Рейтинг по фишкам"},{"command":"ludoman_cancel","description":"Отменить текущую раздачу"},{"command":"bot_version","description":"Какая версия бота работает"}]}'
echo
echo "→ Статус вебхука:"
curl -s "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
echo
echo
echo "✅ Готово: @$BOT_USERNAME, версия $VERSION."
echo "   Если бот молчит — один раз открой редактор ($CLASP open-script), запусти setupTelegramWebhook"
echo "   и разреши доступ (Google спросит один раз). Потом в чате: /bot_version"
