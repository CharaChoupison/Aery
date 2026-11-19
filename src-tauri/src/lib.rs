//! Partie native de l'appli (Rust). Elle remplace le plugin Vite de la version web :
//!  - settings : clé FreeLLMAPI dans le Trousseau macOS + port ;
//!  - proxy    : relais en streaming vers FreeLLMAPI, qui ajoute la clé ;
//!  - admin    : statistiques FreeLLMAPI en lecture seule (analytique, journaux, modèles).

mod admin;
mod proxy;
mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(proxy::Requests::default())
        .manage(admin::DashboardSession::default())
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            proxy::proxy_request,
            proxy::cancel_request,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'appli");
}
