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
        .setup(move |_| {
            agent_bridge::spawn_auto_start(agent_bridge_auto_start.clone());
            Ok(())
        })
        .invoke_handler(agent_bridge::commands())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("failed to launch Perfetto Desktop Tauri runtime");
}
