use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// Opens a plain webview window over an external URL (e.g. the DSH web UI).
// The window has no Workflow capabilities; it is just a browser surface.
#[tauri::command]
fn open_web_window(app: tauri::AppHandle, url: String, title: String) -> Result<(), String> {
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|error| format!("invalid url: {error}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let label = format!("web-{stamp}");
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(parsed))
        .title(title)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_web_window])
        .setup(|app| {
            let handle = app.handle();
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.set_title("Workflow");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Workflow desktop shell");
}
