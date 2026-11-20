//! Relais vers FreeLLMAPI : l'équivalent Rust du proxy de notre plugin Vite.
//!
//! L'interface envoie une requête (méthode, chemin, corps) ; ici on ajoute la clé
//! (lue dans le Trousseau) et on renvoie la réponse morceau par morceau via un `Channel`,
//! pour que le streaming SSE arrive en direct. `cancel_request` coupe tout (bouton Stop).

use crate::{admin, launcher, settings};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State, async_runtime::JoinHandle, ipc::Channel};

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

/// Requêtes en cours, pour pouvoir les annuler.
#[derive(Default)]
pub struct Requests(Mutex<HashMap<u32, JoinHandle<()>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequest {
    id: u32,
    method: String,
    path: String,
    body: Option<String>,
}

/// Ce qu'on renvoie à l'interface, dans l'ordre : Head, puis des Chunk, puis End (ou Error).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProxyEvent {
    Head { status: u16, headers: Vec<(String, String)> },
    Chunk { data: Vec<u8> },
    End,
    Error { message: String },
}

/// Seuls les endpoints utilisés par le chat sont autorisés (réponses, modèles, recherche web
/// et liste des moteurs de recherche actifs).
/// Même si l'interface était compromise, elle ne pourrait pas utiliser la clé pour autre chose.
pub fn is_allowed_path(path: &str) -> bool {
    let base = path.split('?').next().unwrap_or_default();
    matches!(base, "/v1/chat/completions" | "/v1/models" | "/v1/search" | "/v1/search/engines")
        && !path.contains("..")
        && path.chars().all(|c| c.is_ascii_graphic())
}

/// Envoie une erreur au même format JSON que FreeLLMAPI : { error: { code, message } }.
fn emit_json_error(emit: &impl Fn(ProxyEvent) -> bool, status: u16, code: &str, message: &str) {
    let body = serde_json::json!({ "error": { "code": code, "message": message } }).to_string();
    emit(ProxyEvent::Head { status, headers: vec![("content-type".into(), "application/json".into())] });
    emit(ProxyEvent::Chunk { data: body.into_bytes() });
    emit(ProxyEvent::End);
}

/// Fait la requête vers FreeLLMAPI et transmet la réponse via `emit`.
/// `emit` renvoie false si l'interface n'écoute plus : on arrête alors tout de suite.
pub async fn forward(port: u16, key: &str, method: &str, path: &str, body: Option<String>, emit: impl Fn(ProxyEvent) -> bool) {
    let method = match method {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        _ => return emit_json_error(&emit, 405, "method_not_allowed", "Méthode non autorisée"),
    };

    // no_proxy : on ne passe jamais par un proxy système pour parler à 127.0.0.1.
    let client = match reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(5)).build() {
        Ok(c) => c,
        Err(e) => return emit_json_error(&emit, 500, "internal", &e.to_string()),
    };

    // L'hôte est figé à 127.0.0.1 : impossible de détourner le relais vers une autre machine.
    let mut request = client
        .request(method, format!("http://127.0.0.1:{port}{path}"))
        .header("authorization", format!("Bearer {key}"));
    if let Some(body) = body {
        request = request.header("content-type", "application/json").body(body);
    }

    let response = match request.send().await {
        Ok(r) => r,
        Err(_) => {
            let message = format!(
                "FreeLLMAPI ne répond pas sur le port {port}. Aery a essayé de la lancer sans succès : vérifie qu’elle est bien installée, et le port dans les Paramètres."
            );
            return emit_json_error(&emit, 502, "upstream_unreachable", &message);
        }
    };

    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
        .collect();
    if !emit(ProxyEvent::Head { status: response.status().as_u16(), headers }) {
        return;
    }

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                if !emit(ProxyEvent::Chunk { data: bytes.to_vec() }) {
                    return; // interface fermée : on lâche la connexion
                }
            }
            Err(e) => {
                emit(ProxyEvent::Error { message: format!("Connexion à FreeLLMAPI interrompue : {e}") });
                return;
            }
        }
    }
    emit(ProxyEvent::End);
}

// --- Commandes appelées par l'interface ---------------------------------------------------

#[tauri::command]
pub fn proxy_request(
    app: AppHandle,
    state: State<'_, Requests>,
    request: ProxyRequest,
    on_event: Channel<ProxyEvent>,
) -> Result<(), String> {
    // Statistiques FreeLLMAPI (lecture seule) : traitées à part, voir admin.rs.
    if request.path.starts_with("/admin/") {
        return admin_request(app, state, request, on_event);
    }
    if !is_allowed_path(&request.path) {
        return Err("Chemin non autorisé".into());
    }
    if request.body.as_ref().is_some_and(|b| b.len() > MAX_BODY_BYTES) {
        return Err("Requête trop volumineuse".into());
    }

    let key = settings::read_key()?;
    let port = settings::read_port(&app);
    let id = request.id;

    // On garde le verrou pendant le lancement : la tâche ne peut pas se retirer de la liste
    // avant d'y avoir été ajoutée.
    let mut running = state.0.lock().map_err(|_| "Erreur interne")?;
    let task_app = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let emit = |event: ProxyEvent| on_event.send(event).is_ok();
        match key {
            None => emit_json_error(
                &emit,
                401,
                "no_key",
                "Aucune clé FreeLLMAPI configurée. Ouvre les Paramètres pour la coller.",
            ),
            Some(key) => {
                launcher::ensure_running(port).await;
                forward(port, &key, &request.method, &request.path, request.body, emit).await
            }
        }
        if let Ok(mut running) = task_app.state::<Requests>().0.lock() {
            running.remove(&id);
        }
    });
    running.insert(id, handle);
    Ok(())
}

