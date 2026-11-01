// Statslock Companion — VAC-safe: never reads game memory, injects or hooks.
// It only polls the process list, reads Steam's registry key and fetches
// public data from statslock.io.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use sysinfo::{ProcessRefreshKind, RefreshKind, System};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const SITE: &str = "https://statslock.io";
const GAME_EXES: [&str; 2] = ["deadlock.exe", "project8.exe"];
const DEFAULT_HOTKEY: &str = "F8";

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    hotkey: String,
    opacity: f32,
}
impl Default for Settings {
    fn default() -> Self { Self { hotkey: DEFAULT_HOTKEY.into(), opacity: 0.94 } }
}

#[derive(Default)]
struct AppState {
    meta: Mutex<Option<serde_json::Value>>,
    meta_error: Mutex<Option<String>>,
    game_running: Mutex<bool>,
    settings: Mutex<Settings>,
}

fn data_dir() -> PathBuf { dirs::data_local_dir().unwrap_or_default().join("StatslockCompanion") }
fn cache_path() -> PathBuf { data_dir().join("meta.json") }
fn settings_path() -> PathBuf { data_dir().join("settings.json") }

fn load_settings() -> Settings {
    std::fs::read_to_string(settings_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn save_settings(s: &Settings) {
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(settings_path(), serde_json::to_string_pretty(s).unwrap_or_default());
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("StatslockCompanion/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
}

/// Load the on-disk cache instantly, then download today's bundle.
async fn refresh_meta(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.meta.lock().unwrap().is_none() {
        if let Some(v) = std::fs::read_to_string(cache_path()).ok().and_then(|s| serde_json::from_str(&s).ok()) {
            *state.meta.lock().unwrap() = Some(v);
            let _ = app.emit("meta-updated", ());
        }
    }
    let fresh = async {
        let r = client().get(format!("{SITE}/api/public/companion/meta")).send().await?.error_for_status()?;
        r.json::<serde_json::Value>().await
    }
    .await;
    match fresh {
        Ok(v) => {
            let _ = std::fs::create_dir_all(data_dir());
            let _ = std::fs::write(cache_path(), v.to_string());
            *state.meta.lock().unwrap() = Some(v);
            *state.meta_error.lock().unwrap() = None;
        }
        Err(e) => *state.meta_error.lock().unwrap() = Some(format!("Couldn't download meta builds: {e}")),
    }
    let _ = app.emit("meta-updated", ());
}

#[tauri::command]
fn get_meta(state: State<AppState>) -> serde_json::Value {
    serde_json::json!({ "data": state.meta.lock().unwrap().clone(), "error": state.meta_error.lock().unwrap().clone() })
}

#[tauri::command]
async fn reload_meta(app: AppHandle) { refresh_meta(&app).await; }

/// Live match lookup done natively (no browser CORS/CSP surprises).
#[tauri::command]
async fn get_live(account_id: u32) -> Result<serde_json::Value, String> {
    let r = client()
        .get(format!("{SITE}/api/public/companion/live?account_id={account_id}"))
        .send().await.map_err(|_| "Can't reach statslock.io — check your internet.".to_string())?;
    if !r.status().is_success() { return Err(format!("Live lookup failed ({}). Retrying…", r.status().as_u16())); }
    r.json().await.map_err(|e| e.to_string())
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

#[tauri::command]
fn game_running(state: State<AppState>) -> bool { *state.game_running.lock().unwrap() }

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings { state.settings.lock().unwrap().clone() }

/// Swap the global hotkey. Rolls back to the old one if the new key can't be registered.
#[tauri::command]
fn set_hotkey(app: AppHandle, state: State<AppState>, hotkey: String) -> Result<String, String> {
    let new: Shortcut = hotkey.parse().map_err(|_| format!("\"{hotkey}\" isn't a valid key combination."))?;
    let old_str = state.settings.lock().unwrap().hotkey.clone();
    let gs = app.global_shortcut();
    if let Ok(old) = old_str.parse::<Shortcut>() { let _ = gs.unregister(old); }
    if let Err(e) = gs.register(new) {
        if let Ok(old) = old_str.parse::<Shortcut>() { let _ = gs.register(old); }
        return Err(format!("That key is already used by another app ({e})."));
    }
    let mut s = state.settings.lock().unwrap();
    s.hotkey = hotkey.clone();
    save_settings(&s);
    Ok(hotkey)
}

#[tauri::command]
fn set_opacity(state: State<AppState>, opacity: f32) {
    let mut s = state.settings.lock().unwrap();
    s.opacity = opacity.clamp(0.5, 1.0);
    save_settings(&s);
}

#[tauri::command]
fn hide_overlay(app: AppHandle) { if let Some(w) = app.get_webview_window("overlay") { let _ = w.hide(); } }

/// Opens statslock.io links in the default browser (only https://statslock.io).
#[tauri::command]
fn open_url(url: String) {
    if !url.starts_with("https://statslock.io/") { return; }
    #[cfg(windows)]
    { let _ = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn(); }
}

fn game_is_running(sys: &mut System) -> bool {
    sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_exe(sysinfo::UpdateKind::OnlyIfNotSet));
    sys.processes().values().any(|p| {
        let n = p.name().to_string_lossy().to_lowercase();
        let exe = p.exe().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        GAME_EXES.contains(&n.as_str()) || n.contains("project8") || exe.contains("project8.exe") || exe.contains("\\deadlock\\game\\")
    })
}

fn show_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = app.emit("overlay-shown", ());
    }
}

fn toggle_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        // Show without taking focus so Deadlock stays the active window.
        if w.is_visible().unwrap_or(false) { let _ = w.hide(); } else { show_overlay(app); }
    }
}

