# ToDo

A personal task manager for home and office. It runs as an installable web app (PWA) in any modern browser, including a locked-down office PC, iPhone and iPad, and as a desktop app for Windows, macOS and Linux. Everything is stored on the device and works offline; a small server on your home network keeps devices in sync and sends reminders.

Design: see the "ToDo App: Technical & UI Design" doc. This repository holds phases 2 to 4: the local app; sync between devices, sign-in and reminders; and the desktop app.

## Features

- Tasks with priority, due date and optional time, description, timestamped notes (yours plus automatic ones for status, due date and project changes)
- Statuses: to do, in progress, done, cancelled
- Recurrence: on a schedule or counted from completion (iCalendar RRULE), missed occurrences are skipped
- Projects nested to any depth, with inherited home/office context and urgency weight
- Tags with their own urgency weight
- Blocking dependencies with loop prevention. A blocked task can only be started or completed with an override reason, which is logged as a note
- Urgency score from 14 weighted factors, with a per-task breakdown and an Urgency tuning screen: presets, every factor explained, and a live preview of how your top 15 would move before you save
- Quick add: `Call accountant fri 14:00 !high #finance @Work/Admin every month ~15m`
- Views: Focus, Upcoming, Inbox, project, tag, Logbook, Search with filters (`#tag project:Work due<7d !high status:done`)
- Focus is today's list: what you starred for today plus anything in progress. It starts empty each morning. **All open** lists every open task, suggests the most urgent ones and yesterday's leftovers first, and one click on the star puts a task in Focus
- Saved filters: save any search under a name; it shows in the sidebar and syncs to your other devices
- Keyboard: `j`/`k` move, `x` done, `s` start/pause, `e` edit title, `n` note, `/` search, `Ctrl/Cmd+K` quick add, `Ctrl/Cmd+P` command palette (go anywhere, act on the selected task, add or find a task), `Esc` close
- Phone: tab bar, + button with quick-add sheet, swipe right for done, swipe left for start/pause
- JSON export of everything
- Import from Todoist or TickTick (CSV export), any CSV with a Title/Task/Subject column (for example Outlook tasks), a pasted text or Markdown list, or a ToDo JSON export. Sub-tasks become a checklist in the description. Settings > Data > Import
- Sync between devices through your own server: per-field merge, works offline, live updates while open
- Sign-in with passkeys, a one-time code from another device, or a code by email; devices can be signed out remotely
- Reminders by Web Push: at the due time (or before) and a morning summary
- Desktop app: tray icon, global shortcut that opens a small quick-entry window (Ctrl+Alt+N), native reminder notifications, start at login. Installers are on the Releases page; see [docs/desktop.md](docs/desktop.md), which also covers releasing a new version

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit and server tests (the server tests use an in-process Postgres)
npm run build      # web app in dist/, server bundle in dist-server/
```

### Testing sync locally

`npm run dev` alone has no sync server, so Settings shows "No sync server answers at this address" and there is no code field. Start the server in a second terminal:

```sh
npm run dev:server   # sync server on :8080 with an in-process Postgres, data in .dev-data/
npm run dev          # the app on http://localhost:5173, forwards /api to :8080
```

The setup code is printed by `dev:server`. To try a second device, open http://localhost:5173 in a private window or another browser, then use **Show a one-time code** on the first one. Passkeys work on localhost too. Delete `.dev-data/` to start over.

To test the real container setup instead, use `deploy/docker-compose.yml` with `APP_URL=http://localhost:8080` and open that address.

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
| `src-tauri` | Desktop app shell (Rust): tray, window, shortcut and notification plugins, SQLite file |
| `src/platform` | Desktop-only web code: detection, settings, reminders, database driver |

Data lives in SQLite in the browser's Origin Private File System. Triggers record every changed field in a local outbox (`sync_outbox`), which the sync client pushes to the server.

Known limits: the app can be open in one tab at a time (a second tab shows a warning and does not save or sync). If two offline devices both complete the same recurring task, each creates the next instance, so you may see two.
