# Desktop app (Windows, macOS, Linux)

The desktop app is the same app as the web version, packaged with [Tauri](https://tauri.app). It adds:

- **Tray icon** (menu bar on a Mac): click it to open ToDo; its menu has *New task…* and *Quit ToDo*.
- **Closing keeps it running.** The window's close button hides ToDo to the tray so reminders keep coming. `Ctrl+Q` (`⌘Q`) or the tray menu quits. You can switch this off under Settings > Desktop app.
- **Quick add from anywhere:** `Ctrl+Alt+N` (`⌘⌥N` on a Mac) brings ToDo up with the quick-add box ready, from any app. Change or clear the shortcut under Settings > Desktop app.
- **Reminders as system notifications**, at the due time (or the lead time before it) and a morning summary, using the same reminder settings as your other devices. They work without the sync server too, but only while ToDo runs (in the window or the tray).
- **Start at login** (optional), straight into the tray.
- **One copy at a time:** opening ToDo again brings the running window to the front.

Tasks are stored in a SQLite file in the app's data folder:

| System | Folder |
| --- | --- |
| Windows | `%APPDATA%\org.siebens.todo` |
| macOS | `~/Library/Application Support/org.siebens.todo` |
| Linux | `~/.local/share/org.siebens.todo` |

## Syncing with your server

Open Settings, type your server's address (for example `https://todo.your-domain`) and press Connect. Then sign in with a one-time code: on a signed-in device open Settings > Sync > *Show a one-time code*. (Passkeys can't be used from the desktop app, because they are tied to your server's web address. Add them in the browser or on your phone.)

The server allows the desktop app's requests out of the box (origins `tauri://localhost` and `https://tauri.localhost`); no server change is needed beyond updating to this version. Use an `https://` address: Windows blocks plain `http://` from the app.

## Getting the installers

Builds run on GitHub Actions: open **Actions > Desktop app > Run workflow**, or push a tag such as `desktop-v0.1.0`. When it finishes, download the artifacts:

- **Windows:** `ToDo_x.y.z_x64-setup.exe` installs for your user only, without admin rights. The `.msi` is there too if IT prefers it.
- **macOS:** `ToDo_x.y.z_universal.dmg` (Apple silicon and Intel).
- **Linux:** `.AppImage` and `.deb`.

The installers are not code-signed yet. Windows SmartScreen shows "Windows protected your PC": choose *More info > Run anyway*. On a Mac, right-click the app and choose *Open* the first time. A locked-down office PC may refuse unsigned programs; the web app keeps working there either way.

## Developing

Needs Rust ([rustup](https://rustup.rs)) and, on Linux, `libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev`.

```sh
npm run desktop:dev     # app window with hot reload (starts Vite)
npm run desktop:build   # installers in src-tauri/target/release/bundle
cd src-tauri && cargo test
```

Layout: `src-tauri/src/lib.rs` (tray, window, single instance, plugins), `src-tauri/src/db.rs` (the SQLite file, exposed to the web side as `db_query` and `db_batch`), `src/platform/` (desktop detection, shortcut, notifications, database driver). The web code checks `isDesktop` from `src/platform/desktop.ts`; in a browser none of the desktop code runs.
