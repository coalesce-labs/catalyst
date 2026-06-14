// Catalyst desktop shell.
//
// Beyond hosting the chrome-less window (configured in tauri.conf.json), the
// shell runs two small native bridges against the monitor over HTTPS:
//
//   attention_bridge (polls /api/board):
//     * Dock badge   = # of tickets needing a HUMAN (attention != null:
//                      needs-human ∪ waiting-on-you). NOT queue depth — the
//                      autonomous pipeline handles the queue itself; the badge
//                      is reserved for "something is waiting for YOU".
//     * Notification = a ticket that NEWLY needs you (deduped by id; the
//                      existing set is baselined on first poll so it won't
//                      spam on launch). Body is the escalation's humanQuestion.
//
//   health_bridge (subscribes to /api/nav/stream):
//     * Notification = daemon health transitions + a newly-raised board anomaly.
//
// Both are Rust-side: no changes to the remote dashboard, no remote-IPC opt-in.
// Same "event → notification" pattern will later fan to iPad/iPhone push.

use std::collections::HashSet;

use futures_util::StreamExt;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

const DEFAULT_MONITOR_URL: &str = "https://mini.tail32996b.ts.net:8443";

/// Monitor origin the bridges talk to (mirrors the window URL resolution).
fn monitor_base() -> String {
    std::env::var("CATALYST_MONITOR_URL")
        .ok()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_MONITOR_URL.to_string())
}

fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = handle.notification().request_permission();
            notify(&handle, "Catalyst", "Connected — watching the fleet");
            tauri::async_runtime::spawn(attention_bridge(handle.clone()));
            tauri::async_runtime::spawn(health_bridge(handle));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Polls /api/board: Dock badge = # needing a human, and a notification when a
/// ticket newly enters that set.
async fn attention_bridge(app: tauri::AppHandle) {
    let url = format!("{}/api/board", monitor_base());
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut known: HashSet<String> = HashSet::new();
    let mut first_poll = true;

    loop {
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(board) = resp.json::<serde_json::Value>().await {
                // Collect tickets needing a human: (id, attention-kind, body).
                let mut current: Vec<(String, String, String)> = Vec::new();
                if let Some(tickets) = board.get("tickets").and_then(|t| t.as_array()) {
                    for t in tickets {
                        let Some(att) = t.get("attention").and_then(serde_json::Value::as_str) else {
                            continue;
                        };
                        let id = t
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("?")
                            .to_string();
                        let body = t
                            .get("humanQuestion")
                            .and_then(serde_json::Value::as_str)
                            .filter(|s| !s.is_empty())
                            .or_else(|| t.get("title").and_then(serde_json::Value::as_str))
                            .unwrap_or("needs your attention")
                            .to_string();
                        current.push((id, att.to_string(), body));
                    }
                }

                // Dock badge = count (cleared at zero).
                if let Some(win) = app.get_webview_window("main") {
                    let n = current.len() as i64;
                    let _ = win.set_badge_count(if n > 0 { Some(n) } else { None });
                }

                // Notify on newly-attention tickets — but baseline the first poll
                // so we don't fire for everything that already needed you at launch.
                if !first_poll {
                    for (id, att, body) in &current {
                        if !known.contains(id) {
                            let label = if att == "needs-human" {
                                "needs your decision"
                            } else {
                                "is waiting on you"
                            };
                            notify(&app, &format!("{id} {label}"), body);
                        }
                    }
                }

                known = current.into_iter().map(|(id, _, _)| id).collect();
                first_poll = false;
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    }
}

/// Subscribes to /api/nav/stream and notifies on fleet-health transitions.
async fn health_bridge(app: tauri::AppHandle) {
    let url = format!("{}/api/nav/stream", monitor_base());
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut prev_daemon: Option<String> = None;
    let mut prev_anomaly: Option<bool> = None;

    loop {
        if let Ok(resp) = client.get(&url).send().await {
            let mut stream = resp.bytes_stream();
            let mut buf = String::new();
            while let Some(Ok(chunk)) = stream.next().await {
                buf.push_str(&String::from_utf8_lossy(chunk.as_ref()));
                while let Some(pos) = buf.find('\n') {
                    let line: String = buf.drain(..=pos).collect();
                    let line = line.trim();
                    if let Some(data) = line.strip_prefix("data:") {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(data.trim()) {
                            handle_nav(&app, &v, &mut prev_daemon, &mut prev_anomaly);
                        }
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

fn handle_nav(
    app: &tauri::AppHandle,
    v: &serde_json::Value,
    prev_daemon: &mut Option<String>,
    prev_anomaly: &mut Option<bool>,
) {
    // Daemon health transition → notify (degrade and recovery).
    if let Some(daemon) = v.get("daemon").and_then(serde_json::Value::as_str) {
        if let Some(prev) = prev_daemon.as_deref() {
            if prev != daemon {
                if daemon == "healthy" {
                    notify(app, "Catalyst — daemon recovered", "Fleet daemon is healthy again");
                } else {
                    notify(app, "Catalyst — daemon degraded", &format!("Daemon state: {daemon}"));
                }
            }
        }
        *prev_daemon = Some(daemon.to_string());
    }

    // Board anomaly newly raised (false → true) → notify once.
    if let Some(anomaly) = v.get("anomaly").and_then(serde_json::Value::as_bool) {
        if *prev_anomaly == Some(false) && anomaly {
            notify(app, "Catalyst — board anomaly", "A board anomaly was detected — take a look");
        }
        *prev_anomaly = Some(anomaly);
    }
}
