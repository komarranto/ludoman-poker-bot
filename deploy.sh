#!/bin/bash
# Деплой Ludoman Spin на Cloudflare Workers одной командой: ./deploy.sh
# Нужно: один раз `npx wrangler login`, файл .secrets с BOT_TOKEN и WEBHOOK_SECRET.
set -euo pipefail
cd "$(dirname "$0")"
W="./node_modules/.bin/wrangler"

if [ ! -f .secrets ]; then
  secret=$(openssl rand -hex 16)
  printf 'BOT_TOKEN=\nWEBHOOK_SECRET=%s\n' "$secret" > .secrets
  echo "Создан .secrets — впиши BOT_TOKEN от @BotFather и запусти ./deploy.sh снова."
  exit 1
fi
source .secrets
[ -n "${BOT_TOKEN:-}" ] || { echo "В .secrets пустой BOT_TOKEN. Возьми токен у @BotFather."; exit 1; }
[ -n "${WEBHOOK_SECRET:-}" ] || { echo "В .secrets пустой WEBHOOK_SECRET."; exit 1; }

"$W" whoami >/dev/null 2>&1 || { echo "Cloudflare не авторизован: запусти  npx wrangler login  и повтори."; exit 1; }

echo "→ Проверяю токен бота…"
me=$(curl -s "https://api.telegram.org/bot$BOT_TOKEN/getMe")
echo "$me" | grep -q '"ok":true' || { echo "Telegram не принял токен: $me"; exit 1; }
BOT_USERNAME=$(echo "$me" | sed -E 's/.*"username":"([^"]+)".*/\1/')
echo "   бот: @$BOT_USERNAME"

npm test >/dev/null || { echo "Тесты не прошли — деплой отменён (npm test)"; exit 1; }

echo "→ Деплою worker…"
out=$("$W" deploy 2>&1); echo "$out" | tail -4
URL=$(echo "$out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[ -n "$URL" ] || { echo "Не нашла адрес workers.dev в выводе wrangler"; exit 1; }

echo "→ Кладу секреты…"
printf '%s' "$BOT_TOKEN" | "$W" secret put BOT_TOKEN >/dev/null
printf '%s' "$WEBHOOK_SECRET" | "$W" secret put WEBHOOK_SECRET >/dev/null

echo "→ Регистрирую вебхук $URL и команды…"
curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" -H 'content-type: application/json' \
  -d "{\"url\":\"$URL\",\"secret_token\":\"$WEBHOOK_SECRET\",\"allowed_updates\":[\"message\",\"callback_query\"],\"drop_pending_updates\":true}"; echo
curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/setMyCommands" -H 'content-type: application/json' \
  -d '{"commands":[{"command":"ludoman_spin","description":"Раздача в техасский холдем: 30 сек на вход"},{"command":"ludoman_top","description":"Рейтинг по фишкам"},{"command":"ludoman_cancel","description":"Отменить текущую раздачу"},{"command":"bot_version","description":"Какая версия бота работает"}]}'; echo
echo "→ Проверка:"
curl -s "$URL/"; echo
curl -s "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"; echo
echo "✅ Готово: @$BOT_USERNAME. В чате: /bot_version"
