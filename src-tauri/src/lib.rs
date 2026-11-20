//! Partie native de l'appli (Rust). Elle remplace le plugin Vite de la version web :
//!  - settings : clé FreeLLMAPI dans le Trousseau macOS + port ;
//!  - proxy    : relais en streaming vers FreeLLMAPI, qui ajoute la clé ;
//!  - admin    : API d’admin FreeLLMAPI (statistiques en lecture + activer un modèle, stratégie de routage, ajouter/supprimer une clé) ;
//!  - launcher : lance FreeLLMAPI en arrière-plan si elle n'est pas ouverte ;
//!  - updates  : mise à jour de l'appli depuis le repo git du projet ;
//!  - workspace : dossiers de travail de l'agent (lecture seule : lister, lire, chercher) ;
//!  - vault    : export du second cerveau en dossier Markdown (coffre Obsidian).

mod admin;
mod launcher;
mod proxy;
mod settings;
mod updates;
mod vault;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Fenêtre « Choisir un dossier », utilisée seulement côté Rust (aucune permission pour l'interface).
        .plugin(tauri_plugin_dialog::init())
        .manage(proxy::Requests::default())
        .manage(admin::DashboardSession::default())
        .manage(workspace::Workspaces::default())
        .setup(|app| {
            // Dès l'ouverture, pour que FreeLLMAPI soit prête avant le premier message.
            let port = settings::read_port(app.handle());
            tauri::async_runtime::spawn(launcher::ensure_running(port));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            proxy::proxy_request,
            proxy::cancel_request,
            updates::check_updates,
            updates::run_update,
            workspace::pick_workspace,
            workspace::workspace_tool,
            workspace::release_workspace,
            vault::get_vault,
            vault::pick_vault,
            vault::forget_vault,
            vault::export_vault,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'appli");
}
