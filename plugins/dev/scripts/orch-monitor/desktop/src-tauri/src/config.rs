// Server URL configuration for the Catalyst desktop client.
//
// The desktop app is a server-agnostic CLIENT — it hardcodes no host. The
// effective server URL is resolved in this order:
//   1. stored user config  (~/Library/Application Support/<id>/config.json)
//   2. CATALYST_MONITOR_URL env override (dev / the author's own build)
//   3. None  → the frontend shows the first-run setup screen
//
// Reachability is tested HERE (Rust/reqwest), not from the loader page, to
// avoid cross-origin (CORS) restrictions against an arbitrary server.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Default, Serialize, Deserialize)]
struct StoredConfig {
    #[serde(rename = "serverUrl", default)]
    server_url: Option<String>,
}

fn config_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("config.json"))
}

fn load(app: &tauri::AppHandle) -> StoredConfig {
    config_file(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn store(app: &tauri::AppHandle, url: Option<String>) {
    let Some(path) = config_file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(&StoredConfig { server_url: url }) {
        let _ = fs::write(path, s);
    }
}

fn normalize(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Effective server URL: stored config → CATALYST_MONITOR_URL env → None.
pub fn effective_url(app: &tauri::AppHandle) -> Option<String> {
    load(app)
        .server_url
        .map(|s| normalize(&s))
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("CATALYST_MONITOR_URL")
                .ok()
                .map(|s| normalize(&s))
                .filter(|s| !s.is_empty())
        })
}

/// Forget the stored server (used by the "Change Server" flow).
pub fn clear(app: &tauri::AppHandle) {
    store(app, None);
}

#[tauri::command]
pub fn get_server_url(app: tauri::AppHandle) -> Option<String> {
    effective_url(&app)
}

#[tauri::command]
pub fn set_server_url(app: tauri::AppHandle, url: String) {
    store(&app, Some(normalize(&url)));
}

#[tauri::command]
pub fn clear_server_url(app: tauri::AppHandle) {
    clear(&app);
}

/// Reachability probe for the setup screen's "Test connection" and for the
/// loader before it navigates to a configured server. Treats any HTTP response
/// below 500 as reachable (a 401/404 still proves the host is answering).
#[tauri::command]
pub async fn test_connection(url: String) -> bool {
    let url = normalize(&url);
    if url.is_empty() {
        return false;
    }
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    else {
        return false;
    };
    match client.get(&url).send().await {
        Ok(resp) => resp.status().as_u16() < 500,
        Err(_) => false,
    }
}
