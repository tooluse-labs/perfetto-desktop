#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_bridge;

fn main() {
    tauri::Builder::default()
        .manage(agent_bridge::AgentBridgeState::default())
        .invoke_handler(agent_bridge::commands())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("failed to launch Perfetto Desktop Tauri runtime");
}
