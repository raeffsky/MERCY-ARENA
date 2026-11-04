# MERCY ARENA: вход по email-ссылке

Вход работает без Cloudflare Access. Одноразовая ссылка отправляется через Brevo. Её токен хранится в D1 только в виде SHA-256-хеша, действует 15 минут и используется один раз. После входа сервер выдаёт 14-дневную сессию в Secure, HttpOnly, SameSite=Lax cookie.

## 1. Применить миграцию D1

Cloudflare Dashboard → Workers & Pages → D1 → mercy-arena-db → Console. Выполните SQL из migrations/0002_email_auth.sql.

## 2. Настроить отправителя

В Brevo откройте Settings → Senders, Domains, IPs → Senders → Add a sender. Укажите адрес почты, к которому у вас есть доступ. Если домен не аутентифицирован, Brevo отправит на этот адрес шестизначный код подтверждения. Подтвердите отправителя этим кодом. Затем создайте API key в SMTP & API → API Keys.

Документация: https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email

## 3. Production Variables and Secrets

Cloudflare Pages → mercy-arena → Settings → Variables and Secrets → Production:

- APP_BASE_URL = https://mercy-arena.pages.dev
- BOOTSTRAP_ADMIN_EMAIL = maloraeff@yandex.ru
- AUTH_FROM_EMAIL = подтверждённый адрес отправителя, который вы добавили в Brevo
- BREVO_API_KEY = API key Brevo как Secret
- AUTH_RATE_LIMIT_SALT = длинная случайная строка как Secret

Не отправляйте API key или секреты в чат и не помещайте их в GitHub.

## 4. Проверка

- GET /api/v1/me без cookie возвращает authenticated:false.
- POST /api/v1/auth/request-link с JSON {"email":"maloraeff@yandex.ru"} отправляет письмо.
- Ссылка действует 15 минут и может быть открыта один раз.
- Первый подтверждённый вход на BOOTSTRAP_ADMIN_EMAIL создаёт пользователя и роль administrator.
- POST /api/v1/auth/logout отзывает сессию.

Не доверяем email из формы как доказательству личности. Доказательство — доступ к почтовому ящику и одноразовая ссылка. Не раскрываем, существует ли аккаунт. API key Brevo используется только на сервере.
