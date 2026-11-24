//! Desktop shell for ToDo. The whole app is the same web build as the PWA; this
//! side only adds what a browser can't: a tray icon, closing to the tray, one
//! running copy, a global hotkey and native notifications (the last two are
//! driven from the web side through their plugins).

mod db;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// Whether the window's close button hides to the tray (true) or quits.
struct CloseToTray(AtomicBool);

const MAIN: &str = "main";

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

const QUICK: &str = "quick";

/// The quick-entry panel's size. On Linux the page draws its own shadow, so the
/// window has room around the panel for it.
#[cfg(not(target_os = "linux"))]
const QUICK_SIZE: (f64, f64) = (640.0, 116.0);
#[cfg(target_os = "linux")]
const QUICK_SIZE: (f64, f64) = (680.0, 156.0);

/// The native backdrop behind the quick-entry panel: the frosted popover material
/// with rounded corners on macOS, Mica on Windows 11 (Windows 10 ignores it and
/// the page's own background shows). `dark` picks Mica's shade to match the app's
/// theme rather than the system's. Linux has no backdrop; the page draws one.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn quick_effects(dark: Option<bool>) -> tauri::utils::config::WindowEffectsConfig {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    #[cfg(target_os = "macos")]
    let _ = dark;
    #[cfg(target_os = "macos")]
    let effect = Effect::Popover;
    #[cfg(target_os = "windows")]
    let effect = match dark {
        Some(true) => Effect::MicaDark,
        Some(false) => Effect::MicaLight,
        None => Effect::Mica,
    };
    EffectsBuilder::new().effect(effect).state(EffectState::Active).radius(12.0).build()
}

/// Opens the small quick-entry window: one line, centred and on top of other apps.
/// It is made on first use and hidden, not closed, afterwards so the next open is
/// instant. The task itself is saved by the main window, which owns the data.
fn show_quick(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(QUICK) {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to(QUICK, "quick-open", ());
        return;
    }
    let builder = WebviewWindowBuilder::new(app, QUICK, WebviewUrl::App("index.html#quick".into()))
        .title("New task")
        .inner_size(QUICK_SIZE.0, QUICK_SIZE.1)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        // A floating panel: no title bar, see-through so the corners can be round,
        // and a native shadow (on Windows 11 this also gives the rounded corners).
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        // Same origin as the main window, so both share settings such as the theme.
        .use_https_scheme(true);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let builder = builder.effects(quick_effects(None));
    if let Err(e) = builder.build() {
        eprintln!("quick entry window failed to open: {e}");
        show_main(app);
    }
}

/// The quick-entry window follows the app's light/dark choice, which can differ
/// from the system's: the native backdrop and the window's appearance switch with it.
#[tauri::command]
fn quick_window_theme(app: AppHandle, dark: bool) {
    if let Some(w) = app.get_webview_window(QUICK) {
        let _ = w.set_theme(Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light }));
        #[cfg(target_os = "windows")]
        let _ = w.set_effects(quick_effects(Some(dark)));
    }
}

#[tauri::command]
fn set_close_to_tray(state: tauri::State<'_, CloseToTray>, enabled: bool) {
    state.0.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn show_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn show_quick_entry(app: AppHandle) {
    show_quick(&app);
}

/// Called by the quick-entry page once it has loaded and can talk to the app. Only
/// the Windows smoke test in CI listens: with TODO_SMOKE_FILE set it notes the
/// moment in that file, which proves the window didn't freeze on creation.
#[tauri::command]
fn quick_ready() {
    if let Some(path) = std::env::var_os("TODO_SMOKE_FILE") {
        let _ = std::fs::write(path, "quick-entry ready\n");
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // A second launch focuses the running copy: the local database can only be open once.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
                if args.iter().any(|a| a == "--quick-add") {
                    show_quick(app);
                } else {
                    show_main(app);
                }
            }))
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--hidden"]),
            ));
    }

    builder
        .plugin(
            // Remember size and position, but not visibility: the window starts hidden and setup decides.
            // The quick-entry window always opens centred.
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .with_denylist(&[QUICK])
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .manage(CloseToTray(AtomicBool::new(true)))
        .invoke_handler(tauri::generate_handler![set_close_to_tray, show_window, show_quick_entry, quick_window_theme, quick_ready, quit, db::db_query, db::db_batch])
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(db::Db::open(&dir.join("todo.sqlite3"))?);

            let show = MenuItem::with_id(app, "show", "Open ToDo", true, None::<&str>)?;
            let add = MenuItem::with_id(app, "quick-add", "New task…", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit ToDo", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &add, &sep, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("ToDo")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quick-add" => show_quick(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Started at login: stay in the tray until asked for.
            let hidden = std::env::args().any(|a| a == "--hidden");
            if !hidden {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == QUICK {
                    // Alt+F4 and the like: keep the window for next time.
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label() == MAIN {
                    if window.state::<CloseToTray>().0.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        // Closing the main window quits, also when the hidden quick-entry window exists.
                        window.app_handle().exit(0);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the ToDo desktop app")
        .run(|app, event| {
            // macOS: clicking the Dock icon brings the hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            let _ = (app, &event);
        });
}
