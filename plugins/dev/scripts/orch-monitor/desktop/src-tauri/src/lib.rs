// Catalyst desktop shell.
//
// The window loads a small bundled loader (src/index.html). If a server is
// configured + reachable it navigates to that dashboard; otherwise it shows the
// first-run setup screen (see config.rs — no host is hardcoded).
//
// Two Rust-side bridges run against whatever server is configured:
//   attention_bridge (polls /api/board):
//     * Dock badge   = # of tickets needing a HUMAN (attention != null:
//                      needs-human ∪ waiting-on-you). NOT queue depth — the
//                      pipeline handles the queue; the badge is reserved for
//                      "something is waiting for YOU".
//     * Notification = a ticket that NEWLY needs you (deduped; baselined on the
//                      first poll). Body is the escalation's humanQuestion.
//   health_bridge (subscribes to /api/nav/stream):
//     * Notification = daemon health transitions + a newly-raised board anomaly.
//
// Both read the configured URL each loop, so they self-start once the user
// connects and follow a server change. No remote-IPC opt-in; the same
// "event → notification" pattern will later fan to iPad/iPhone push.

mod config;

use std::collections::HashSet;

use futures_util::StreamExt;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            config::get_server_url,
            config::set_server_url,
            config::clear_server_url,
            config::test_connection,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = handle.notification().request_permission();
            tauri::async_runtime::spawn(attention_bridge(handle.clone()));
            tauri::async_runtime::spawn(health_bridge(handle));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Polls /api/board on the configured server: Dock badge = # needing a human,
/// plus a notification when a ticket newly enters that set.
async fn attention_bridge(app: tauri::AppHandle) {
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut known: HashSet<String> = HashSet::new();
    let mut first_poll = true;
    let mut announced = false;

    loop {
        let Some(base) = config::effective_url(&app) else {
            // No server configured yet — wait for the user to connect.
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        };
        if let Ok(resp) = client.get(format!("{base}/api/board")).send().await {
            if let Ok(board) = resp.json::<serde_json::Value>().await {
                if !announced {
                    notify(&app, "Catalyst", &format!("Connected — watching {base}"));
                    announced = true;
                }
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

                if let Some(win) = app.get_webview_window("main") {
                    let n = current.len() as i64;
                    let _ = win.set_badge_count(if n > 0 { Some(n) } else { None });
                }

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

/// Subscribes to /api/nav/stream on the configured server and notifies on
/// fleet-health transitions.
async fn health_bridge(app: tauri::AppHandle) {
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut prev_daemon: Option<String> = None;
    let mut prev_anomaly: Option<bool> = None;

    loop {
        let Some(base) = config::effective_url(&app) else {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        };
        if let Ok(resp) = client.get(format!("{base}/api/nav/stream")).send().await {
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

    if let Some(anomaly) = v.get("anomaly").and_then(serde_json::Value::as_bool) {
        if *prev_anomaly == Some(false) && anomaly {
            notify(app, "Catalyst — board anomaly", "A board anomaly was detected — take a look");
        }
        *prev_anomaly = Some(anomaly);
    }
}
