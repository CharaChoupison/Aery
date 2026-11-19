//! Statistiques de FreeLLMAPI (analytique, journaux, scores des modèles), en LECTURE SEULE.
//!
//! Ces pages passent par l'API d'admin de FreeLLMAPI (/api/...), protégée par une session
//! du dashboard (pas par la clé freellmapi-). L'appli desktop FreeLLMAPI donne cette session
//! à tout programme local qui la demande : POST /api/auth/desktop-session.
//!
//! Ce jeton donne TOUS les droits d'admin. Donc :
//!  - il reste ici, en mémoire : l'interface ne le voit jamais ;
//!  - seules les routes de lecture listées dans `admin_api_path` passent, et seulement en GET.

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
        ["logs"] | ["fallback"] | ["fallback", "routing"] => true,
        _ => false,
    };
    let safe_query = query.len() <= 512
        && query.chars().all(|c| c.is_ascii_alphanumeric() || "_-.,=&%+:*".contains(c));

    (allowed && safe_query).then(|| {
        if query.is_empty() { format!("/api/{route}") } else { format!("/api/{route}?{query}") }
    })
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

/// GET sur une route admin autorisée. Renvoie (statut, content-type, corps).
pub async fn fetch(session: &DashboardSession, port: u16, api_path: &str) -> Result<(u16, String, Vec<u8>), AdminError> {
    let client = client()?;
    let url = format!("http://127.0.0.1:{port}{api_path}");
    let mut refresh = false;
    loop {
        let token = session.token(&client, port, refresh).await?;
        let response = client
            .get(&url)
            .header("authorization", format!("Bearer {token}"))
            .send()
            .await
            .map_err(|_| unreachable(port))?;
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

        // Routes sensibles ou d'écriture : refusées.
        assert!(admin_api_path("/admin/keys").is_none());
        assert!(admin_api_path("/admin/keys/1/reveal").is_none());
        assert!(admin_api_path("/admin/logs/clear").is_none());
        assert!(admin_api_path("/admin/settings/api-key").is_none());
        assert!(admin_api_path("/admin/fallback/sort/speed").is_none());
        assert!(admin_api_path("/admin/analytics/requests/abc").is_none());
        assert!(admin_api_path("/admin/analytics/../keys").is_none());
        assert!(admin_api_path("/admin/logs?q=a b").is_none());
        assert!(admin_api_path("/v1/models").is_none());
    }
}
