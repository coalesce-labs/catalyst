use tauri::{WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    // Written by the TS pre-step (write-window-url.ts) before `tauri dev/build`.
    // Single source of truth for the URL lives in desktop/src/monitor-url.ts.
    let url = include_str!("../gen/window-url.txt").trim();

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(url.parse().expect("valid monitor URL")),
            )
            .title("orch-monitor")
            .inner_size(1400.0, 900.0)
            .decorations(false)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running orch-monitor desktop");
}
