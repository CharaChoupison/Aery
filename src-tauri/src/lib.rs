//! Partie native de l'appli (Rust). Elle remplace le plugin Vite de la version web :
//!  - settings : clé FreeLLMAPI dans le Trousseau macOS + port ;
//!  - proxy    : relais en streaming vers FreeLLMAPI, qui ajoute la clé ;
//!  - admin    : API d’admin FreeLLMAPI (statistiques en lecture + activer un modèle, stratégie de routage, ajouter/supprimer une clé) ;
//!  - launcher : lance FreeLLMAPI en arrière-plan si elle n'est pas ouverte ;
//!  - updates  : mise à jour de l'appli depuis le repo git du projet.

mod admin;
mod launcher;
mod proxy;
mod settings;
mod updates;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(proxy::Requests::default())
        .manage(admin::DashboardSession::default())
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
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'appli");
}
