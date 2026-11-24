//! Desktop shell for ToDo. The whole app is the same web build as the PWA; this
//! side only adds what a browser can't: a tray icon, closing to the tray, one
//! running copy, a global hotkey and native notifications (the last two are
//! driven from the web side through their plugins).

mod db;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
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

/// Brings the window up and opens quick add.
fn quick_add(app: &AppHandle) {
    show_main(app);
    let _ = app.emit_to(MAIN, "quick-add", ());
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
                    quick_add(app);
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
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .manage(CloseToTray(AtomicBool::new(true)))
        .invoke_handler(tauri::generate_handler![set_close_to_tray, show_window, quit, db::db_query, db::db_batch])
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
                    "quick-add" => quick_add(app),
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
                if window.label() == MAIN && window.state::<CloseToTray>().0.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
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
