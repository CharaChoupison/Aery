//! Partie native de l'appli (Rust). Elle remplace le plugin Vite de la version web :
//!  - settings : clé FreeLLMAPI dans le Trousseau macOS + port, ou adresse du serveur Aery ;
//!  - proxy    : relais en streaming vers FreeLLMAPI (qui ajoute la clé) ou vers le serveur Aery (chat, admin, synchro) ;
//!  - admin    : API d’admin FreeLLMAPI (statistiques en lecture + activer un modèle, stratégie de routage, ajouter/supprimer une clé) ;
//!  - launcher : lance FreeLLMAPI en arrière-plan si elle n'est pas ouverte ;
//!  - onboarding : premier lancement (trouver FreeLLMAPI, tester la clé avant de l'enregistrer) ;
//!  - updates  : mise à jour de l'appli depuis le repo git du projet ;
//!  - workspace : dossiers de travail de l'agent (lecture seule : lister, lire, chercher) ;
//!  - vault    : export du second cerveau en dossier Markdown (coffre Obsidian) ;
//!  - dictation : dictée vocale transcrite sur le Mac (micro + Whisper, rien n'est envoyé) ;
//!  - backup   : enregistre la sauvegarde d'Aery là où l'utilisateur l'a choisi.

mod admin;
mod backup;
mod dictation;
#[cfg(target_os = "macos")]
mod system_audio;
mod launcher;
mod onboarding;
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
        .manage(dictation::Dictation::default())
        .setup(|app| {
            // whisper.cpp écrit beaucoup dans la console : on le fait taire (journaux redirigés vers `log`, sans sortie).
            whisper_rs::install_logging_hooks();
            // Dès l'ouverture, pour que FreeLLMAPI soit prête avant le premier message
            // (sauf avec un serveur Aery : c'est lui qui parle à FreeLLMAPI).
            if settings::read_server(app.handle()).is_none() {
                let port = settings::read_port(app.handle());
                tauri::async_runtime::spawn(launcher::ensure_running(port));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            onboarding::freellm_status,
            onboarding::connect_freellm,
            onboarding::open_freellm,
            onboarding::open_freellm_download,
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
            dictation::dictation_status,
            dictation::download_dictation_model,
            dictation::cancel_dictation_download,
            dictation::delete_dictation_model,
            dictation::start_dictation,
            dictation::stop_dictation,
            dictation::cancel_dictation,
            backup::save_backup,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'appli");
}
