//! API d'admin de FreeLLMAPI : statistiques (analytique, journaux, scores, utilisation) en lecture,
//! plus quatre écritures précises (activer un modèle, stratégie de routage, ajouter / supprimer une clé).
//!
//! Ces pages passent par l'API d'admin de FreeLLMAPI (/api/...), protégée par une session
//! du dashboard (pas par la clé freellmapi-). L'appli desktop FreeLLMAPI donne cette session
//! à tout programme local qui la demande : POST /api/auth/desktop-session.
//!
//! Ce jeton donne TOUS les droits d'admin. Donc :
//!  - il reste ici, en mémoire : l'interface ne le voit jamais ;
//!  - en GET, seules les routes listées dans `admin_api_path` passent (aucune ne renvoie de clé en clair) ;
//!  - en écriture, seules les opérations de `admin_write` passent, avec un corps revalidé et reconstruit.

use std::{sync::Mutex, time::Duration};

/// Jeton de session du dashboard, gardé en mémoire avec le port pour lequel il a été obtenu.
#[derive(Default)]
pub struct DashboardSession(Mutex<Option<(u16, String)>>);

/// « /admin/logs?limit=200 » → « /api/logs?limit=200 », ou None si la route n'est pas autorisée.
pub fn admin_api_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/admin/")?;
    let (route, query) = rest.split_once('?').unwrap_or((rest, ""));

    let segments: Vec<&str> = route.split('/').collect();
    let allowed = match segments.as_slice() {
        ["analytics", name] => matches!(
            *name,
            "summary" | "timeline" | "by-model" | "by-platform" | "error-distribution" | "errors" | "requests"
        ),
        ["analytics", "requests", id] => !id.is_empty() && id.len() <= 12 && id.chars().all(|c| c.is_ascii_digit()),
        ["logs"] | ["fallback"] | ["keys"] | ["keys", "providers"] => true,
        ["fallback", name] => matches!(*name, "routing" | "token-usage" | "rate-limit-usage" | "quota-forecast"),
        _ => false,
    };
    let safe_query = query.len() <= 512
        && query.chars().all(|c| c.is_ascii_alphanumeric() || "_-.,=&%+:*".contains(c));

    (allowed && safe_query).then(|| {
        if query.is_empty() { format!("/api/{route}") } else { format!("/api/{route}?{query}") }
    })
}

/// Écriture autorisée : (méthode, chemin de l'API FreeLLMAPI, corps reconstruit).
pub type Write = (reqwest::Method, String, Option<String>);

