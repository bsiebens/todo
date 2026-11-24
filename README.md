# ToDo

A personal task manager for home and office. It runs as an installable web app (PWA) in any modern browser, including a locked-down office PC, iPhone and iPad. Everything is stored on the device and works offline; a small server on your home network keeps devices in sync and sends reminders.

Design: see the "ToDo App: Technical & UI Design" doc. This repository holds phases 2 and 3: the local app, plus sync between devices, sign-in and reminders.

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
- Sync between devices through your own server: per-field merge, works offline, live updates while open
- Sign-in with passkeys, a one-time code from another device, or a code by email; devices can be signed out remotely
- Reminders by Web Push: at the due time (or before) and a morning summary

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit and server tests (the server tests use an in-process Postgres)
npm run build      # web app in dist/, server bundle in dist-server/
```

To work on sync locally, run Postgres and then `DATABASE_URL=postgres://... npm run dev:server` next to `npm run dev`; Vite forwards `/api` to it.

## Running it on the home server

See [deploy/README.md](deploy/README.md): `docker compose` with the app server, Postgres and nightly backups, behind your reverse proxy with HTTPS.

## Layout

| Path | What |
| --- | --- |
| `src/domain` | Pure logic: types, urgency score, dependency graph, project tree, recurrence, quick-add parser, status rules |
| `src/db` | SQLite schema and migrations, the `Store` (all reads and writes), browser worker (SQLite WASM on OPFS) and a Node driver for tests |
| `src/sync` | Sync protocol shared with the server, hybrid logical clock, sync client, Web Push setup |
| `src/ui` | React screens and styles |
| `server` | Sync server: sign-in, push/pull merge, reminders, serves the web app |
| `deploy` | Docker Compose setup and deploy guide |

Data lives in SQLite in the browser's Origin Private File System. Triggers record every changed field in a local outbox (`sync_outbox`), which the sync client pushes to the server.

Known limits: the app can be open in one tab at a time (a second tab shows a warning and does not save or sync). If two offline devices both complete the same recurring task, each creates the next instance, so you may see two.
