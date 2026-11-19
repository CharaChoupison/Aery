//! Réglages de l'appli : la clé FreeLLMAPI (dans le Trousseau macOS) et le port.
//!
//! Même règle que la version web : l'interface peut ÉCRIRE la clé, mais ne peut jamais la RELIRE.
//! Elle ne reçoit qu'un indice (« freellmapi-…ab12 »).

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "freellm-chat";
const KEYRING_USER: &str = "freellmapi-key";
pub const DEFAULT_PORT: u16 = 31415;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    has_key: bool,
    key_hint: Option<String>,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    api_key: Option<String>,
    #[serde(default)]
    delete_key: bool,
    port: Option<u16>,
}

#[derive(Serialize, Deserialize, Default)]
struct FileConfig {
    port: Option<u16>,
}

// --- Clé (Trousseau) -------------------------------------------------------------------

fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("Trousseau macOS inaccessible : {e}"))
}

/// Lit la clé dans le Trousseau. `Ok(None)` = aucune clé enregistrée.
pub fn read_key() -> Result<Option<String>, String> {
    match keychain_entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Impossible de lire la clé dans le Trousseau macOS : {e}")),
    }
}

/// ASCII imprimable sans espace, 8 à 512 caractères : empêche toute injection d'en-tête HTTP.
pub fn is_valid_key(key: &str) -> bool {
    (8..=512).contains(&key.len()) && key.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// « freellmapi-abcdef123456 » → « freellmapi-…3456 » (la clé est en ASCII, on peut découper sans risque).
fn key_hint(key: &str) -> String {
    let prefix = if key.starts_with("freellmapi-") { "freellmapi-" } else { "" };
    format!("{prefix}…{}", &key[key.len().saturating_sub(4)..])
}

// --- Port (petit fichier JSON dans le dossier de config de l'appli) -------------------

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("config.json"))
        .map_err(|e| format!("Dossier de configuration introuvable : {e}"))
}

pub fn read_port(app: &AppHandle) -> u16 {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<FileConfig>(&s).ok())
        .and_then(|c| c.port)
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_PORT)
}

fn write_port(app: &AppHandle, port: u16) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Écriture atomique : fichier temporaire puis renommage.
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&FileConfig { port: Some(port) }).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// --- Commandes appelées par l'interface ---------------------------------------------------

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    let key = read_key()?;
    Ok(Settings {
        has_key: key.is_some(),
        key_hint: key.as_deref().map(key_hint),
        port: read_port(&app),
    })
}

#[tauri::command]
pub fn save_settings(app: AppHandle, update: SettingsUpdate) -> Result<Settings, String> {
    if update.delete_key {
        match keychain_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("Suppression impossible dans le Trousseau : {e}")),
        }
    } else if let Some(key) = update.api_key {
        let key = key.trim();
        if !is_valid_key(key) {
            return Err("Clé invalide : pas d’espaces, entre 8 et 512 caractères.".into());
        }
        keychain_entry()?
            .set_password(key)
            .map_err(|e| format!("Enregistrement impossible dans le Trousseau : {e}"))?;
    }

    if let Some(port) = update.port {
        if port == 0 {
            return Err("Le port doit être un entier entre 1 et 65535.".into());
        }
        write_port(&app, port)?;
    }

    get_settings(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_keys() {
        assert!(is_valid_key("freellmapi-abcdef123456"));
        assert!(!is_valid_key("court"));
        assert!(!is_valid_key("freellmapi-abc def"));
        assert!(!is_valid_key("freellmapi-abc\r\nX-Evil: 1"));
        assert!(!is_valid_key("freellmapi-é-accent"));
    }

    #[test]
    fn hints_never_reveal_the_key() {
        assert_eq!(key_hint("freellmapi-abcdef123456"), "freellmapi-…3456");
        assert_eq!(key_hint("autre-cle-1234wxyz"), "…wxyz");
    }
}