fn main() {
    let settings = load_settings();
    tauri::Builder::default()
        .manage(AppState { settings: Mutex::new(settings), ..Default::default() })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                // Only our one hotkey is ever registered, so any press toggles.
                .with_handler(|app, _sc, ev| { if ev.state() == ShortcutState::Pressed { toggle_overlay(app); } })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_meta, reload_meta, get_live, steam_account_id, game_running,
            get_settings, set_hotkey, set_opacity, hide_overlay, open_url
        ])
        .setup(move |app| {
            // Register saved hotkey; fall back to F8 if it's invalid or taken.
            let state = app.state::<AppState>();
            let wanted = state.settings.lock().unwrap().hotkey.clone();
            let ok = wanted.parse::<Shortcut>().ok().map(|s| app.global_shortcut().register(s).is_ok()).unwrap_or(false);
            if !ok {
                if let Ok(f8) = DEFAULT_HOTKEY.parse::<Shortcut>() { let _ = app.global_shortcut().register(f8); }
                state.settings.lock().unwrap().hotkey = DEFAULT_HOTKEY.into();
            }

            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show / hide overlay", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Statslock Companion — double-click to open")
                .menu(&Menu::with_items(app, &[&show, &settings, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => toggle_overlay(app),
                    "settings" => { show_overlay(app); let _ = app.emit("open-tab", "settings"); }
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = ev { show_overlay(tray.app_handle()); }
                })
                .build(app)?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Meta first so the UI has data, then silent self-update.
                refresh_meta(&handle).await;
                if let Ok(updater) = tauri_plugin_updater::UpdaterExt::updater(&handle) {
                    if let Ok(Some(u)) = updater.check().await {
                        let _ = u.download_and_install(|_, _| {}, || {}).await;
                    }
                }
                let state = handle.state::<AppState>();
                let mut sys = System::new_with_specifics(RefreshKind::new());
                let mut ticks: u64 = 0;
                loop {
                    let running = game_is_running(&mut sys);
                    let was = std::mem::replace(&mut *state.game_running.lock().unwrap(), running);
                    if running != was {
                        let _ = handle.emit("game-state", running);
                        if running { refresh_meta(&handle).await; }
                    }
                    ticks += 1;
                    if ticks % 450 == 0 { refresh_meta(&handle).await; } // ~hourly
                    tokio::time::sleep(Duration::from_secs(8)).await;
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Statslock Companion");
}
