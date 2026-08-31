use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
