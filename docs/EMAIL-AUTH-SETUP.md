# MERCY ARENA: вход администратора по email и паролю

Вход в кабинет организатора использует серверную проверку пары email/пароль. Единственный bootstrap-администратор задаётся переменной `BOOTSTRAP_ADMIN_EMAIL`. При первом успешном входе сервер создаёт пользователя в D1 и выдаёт роль `administrator`. Сессия хранится в Secure, HttpOnly, SameSite=Lax cookie сроком 14 дней.

Brevo и отправка писем для входа больше не используются.

## 1. Применить миграции D1

Cloudflare Dashboard → Workers & Pages → D1 → mercy-arena-db → Console.

Выполните SQL по порядку:
1. `migrations/0002_email_auth.sql` — создаёт таблицу сессий.
2. `migrations/0003_admin_login_rate_limit.sql` — создаёт хранилище ограничений попыток входа.

Миграцию 0002 нужно выполнить, даже если таблица `auth_magic_links` больше не используется: она также создаёт `auth_sessions`.

## 2. Настроить Cloudflare Pages

Cloudflare Pages → mercy-arena → Settings → Variables and Secrets → Production.

Обычная переменная:
- `BOOTSTRAP_ADMIN_EMAIL` = `maloraeff@yandex.ru`

Secrets:
- `ADMIN_LOGIN_PASSWORD` = придуманный тобой длинный уникальный пароль, минимум 12 символов.
- `APP_BASE_URL` = `https://mercy-arena.pages.dev` (можно добавить как переменную).
- `AUTH_RATE_LIMIT_SALT` = длинная случайная строка.

Не отправляй пароль или секреты в чат и не помещай их в GitHub. Не используй пароль от почты или других сервисов.

## 3. Вход

Открой `https://mercy-arena.pages.dev/#/organizer` и введи:
- Email: `maloraeff@yandex.ru`
- Пароль: значение `ADMIN_LOGIN_PASSWORD`, которое ты сам установил в Cloudflare.

Сервер выдаёт роль администратора только для адреса из `BOOTSTRAP_ADMIN_EMAIL`. Остальные email не могут получить административный доступ.

## 4. Проверка

- `GET /api/v1/me` без cookie возвращает `authenticated:false`.
- `POST /api/v1/auth/login` проверяет email и пароль.
- После успешного входа `GET /api/v1/me` возвращает роль `administrator`.
- `POST /api/v1/auth/logout` отзывает текущую сессию.

После 10 неудачных попыток вход блокируется на 15 минут для соответствующего email/IP.