fn is_platform(s: &str) -> bool {
    let mut chars = s.chars();
    s.len() <= 64
        && s != "custom"
        && chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Les seules écritures autorisées (mêmes règles que `adminWrite` dans server/freellmPlugin.ts) :
///  - PUT    /admin/fallback   : activer / désactiver des modèles  [{ modelDbId, priority, enabled }]
///  - PUT    /admin/fallback/routing : stratégie de routage     { strategy, weights? } (rien d'autre)
///  - POST   /admin/keys       : ajouter une clé de fournisseur     { platform, key?, label? } (pas de proxyUrl)
///  - DELETE /admin/keys/<id>  : supprimer une clé
pub fn admin_write(method: &str, path: &str, body: Option<&str>) -> Result<Write, String> {
    use serde_json::{Value, json};
    let denied = || "Cette action n’est pas autorisée depuis le chat.".to_string();
    if path.contains('?') {
        return Err("Paramètres non autorisés.".into());
    }
    let parse = || -> Result<Value, String> {
        let raw = body.ok_or("Corps JSON attendu.")?;
        if raw.len() > 256 * 1024 {
            return Err("Corps de requête trop gros.".into());
        }
        serde_json::from_str(raw).map_err(|_| "JSON invalide.".to_string())
    };

    match (method, path) {
        ("PUT", "/admin/fallback") => {
            let value = parse()?;
            let items = value.as_array().filter(|a| !a.is_empty() && a.len() <= 2000).ok_or("Liste de modèles attendue.")?;
            let mut entries = Vec::with_capacity(items.len());
            for item in items {
                let id = item.get("modelDbId").and_then(Value::as_u64).filter(|n| (1..=1_000_000_000_000).contains(n));
                let priority = item.get("priority").and_then(Value::as_u64).filter(|n| *n <= 1_000_000);
                let enabled = item.get("enabled").and_then(Value::as_bool);
                match (id, priority, enabled) {
                    (Some(id), Some(priority), Some(enabled)) => {
                        entries.push(json!({ "modelDbId": id, "priority": priority, "enabled": enabled }))
                    }
                    _ => return Err("Modèle invalide.".into()),
                }
            }
            Ok((reqwest::Method::PUT, "/api/fallback".into(), Some(Value::Array(entries).to_string())))
        }
        ("PUT", "/admin/fallback/routing") => {
            // FreeLLMAPI ne modifie que les champs reçus : on n'envoie que la stratégie (et les poids),
            // sans toucher aux autres réglages du routeur.
            const STRATEGIES: [&str; 7] = ["priority", "balanced", "smartest", "fastest", "reliable", "custom", "decision"];
            let value = parse()?;
            let object = value.as_object().ok_or("Objet JSON attendu.")?;
            let strategy = object.get("strategy").and_then(Value::as_str).filter(|s| STRATEGIES.contains(s)).ok_or("Stratégie inconnue.")?;
            let body = match object.get("weights") {
                None => json!({ "strategy": strategy }),
                Some(w) => {
                    let get = |k: &str| w.get(k).and_then(Value::as_f64).filter(|v| v.is_finite() && (0.0..=1000.0).contains(v));
                    match (get("reliability"), get("speed"), get("intelligence")) {
                        (Some(r), Some(s), Some(i)) if r + s + i > 0.0 => {
                            json!({ "strategy": strategy, "weights": { "reliability": r, "speed": s, "intelligence": i } })
                        }
                        _ => return Err("Poids invalides.".into()),
                    }
                }
            };
            Ok((reqwest::Method::PUT, "/api/fallback/routing".into(), Some(body.to_string())))
        }
        ("POST", "/admin/keys") => {
            let value = parse()?;
            let object = value.as_object().ok_or("Objet JSON attendu.")?;
            let platform = object.get("platform").and_then(Value::as_str).filter(|p| is_platform(p)).ok_or("Fournisseur invalide.")?;
            let mut out = serde_json::Map::new();
            out.insert("platform".into(), json!(platform));
            match object.get("key") {
                None => {}
                Some(Value::String(key)) => {
                    let key = key.trim();
                    if !key.is_empty() {
                        if key.len() > 4096 || !key.chars().all(|c| c.is_ascii_graphic()) {
                            return Err("Clé invalide : pas d’espaces, 4096 caractères maximum.".into());
                        }
                        out.insert("key".into(), json!(key));
                    }
                }
                Some(_) => return Err("Clé invalide.".into()),
            }
            match object.get("label") {
                None => {}
                Some(Value::String(label)) => {
                    let label: String = label.chars().filter(|c| !c.is_control() && !is_format_char(*c)).collect();
                    let label = label.trim();
                    if label.chars().count() > 64 {
                        return Err("Nom trop long (64 caractères maximum).".into());
                    }
                    if !label.is_empty() {
                        out.insert("label".into(), json!(label));
                    }
                }
                Some(_) => return Err("Nom invalide.".into()),
            }
            Ok((reqwest::Method::POST, "/api/keys".into(), Some(Value::Object(out).to_string())))
        }
        ("DELETE", _) => {
            let id = path.strip_prefix("/admin/keys/").ok_or_else(denied)?;
            if id.is_empty() || id.len() > 12 || !id.chars().all(|c| c.is_ascii_digit()) {
                return Err(denied());
            }
            Ok((reqwest::Method::DELETE, format!("/api/keys/{id}"), None))
        }
        _ => Err(denied()),
    }
}

/// Caractères invisibles de mise en forme (catégorie Unicode Cf) les plus courants.
fn is_format_char(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}' | '\u{00AD}')
}

/// Erreur prête à afficher : (statut HTTP, code, message).
pub type AdminError = (u16, &'static str, String);

fn client() -> Result<reqwest::Client, AdminError> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| (500, "internal", e.to_string()))
}

