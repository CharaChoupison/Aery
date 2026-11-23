//! Réglages de l'appli : la clé FreeLLMAPI (dans le Trousseau macOS), le port, et le serveur Aery.
//!
//! Serveur Aery (facultatif) : si une adresse est enregistrée (ex. https://pronoti.xxx.ts.net), TOUT passe
//! par ce serveur (chat, statistiques, synchro) : c'est lui qui garde la clé et parle à FreeLLMAPI.
//! Seules les adresses Tailscale en HTTPS sont acceptées (le serveur n'est joignable que via ton réseau privé).
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
    /// Adresse du serveur Aery, si l'appli passe par lui.
    server: Option<String>,
}

impl Settings {
    pub fn key_hint(&self) -> Option<&str> {
        self.key_hint.as_deref()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    api_key: Option<String>,
    #[serde(default)]
    delete_key: bool,
    port: Option<u16>,
    /// Some("") = ne plus passer par un serveur ; Some(adresse) = l'utiliser ; None = ne pas toucher.
    server: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct FileConfig {
    port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    server: Option<String>,
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

/// Enregistre la clé dans le Trousseau (après validation du format).
pub fn store_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    if !is_valid_key(key) {
        return Err("Clé invalide : pas d’espaces, entre 8 et 512 caractères.".into());
    }
    keychain_entry()?
        .set_password(key)
        .map_err(|e| format!("Enregistrement impossible dans le Trousseau : {e}"))
}

// --- Port (petit fichier JSON dans le dossier de config de l'appli) -------------------

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("config.json"))
        .map_err(|e| format!("Dossier de configuration introuvable : {e}"))
}

fn read_config(app: &AppHandle) -> FileConfig {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<FileConfig>(&s).ok())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, config: &FileConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Écriture atomique : fichier temporaire puis renommage.
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn read_port(app: &AppHandle) -> u16 {
    read_config(app).port.filter(|p| *p > 0).unwrap_or(DEFAULT_PORT)
}

pub fn write_port(app: &AppHandle, port: u16) -> Result<(), String> {
    let mut config = read_config(app);
    config.port = Some(port);
    write_config(app, &config)
}

// --- Serveur Aery ------------------------------------------------------------------------

/// « https://pronoti.tail31af72.ts.net/ » → « https://pronoti.tail31af72.ts.net », ou None si refusée :
/// HTTPS obligatoire, adresse Tailscale (*.ts.net) seulement, sans identifiants, chemin, paramètres ni ancre.
pub fn normalize_server(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let label_ok = |l: &str| !l.is_empty() && l.len() <= 63 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let ok = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none()
        && host.ends_with(".ts.net")
        && host.split('.').count() >= 4
        && host.split('.').all(label_ok);
    ok.then(|| match url.port() {
        Some(port) => format!("https://{host}:{port}"),
        None => format!("https://{host}"),
    })
}

/// Serveur Aery enregistré (revalidé à chaque lecture).
pub fn read_server(app: &AppHandle) -> Option<String> {
    read_config(app).server.as_deref().and_then(normalize_server)
}

// --- Commandes appelées par l'interface ---------------------------------------------------

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    // Avec un serveur Aery, la clé est sur le serveur : rien à saisir ici.
    if let Some(server) = read_server(&app) {
        return Ok(Settings { has_key: true, key_hint: Some("sur le serveur".into()), port: read_port(&app), server: Some(server) });
    }
    let key = read_key()?;
    Ok(Settings {
        has_key: key.is_some(),
        key_hint: key.as_deref().map(key_hint),
        port: read_port(&app),
        server: None,
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
        store_key(&key)?;
    }

    if let Some(port) = update.port {
        if port == 0 {
            return Err("Le port doit être un entier entre 1 et 65535.".into());
        }
        write_port(&app, port)?;
    }

    if let Some(server) = update.server {
        let mut config = read_config(&app);
        config.server = if server.trim().is_empty() {
            None
        } else {
            Some(normalize_server(&server).ok_or(
                "Adresse refusée : il faut l’adresse Tailscale de ton serveur en HTTPS (ex. https://serveur.xxxx.ts.net).",
            )?)
        };
        write_config(&app, &config)?;
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
    fn only_tailscale_https_servers_are_accepted() {
        assert_eq!(normalize_server("https://pronoti.tail31af72.ts.net/").as_deref(), Some("https://pronoti.tail31af72.ts.net"));
        assert_eq!(normalize_server(" https://Pronoti.Tail31af72.ts.net ").as_deref(), Some("https://pronoti.tail31af72.ts.net"));
        assert_eq!(normalize_server("https://pronoti.tail31af72.ts.net:8443").as_deref(), Some("https://pronoti.tail31af72.ts.net:8443"));
        assert!(normalize_server("http://pronoti.tail31af72.ts.net").is_none()); // pas HTTPS
        assert!(normalize_server("https://evil.com").is_none()); // pas Tailscale
        assert!(normalize_server("https://ts.net.evil.com").is_none());
        assert!(normalize_server("https://evil.ts.net").is_none()); // pas une machine d'un réseau
        assert!(normalize_server("https://user:pw@pronoti.tail31af72.ts.net").is_none());
        assert!(normalize_server("https://pronoti.tail31af72.ts.net/v1").is_none());
        assert!(normalize_server("https://pronoti.tail31af72.ts.net/?x=1").is_none());
        assert!(normalize_server("pronoti.tail31af72.ts.net").is_none());
        assert!(normalize_server("").is_none());
    }

    #[test]
    fn hints_never_reveal_the_key() {
        assert_eq!(key_hint("freellmapi-abcdef123456"), "freellmapi-…3456");
        assert_eq!(key_hint("autre-cle-1234wxyz"), "…wxyz");
    }
}
