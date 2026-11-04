# MERCY ARENA

MERCY ARENA — турнирная платформа для Mobile Legends: Bang Bang.

## Публикация

Основной вариант хостинга: **Cloudflare Pages**.

Настройки проекта Cloudflare Pages для Git-интеграции:

- Repository: `raeffsky/MERCY-ARENA`
- Production branch: `main`
- Framework preset: `None`
- Build command: `bash scripts/build-pages.sh`
- Build output directory: `dist`
- Root directory: пусто (корень репозитория)

Скрипт сборки копирует статический сайт и все файлы `public/` в `dist/`. Никакие зависимости или npm-сборка не требуются. Файл `_headers` задаёт базовые HTTP-заголовки и кеширование.

## Разделы

- Главная панель
- Турниры
- Команды
- Игроки
- Центр матчей и сетки
- Рейтинги
- Сезоны
- Статус Auto Result Engine
- Кабинет организатора
- О платформе

Разделы используют отдельные hash-маршруты. Интерфейс адаптивный и сохраняет утверждённую визуальную систему MERCY ARENA.

## Целостность данных

Демо-турниры, команды, игроки, расписания, результаты и рейтинги не добавляются. Пустые состояния остаются пустыми до подключения доверенного backend.

Auto Result Engine пока не активирован. Frontend не заявляет о получении live-результатов MLBB. Backend foundation: Cloudflare Pages Functions + Cloudflare D1. Схема БД и публичные API-маршруты находятся в `migrations/` и `functions/api/v1/`. См. [контракт интеграции backend](docs/BACKEND-INTEGRATION.md).

## Бренд

- Фон: `#08090D`
- Основной акцент: `#D7FF5E`
- Текст: `#F5F6FA`
- Логотип: `public/assets/brand/mercy-mark.png`
- Векторный логотип: `public/assets/brand/mercy-mark.svg`

Иконки: Iconify. Шрифты: Barlow Condensed и Manrope.
