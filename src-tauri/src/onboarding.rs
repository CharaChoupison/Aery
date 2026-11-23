//! Premier lancement : trouver FreeLLMAPI, la démarrer, puis tester la clé AVANT de l'enregistrer.
//!
//! - `freellm_status` : FreeLLMAPI est-elle installée, lancée, et sur quel port répond-elle ?
//!   On essaie le port demandé (options avancées), sinon le port enregistré puis 31415, puis les
//!   ports sur lesquels le processus FreeLLMAPI écoute vraiment (elle en change si 31415 est pris).
//! - `connect_freellm` : teste la clé sur `GET /v1/models?available=true` ; elle n'est gardée
//!   dans le Trousseau (avec le port) que si FreeLLMAPI l'accepte. L'interface ne la revoit jamais.
//! - `open_freellm` / `open_freellm_download` : commandes et adresse figées ici.

use crate::{launcher, settings};
use serde::Serialize;
use std::{path::Path, process::Command, time::Duration};
use tauri::AppHandle;

const DOWNLOAD_URL: &str = "https://github.com/tashfeenahmed/freellmapi/releases";

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FreellmStatus {
    /// L'appli FreeLLMAPI est sur le Mac.
    installed: bool,
    /// Son processus tourne.
    running: bool,
    /// Son API répond sur `port`.
    reachable: bool,
    /// Port où elle répond (ou, à défaut, celui qu'on a essayé en premier).
    port: u16,
    /// Port enregistré dans les réglages d'Aery.
    saved_port: u16,
}

/// Résultat du test de la clé. `ok` = clé acceptée et enregistrée.
#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ConnectResult {
    Ok { key_hint: Option<String>, port: u16 },
    InvalidKey { message: String },
    Unreachable { message: String },
    Error { message: String },
}

fn client(timeout: Duration) -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy() // jamais de proxy système pour 127.0.0.1
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_millis(800))
        .timeout(timeout)
        .build()
        .ok()
}

/// Est-ce bien l'API de FreeLLMAPI qui répond ? Sans clé, `/v1/models` renvoie 401 avec
/// `{ "error": … }` en JSON (ou 200 avec `data` sur une version qui ne demande pas de clé).
/// Une autre appli sur le port (page HTML, 404…) ne compte pas.
pub async fn probe(port: u16) -> bool {
    let Some(client) = client(Duration::from_secs(3)) else { return false };
    let Ok(response) = client.get(format!("http://127.0.0.1:{port}/v1/models")).send().await else { return false };
    let status = response.status().as_u16();
    let Ok(body) = response.text().await else { return false };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) else { return false };
    match status {
        401 | 403 => json.get("error").is_some(),
        200 => json.get("data").is_some_and(|d| d.is_array()),
        _ => false,
    }
}

fn is_installed() -> bool {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    Path::new("/Applications/FreeLLMAPI.app").exists()
        || home.is_some_and(|h| h.join("Applications/FreeLLMAPI.app").exists())
}

fn is_running() -> bool {
    Command::new("/usr/bin/pgrep")
        .args(["-x", "FreeLLMAPI"])
        .output()
        .is_ok_and(|o| o.status.success())
}