/// Relais des routes /admin/* : lectures en liste blanche + quatre écritures validées (voir admin.rs).
/// Le jeton du dashboard reste côté Rust.
fn admin_request(
    app: AppHandle,
    state: State<'_, Requests>,
    request: ProxyRequest,
    on_event: Channel<ProxyEvent>,
) -> Result<(), String> {
    let (method, api_path, body) = if request.method == "GET" {
        (reqwest::Method::GET, admin::admin_api_path(&request.path).ok_or("Chemin non autorisé")?, None)
    } else {
        admin::admin_write(&request.method, &request.path, request.body.as_deref())?
    };
    let port = settings::read_port(&app);
    let id = request.id;

    let mut running = state.0.lock().map_err(|_| "Erreur interne")?;
    let task_app = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let emit = |event: ProxyEvent| on_event.send(event).is_ok();
        launcher::ensure_running(port).await;
        let session = task_app.state::<admin::DashboardSession>();
        match admin::send(&session, port, method, &api_path, body).await {
            Ok((status, content_type, body)) => {
                if emit(ProxyEvent::Head { status, headers: vec![("content-type".into(), content_type)] }) {
                    emit(ProxyEvent::Chunk { data: body });
                    emit(ProxyEvent::End);
                }
            }
            Err((status, code, message)) => emit_json_error(&emit, status, code, &message),
        }
        if let Ok(mut running) = task_app.state::<Requests>().0.lock() {
            running.remove(&id);
        }
    });
    running.insert(id, handle);
    Ok(())
}

/// Bouton Stop : on arrête la tâche, ce qui ferme la connexion vers FreeLLMAPI.
#[tauri::command]
pub fn cancel_request(state: State<'_, Requests>, id: u32) {
    if let Some(handle) = state.0.lock().ok().and_then(|mut r| r.remove(&id)) {
        handle.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn only_chat_endpoints_are_allowed() {
        assert!(is_allowed_path("/v1/chat/completions"));
        assert!(is_allowed_path("/v1/models?available=true"));
        assert!(is_allowed_path("/v1/search"));
        assert!(is_allowed_path("/v1/search/engines"));
        assert!(!is_allowed_path("/v1/search/../keys"));
        assert!(!is_allowed_path("/v1/keys"));
        assert!(!is_allowed_path("/admin"));
        assert!(!is_allowed_path("/v1/models/../keys"));
        assert!(!is_allowed_path("/v1/models x"));
    }

    /// Faux FreeLLMAPI : vérifie la clé, puis envoie un flux SSE en 3 morceaux espacés.
    async fn fake_upstream() -> (u16, Arc<Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(String::new()));
        let seen_task = seen.clone();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            *seen_task.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).to_string();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nx-routed-via: groq/llama\r\ntransfer-encoding: chunked\r\n\r\n")
                .await
                .unwrap();
            for part in ["data: {\"a\":1}\n\n", "data: {\"b\":\"\u{e9}\"}\n\n", "data: [DONE]\n\n"] {
                let chunk = format!("{:x}\r\n{part}\r\n", part.len());
                socket.write_all(chunk.as_bytes()).await.unwrap();
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            socket.write_all(b"0\r\n\r\n").await.unwrap();
        });
        (port, seen)
    }

    #[tokio::test]
    async fn forwards_stream_with_key() {
        let (port, seen) = fake_upstream().await;
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        forward(port, "freellmapi-test1234", "POST", "/v1/chat/completions", Some("{}".into()), move |e| {
            sink.lock().unwrap().push(e);
            true
        })
        .await;

        let request = seen.lock().unwrap().to_lowercase();
        assert!(request.contains("authorization: bearer freellmapi-test1234"), "clé ajoutée");

        let events = events.lock().unwrap();
        match &events[0] {
            ProxyEvent::Head { status, headers } => {
                assert_eq!(*status, 200);
                assert!(headers.iter().any(|(k, v)| k == "x-routed-via" && v == "groq/llama"));
            }
            other => panic!("Head attendu, reçu {other:?}"),
        }
        let body: Vec<u8> = events
            .iter()
            .filter_map(|e| if let ProxyEvent::Chunk { data } = e { Some(data.clone()) } else { None })
            .flatten()
            .collect();
        assert_eq!(String::from_utf8(body).unwrap(), "data: {\"a\":1}\n\ndata: {\"b\":\"é\"}\n\ndata: [DONE]\n\n");
        assert_eq!(events.last(), Some(&ProxyEvent::End));
    }

    #[tokio::test]
    async fn reports_unreachable_upstream() {
        // Port fermé : on réserve un port puis on le libère.
        let port = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        forward(port, "freellmapi-test1234", "GET", "/v1/models", None, move |e| {
            sink.lock().unwrap().push(e);
            true
        })
        .await;
        let events = events.lock().unwrap();
        assert_eq!(events[0], ProxyEvent::Head { status: 502, headers: vec![("content-type".into(), "application/json".into())] });
        assert_eq!(events.last(), Some(&ProxyEvent::End));
    }
}
