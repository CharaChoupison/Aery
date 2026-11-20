//! Lance FreeLLMAPI tout seul quand elle n'est pas ouverte.
//!
//! Avant chaque requête, le relais vérifie que le port répond. Sinon, on ouvre l'appli
//! desktop FreeLLMAPI en arrière-plan (`open -g -j`) et on attend qu'elle soit prête.
//! On garde la vraie appli desktop (et pas un serveur lancé à la main) : elle seule
//! accorde la session d'admin utilisée par les pages Modèles, Clés, Utilisation…
//!
//! La commande est figée ici : l'interface ne choisit jamais quoi lancer.

use std::{
    net::{Ipv4Addr, SocketAddr, TcpStream},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

const APP_NAME: &str = "FreeLLMAPI";
/// Temps laissé à FreeLLMAPI pour démarrer son serveur.
const STARTUP_WAIT: Duration = Duration::from_secs(25);
/// On ne relance pas l'appli plus d'une fois par minute (port mal réglé, appli qui plante…).
const RELAUNCH_COOLDOWN: Duration = Duration::from_secs(60);

/// Moment du dernier lancement, partagé par toutes les requêtes en attente.
static LAST_LAUNCH: Mutex<Option<Instant>> = Mutex::new(None);

fn is_reachable(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn launch_app() {
    // -g : ne passe pas au premier plan ; -j : lance l'appli masquée.
    let _ = Command::new("/usr/bin/open")
        .args(["-g", "-j", "-a", APP_NAME])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|mut child| std::thread::spawn(move || child.wait()));
}

/// Version bloquante : à appeler hors du runtime async (voir `ensure_running`).
fn ensure_running_blocking(port: u16) {
    if is_reachable(port) {
        return;
    }
    let deadline = {
        let Ok(mut last) = LAST_LAUNCH.lock() else { return };
        match *last {
            // Lancement récent : on attend la même échéance que les autres requêtes…
            Some(t) if t.elapsed() < RELAUNCH_COOLDOWN => {
                if t.elapsed() >= STARTUP_WAIT {
                    return; // … sauf si on a déjà attendu pour rien : l'erreur habituelle s'affichera.
                }
                t + STARTUP_WAIT
            }
            _ => {
                let now = Instant::now();
                *last = Some(now);
                launch_app();
                now + STARTUP_WAIT
            }
        }
    };
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        if is_reachable(port) {
            // Le port s'ouvre un poil avant que les routes soient prêtes.
            std::thread::sleep(Duration::from_millis(500));
            return;
        }
    }
}

/// S'assure que FreeLLMAPI tourne sur `port`, en la lançant si besoin (attente de 25 s max).
pub async fn ensure_running(port: u16) {
    let _ = tauri::async_runtime::spawn_blocking(move || ensure_running_blocking(port)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_port_is_reachable_without_launching() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        ensure_running_blocking(port);
        assert!(LAST_LAUNCH.lock().unwrap().is_none());
    }
}