fn unreachable(port: u16) -> AdminError {
    (502, "upstream_unreachable", format!("FreeLLMAPI ne répond pas sur le port {port}. Vérifie que l’appli est lancée."))
}

async fn new_token(client: &reqwest::Client, port: u16) -> Result<String, AdminError> {
    let response = client
        .post(format!("http://127.0.0.1:{port}/api/auth/desktop-session"))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|_| unreachable(port))?;
    if response.status().as_u16() == 403 {
        return Err((
            403,
            "desktop_only",
            "Les statistiques ne sont disponibles qu’avec l’appli desktop FreeLLMAPI lancée sur cet ordinateur.".into(),
        ));
    }
    let bytes = response.bytes().await.map_err(|_| unreachable(port))?;
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    match body.get("token").and_then(|t| t.as_str()) {
        Some(t) if (16..=256).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric()) => Ok(t.to_string()),
        _ => Err((502, "no_session", "FreeLLMAPI n’a pas ouvert de session pour les statistiques.".into())),
    }
}

impl DashboardSession {
    async fn token(&self, client: &reqwest::Client, port: u16, refresh: bool) -> Result<String, AdminError> {
        if !refresh {
            if let Some((p, t)) = self.0.lock().ok().and_then(|s| s.clone()) {
                if p == port {
                    return Ok(t);
                }
            }
        }
        let token = new_token(client, port).await?;
        if let Ok(mut s) = self.0.lock() {
            *s = Some((port, token.clone()));
        }
        Ok(token)
    }
}

