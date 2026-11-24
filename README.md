# ToDo

A personal task manager for home and office. It runs as an installable web app (PWA) in any modern browser, including a locked-down office PC, iPhone and iPad. Everything is stored on the device and works offline.

Design: see the "ToDo App: Technical & UI Design" doc. This repository currently holds **phase 2, the local MVP**: one device, no sync yet.

## Features

- Tasks with priority, due date and optional time, description, timestamped notes (yours plus automatic ones for status, due date and project changes)
- Statuses: to do, in progress, done, cancelled
- Recurrence: on a schedule or counted from completion (iCalendar RRULE), missed occurrences are skipped
- Projects nested to any depth, with inherited home/office context and urgency weight
- Tags with their own urgency weight
- Blocking dependencies with loop prevention. A blocked task can only be started or completed with an override reason, which is logged as a note
- Urgency score from 14 weighted factors, with a per-task breakdown and a tuning screen with presets and a live top-10 preview
- Quick add: `Call accountant fri 14:00 !high #finance @Work/Admin every month ~15m`
- Views: Focus, Upcoming, Inbox, project, tag, Logbook, Search with filters (`#tag project:Work due<7d !high status:done`)
- Keyboard: `j`/`k` move, `x` done, `s` start/pause, `e` edit title, `n` note, `/` search, `Ctrl/Cmd+K` quick add, `Esc` close
- Phone: tab bar, + button with quick-add sheet, swipe right for done, swipe left for start/pause
- JSON export of everything

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (domain logic and storage)
npm run build      # production build in dist/
```

## Running it on the home server

```sh
docker build -t todo .
docker run -d --name todo -p 8080:80 --restart unless-stopped todo
```

Browsers only allow offline storage and installing the app over HTTPS (or on `localhost`), so put it behind your reverse proxy with a certificate.

## Layout

| Path | What |
| --- | --- |
| `src/domain` | Pure logic: types, urgency score, dependency graph, project tree, recurrence, quick-add parser, status rules |
| `src/db` | SQLite schema and migrations, the `Store` (all reads and writes), browser worker (SQLite WASM on OPFS) and a Node driver for tests |
| `src/ui` | React screens and styles |

Data lives in SQLite in the browser's Origin Private File System. Every write is also recorded in a local `change_log` table, which the sync engine in phase 3 will push to the server.

Known limits of this phase: one device only; the app can be open in one tab at a time (a second tab shows a warning and does not save); reminders/notifications come with the server in phase 3.
