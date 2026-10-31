// Statslock Companion — VAC-safe: never reads game memory, injects or hooks.
// It only polls the process list, reads Steam's registry key and fetches
// public data from statslock.io.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{path::PathBuf, sync::Mutex, time::Duration};
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const META_URL: &str = "https://statslock.io/api/public/companion/meta";
const GAME_EXES: [&str; 2] = ["deadlock.exe", "project8.exe"];

#[derive(Default)]
struct AppState {
    meta: Mutex<Option<serde_json::Value>>,
    game_running: Mutex<bool>,
}

fn cache_path() -> PathBuf {
    dirs::data_local_dir().unwrap_or_default().join("StatslockCompanion").join("meta.json")
}

/// Download today's bundle; fall back to the on-disk cache when offline.
async fn refresh_meta(state: &AppState) {
    let fresh = async { reqwest::get(META_URL).await?.json::<serde_json::Value>().await }.await;
    let value = match fresh {
        Ok(v) => {
            let p = cache_path();
            let _ = std::fs::create_dir_all(p.parent().unwrap());
            let _ = std::fs::write(&p, v.to_string());
            Some(v)
        }
        Err(_) => std::fs::read_to_string(cache_path()).ok().and_then(|s| serde_json::from_str(&s).ok()),
    };
    if value.is_some() {
        *state.meta.lock().unwrap() = value;
    }
}

#[tauri::command]
fn get_meta(state: State<AppState>) -> Option<serde_json::Value> {
    state.meta.lock().unwrap().clone()
}

/// Active Steam account (32-bit ID) from the registry — no typing needed.
#[tauri::command]
fn steam_account_id() -> Option<u32> {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam\\ActiveProcess").ok()?;
        let id: u32 = key.get_value("ActiveUser").ok()?;
        if id > 0 { return Some(id); }
    }
    None
}

fn game_is_running(sys: &mut System) -> bool {
    sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, ProcessRefreshKind::new());
    sys.processes().values().any(|p| {
        let n = p.name().to_string_lossy().to_lowercase();
        GAME_EXES.contains(&n.as_str())
    })
}

fn toggle_overlay(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        if w.is_visible().unwrap_or(false) { let _ = w.hide(); } else { let _ = w.show(); let _ = w.set_focus(); }
    }
}

fn main() {
    let toggle = Shortcut::new(Some(Modifiers::ALT), Code::KeyS);
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, sc, ev| {
                    if sc == &toggle && ev.state() == ShortcutState::Pressed { toggle_overlay(app); }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![get_meta, steam_account_id])
        .setup(move |app| {
            app.global_shortcut().register(toggle)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show overlay (Alt+S)", true, None::<&str>)?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Statslock Companion")
                .menu(&Menu::with_items(app, &[&show, &quit])?)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => toggle_overlay(app),
                    _ => {}
                })
                .build(app)?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Silent self-update on start.
                if let Ok(updater) = tauri_plugin_updater::UpdaterExt::updater(&handle) {
                    if let Ok(Some(u)) = updater.check().await {
                        let _ = u.download_and_install(|_, _| {}, || {}).await;
                    }
                }
                let state = handle.state::<AppState>();
                refresh_meta(&state).await;
                let mut sys = System::new_with_specifics(RefreshKind::new());
                let mut ticks: u64 = 0;
                loop {
                    // Light 8s poll; nothing else runs while the game is closed.
                    let running = game_is_running(&mut sys);
                    let was = std::mem::replace(&mut *state.game_running.lock().unwrap(), running);
                    if running != was {
                        let _ = handle.emit("game-state", running);
                        if running { refresh_meta(&state).await; }
                        else if let Some(w) = handle.get_webview_window("overlay") { let _ = w.hide(); }
                    }
                    ticks += 1;
                    if ticks % 450 == 0 { refresh_meta(&state).await; } // ~hourly
                    tokio::time::sleep(Duration::from_secs(8)).await;
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Statslock Companion");
}