/// Requête vers une route admin autorisée (GET de lecture, ou écriture validée par `admin_write`).
/// Renvoie (statut, content-type, corps).
pub async fn send(
    session: &DashboardSession,
    port: u16,
    method: reqwest::Method,
    api_path: &str,
    body: Option<String>,
) -> Result<(u16, String, Vec<u8>), AdminError> {
    let client = client()?;
    let url = format!("http://127.0.0.1:{port}{api_path}");
    let mut refresh = false;
    loop {
        let token = session.token(&client, port, refresh).await?;
        let mut request = client.request(method.clone(), &url).header("authorization", format!("Bearer {token}"));
        if let Some(body) = &body {
            request = request.header("content-type", "application/json").body(body.clone());
        }
        let response = request.send().await.map_err(|_| unreachable(port))?;
        let status = response.status().as_u16();
        // Session expirée (30 jours) ou FreeLLMAPI redémarré : on en redemande une, une seule fois.
        if status == 401 && !refresh {
            refresh = true;
            continue;
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/json")
            .to_string();
        let body = response.bytes().await.map_err(|_| unreachable(port))?.to_vec();
        return Ok((status, content_type, body));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_read_routes_are_allowed() {
        assert_eq!(admin_api_path("/admin/analytics/summary?range=7d").as_deref(), Some("/api/analytics/summary?range=7d"));
        assert_eq!(admin_api_path("/admin/analytics/requests/42").as_deref(), Some("/api/analytics/requests/42"));
        assert_eq!(admin_api_path("/admin/logs?levels=warn,error&q=gro%C3%A9q").as_deref(), Some("/api/logs?levels=warn,error&q=gro%C3%A9q"));
        assert_eq!(admin_api_path("/admin/fallback/routing").as_deref(), Some("/api/fallback/routing"));
        assert_eq!(admin_api_path("/admin/fallback/token-usage").as_deref(), Some("/api/fallback/token-usage"));
        assert_eq!(admin_api_path("/admin/keys").as_deref(), Some("/api/keys"));
        assert_eq!(admin_api_path("/admin/keys/providers").as_deref(), Some("/api/keys/providers"));

        // Routes sensibles ou d'écriture : refusées.
        assert!(admin_api_path("/admin/keys/export").is_none());
        assert!(admin_api_path("/admin/keys/1/reveal").is_none());
        assert!(admin_api_path("/admin/logs/clear").is_none());
        assert!(admin_api_path("/admin/settings/api-key").is_none());
        assert!(admin_api_path("/admin/fallback/sort/speed").is_none());
        assert!(admin_api_path("/admin/analytics/requests/abc").is_none());
        assert!(admin_api_path("/admin/analytics/../keys").is_none());
        assert!(admin_api_path("/admin/logs?q=a b").is_none());
        assert!(admin_api_path("/v1/models").is_none());
    }

    #[test]
    fn only_four_writes_are_allowed() {
        // Activer / désactiver : le corps est reconstruit, les champs en trop disparaissent.
        let (m, path, body) = admin_write("PUT", "/admin/fallback", Some(r#"[{"modelDbId":3,"priority":1,"enabled":false,"x":1}]"#)).unwrap();
        assert_eq!((m, path.as_str()), (reqwest::Method::PUT, "/api/fallback"));
        assert_eq!(body.unwrap(), r#"[{"enabled":false,"modelDbId":3,"priority":1}]"#);
        assert!(admin_write("PUT", "/admin/fallback", Some("[]")).is_err());
        assert!(admin_write("PUT", "/admin/fallback", Some(r#"[{"modelDbId":-1,"priority":1,"enabled":true}]"#)).is_err());
        assert!(admin_write("PUT", "/admin/fallback", Some(r#"[{"modelDbId":1,"priority":1,"enabled":"oui"}]"#)).is_err());

        // Stratégie : seuls strategy et weights passent (pas les heures de pointe, cooldowns…).
        let (_, path, body) =
            admin_write("PUT", "/admin/fallback/routing", Some(r#"{"strategy":"fastest","cooldownCeilingMs":60000,"peakHoursAdjust":true}"#)).unwrap();
        assert_eq!((path.as_str(), body.unwrap().as_str()), ("/api/fallback/routing", r#"{"strategy":"fastest"}"#));
        let (_, _, body) =
            admin_write("PUT", "/admin/fallback/routing", Some(r#"{"strategy":"custom","weights":{"reliability":2,"speed":1,"intelligence":1,"x":5}}"#)).unwrap();
        assert_eq!(body.unwrap(), r#"{"strategy":"custom","weights":{"intelligence":1.0,"reliability":2.0,"speed":1.0}}"#);
        assert!(admin_write("PUT", "/admin/fallback/routing", Some(r#"{"strategy":"nimporte"}"#)).is_err());
        assert!(admin_write("PUT", "/admin/fallback/routing", Some(r#"{"strategy":"custom","weights":{"reliability":0,"speed":0,"intelligence":0}}"#)).is_err());
        assert!(admin_write("PUT", "/admin/fallback/routing", Some(r#"{"strategy":"custom","weights":{"reliability":-1,"speed":1,"intelligence":1}}"#)).is_err());

        // Ajout de clé : proxyUrl ignoré, nom nettoyé.
        let (_, path, body) =
            admin_write("POST", "/admin/keys", Some(r#"{"platform":"groq","key":" gsk_abc ","label":"perso\u0007","proxyUrl":"http://evil"}"#)).unwrap();
        assert_eq!(path, "/api/keys");
        assert_eq!(body.unwrap(), r#"{"key":"gsk_abc","label":"perso","platform":"groq"}"#);
        assert!(admin_write("POST", "/admin/keys", Some(r#"{"platform":"custom","key":"x"}"#)).is_err());
        assert!(admin_write("POST", "/admin/keys", Some(r#"{"platform":"Groq/../x","key":"x"}"#)).is_err());
        assert!(admin_write("POST", "/admin/keys", Some(r#"{"platform":"groq","key":"a b"}"#)).is_err());

        // Suppression : un identifiant numérique, rien d'autre.
        assert_eq!(admin_write("DELETE", "/admin/keys/12", None).unwrap().1, "/api/keys/12");
        assert!(admin_write("DELETE", "/admin/keys/12/cooldowns", None).is_err());
        assert!(admin_write("DELETE", "/admin/fallback", None).is_err());

        // Tout le reste est refusé.
        assert!(admin_write("POST", "/admin/keys/1/reveal", Some("{}")).is_err());
        assert!(admin_write("PUT", "/admin/settings", Some("{}")).is_err());
        assert!(admin_write("POST", "/admin/logs/clear", Some("{}")).is_err());
        assert!(admin_write("PUT", "/admin/fallback?x=1", Some("[]")).is_err());
    }
}