/// « n127.0.0.1:31415 » (sortie `lsof -F n`) → 31415. Seulement les ports locaux.
fn parse_lsof_ports(output: &str) -> Vec<u16> {
    let mut ports: Vec<u16> = output
        .lines()
        .filter_map(|l| l.strip_prefix('n'))
        .filter_map(|addr| {
            let (host, port) = addr.rsplit_once(':')?;
            matches!(host, "127.0.0.1" | "[::1]" | "localhost" | "*").then(|| port.parse().ok()).flatten()
        })
        .filter(|p| *p > 0)
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// Ports sur lesquels le processus FreeLLMAPI écoute (commande figée).
fn listening_ports() -> Vec<u16> {
    Command::new("/usr/sbin/lsof")
        .args(["-nP", "-a", "-c", "FreeLLMAPI", "-iTCP", "-sTCP:LISTEN", "-Fn"])
        .output()
        .map(|o| parse_lsof_ports(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

async fn find_port(candidates: &[u16], scan: bool) -> Option<u16> {
    for &port in candidates {
        if probe(port).await {
            return Some(port);
        }
    }
    if !scan {
        return None;
    }
    let found = tauri::async_runtime::spawn_blocking(listening_ports).await.unwrap_or_default();
    for port in found.into_iter().filter(|p| !candidates.contains(p)).take(8) {
        if probe(port).await {
            return Some(port);
        }
    }
    None
}

/// Teste une clé sans rien enregistrer (séparé pour les tests).
async fn check_key(port: u16, key: &str) -> ConnectResult {
    let Some(client) = client(Duration::from_secs(20)) else {
        return ConnectResult::Error { message: "Erreur interne de l’appli.".into() };
    };
    let response = client
        .get(format!("http://127.0.0.1:{port}/v1/models?available=true"))
        .header("authorization", format!("Bearer {key}"))
        .send()
        .await;
    match response {
        Err(_) => ConnectResult::Unreachable { message: format!("FreeLLMAPI ne répond plus sur le port {port}.") },
        Ok(r) if r.status().is_success() => ConnectResult::Ok { key_hint: None, port },
        Ok(r) if matches!(r.status().as_u16(), 401 | 403) => ConnectResult::InvalidKey {
            message: "FreeLLMAPI refuse cette clé. Recopie-la avec « Copy Key » et colle-la à nouveau.".into(),
        },
        Ok(r) => ConnectResult::Error { message: format!("FreeLLMAPI a répondu une erreur ({}). Réessaie dans un instant.", r.status().as_u16()) },
    }
}

// --- Commandes appelées par l'interface ---------------------------------------------------

/// `port` : port tapé dans les options avancées (sinon : enregistré, puis 31415, puis détection).
/// `launch` : lancer FreeLLMAPI si elle ne répond pas (attente de 25 s max).
#[tauri::command]
pub async fn freellm_status(app: AppHandle, port: Option<u16>, launch: bool) -> FreellmStatus {
    let saved_port = settings::read_port(&app);
    let candidates: Vec<u16> = match port.filter(|p| *p > 0) {
        Some(p) => vec![p],
        None if saved_port == settings::DEFAULT_PORT => vec![saved_port],
        None => vec![saved_port, settings::DEFAULT_PORT],
    };
    let scan = port.is_none();
    let installed = is_installed();

    let mut found = find_port(&candidates, scan).await;
    if found.is_none() && launch && (installed || is_running()) {
        launcher::ensure_running_now(candidates[0]).await;
        found = find_port(&candidates, scan).await;
        // Elle a pu démarrer sur un autre port (31415 occupé) : on laisse quelques secondes au serveur.
        if found.is_none() && scan {
            for _ in 0..6 {
                tokio_sleep(Duration::from_millis(500)).await;
                found = find_port(&candidates, true).await;
                if found.is_some() {
                    break;
                }
            }
        }
    }

    let running = found.is_some() || is_running();
    FreellmStatus {
        installed: installed || running,
        running,
        reachable: found.is_some(),
        port: found.unwrap_or(candidates[0]),
        saved_port,
    }
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

/// Teste la clé, puis l'enregistre (Trousseau) avec le port seulement si FreeLLMAPI l'accepte.
#[tauri::command]
pub async fn connect_freellm(app: AppHandle, key: String, port: u16) -> ConnectResult {
    let key = key.trim().to_string();
    if !settings::is_valid_key(&key) {
        return ConnectResult::InvalidKey { message: "Ça ne ressemble pas à une clé : pas d’espaces, entre 8 et 512 caractères.".into() };
    }
    if port == 0 {
        return ConnectResult::Error { message: "Le port doit être un entier entre 1 et 65535.".into() };
    }
    match check_key(port, &key).await {
        ConnectResult::Ok { .. } => {}
        other => return other,
    }
    if let Err(message) = settings::store_key(&key).and_then(|_| settings::write_port(&app, port)) {
        return ConnectResult::Error { message };
    }
    match settings::get_settings(app) {
        Ok(s) => ConnectResult::Ok { key_hint: s.key_hint().map(str::to_string), port },
        Err(message) => ConnectResult::Error { message },
    }
}

/// « Ouvrir FreeLLMAPI » : au premier plan, pour voir son port et sa clé.
#[tauri::command]
pub fn open_freellm() {
    launcher::open_visible();
}

/// « Télécharger FreeLLMAPI » : la page des versions, dans le navigateur par défaut (adresse figée).
#[tauri::command]
pub fn open_freellm_download() {
    let _ = Command::new("/usr/bin/open").arg(DOWNLOAD_URL).spawn();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Faux serveur HTTP : répond toujours `status` + `body`, et garde la dernière requête.
    async fn fake(status: &'static str, body: &'static str) -> (u16, std::sync::Arc<std::sync::Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let seen_task = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0; 4096];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                *seen_task.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).to_string();
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        (port, seen)
    }

    #[tokio::test]
    async fn recognizes_freellmapi() {
        let (port, _) = fake("401 Unauthorized", r#"{"error":{"message":"Invalid API key","type":"authentication_error"}}"#).await;
        assert!(probe(port).await);
        let (port, _) = fake("200 OK", r#"{"object":"list","data":[]}"#).await;
        assert!(probe(port).await);
    }

    #[tokio::test]
    async fn ignores_other_servers_and_closed_ports() {
        let (port, _) = fake("200 OK", "<!doctype html><html></html>").await;
        assert!(!probe(port).await, "page HTML");
        let (port, _) = fake("404 Not Found", r#"{"error":"nope"}"#).await;
        assert!(!probe(port).await, "404");
        let closed = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        assert!(!probe(closed).await, "port fermé");
    }

    #[tokio::test]
    async fn checks_key_before_saving() {
        let (port, seen) = fake("401 Unauthorized", r#"{"error":{"message":"Invalid API key"}}"#).await;
        assert!(matches!(check_key(port, "freellmapi-mauvaise").await, ConnectResult::InvalidKey { .. }));
        let request = seen.lock().unwrap().to_lowercase();
        assert!(request.starts_with("get /v1/models?available=true"));
        assert!(request.contains("authorization: bearer freellmapi-mauvaise"));

        let (port, _) = fake("200 OK", r#"{"data":[]}"#).await;
        assert!(matches!(check_key(port, "freellmapi-bonne1234").await, ConnectResult::Ok { .. }));

        let (port, _) = fake("500 Internal Server Error", "{}").await;
        assert!(matches!(check_key(port, "freellmapi-bonne1234").await, ConnectResult::Error { .. }));

        let closed = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        assert!(matches!(check_key(closed, "freellmapi-bonne1234").await, ConnectResult::Unreachable { .. }));
    }

    #[test]
    fn parses_listening_ports() {
        let out = "p22705\nf36\nn127.0.0.1:31415\nf40\nn127.0.0.1:31416\nf41\nn192.168.1.2:9000\nf42\nn[::1]:31415\n";
        assert_eq!(parse_lsof_ports(out), vec![31415, 31416]);
        assert!(parse_lsof_ports("").is_empty());
    }

    /// Contre le vrai FreeLLMAPI lancé sur ce Mac : `cargo test real_freellmapi -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn real_freellmapi() {
        let ports = listening_ports();
        println!("ports de FreeLLMAPI : {ports:?}, installée : {}, lancée : {}", is_installed(), is_running());
        assert!(!ports.is_empty(), "FreeLLMAPI doit tourner");
        let mut found = false;
        for port in ports {
            found |= probe(port).await;
        }
        assert!(found, "son API doit être reconnue");
        assert!(matches!(check_key(settings::DEFAULT_PORT, "freellmapi-fausse-cle-0000").await, ConnectResult::InvalidKey { .. }));
    }
}
