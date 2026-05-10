#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_bridge;

use tauri::Manager;

fn main() {
    let agent_bridge_state = agent_bridge::AgentBridgeState::default();
    let agent_bridge_auto_start = agent_bridge_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(agent_bridge_state)
        .setup(move |app| {
            let main_window = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .expect("main window config is missing");
            let mut main_window_builder =
                tauri::WebviewWindowBuilder::from_config(app, main_window)?;

            #[cfg(target_os = "windows")]
            {
                main_window_builder = main_window_builder
                    .data_directory(app.path().app_local_data_dir()?.join("webview-v2"));
            }

            main_window_builder.build()?;
            agent_bridge::spawn_auto_start(agent_bridge_auto_start.clone());
            Ok(())
        })
        .invoke_handler(agent_bridge::commands())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("failed to launch Perfetto Desktop Tauri runtime");
}
