//! Dossiers de travail de l'agent : outils de LECTURE SEULE (lister, lire, chercher).
//!
//! Règles de sécurité :
//!  - l'interface ne choisit jamais un chemin elle-même : un dossier n'est autorisé que s'il a été
//!    choisi dans la fenêtre native de macOS (`pick_workspace`). La liste est gardée côté Rust ;
//!  - chaque chemin demandé est résolu (`canonicalize` : suit les `..` et les liens symboliques),
//!    puis doit rester DANS le dossier choisi ;
//!  - les secrets et dossiers lourds sont exclus (`.env`, clés, `.git`, `node_modules`…) ;
//!  - tailles limitées partout (fichier lu, nombre de résultats, texte renvoyé au modèle).
//!
//! Aucune écriture, aucune commande : seulement de la lecture.

use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Dossiers non explorés : lourds ou sans intérêt pour comprendre un projet (ou sensibles).
const SKIPPED_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache",
    ".venv", "venv", "__pycache__", ".idea", ".ssh", ".gnupg", ".aws", ".docker", ".kube",
];
/// Extensions de fichiers qui contiennent souvent des secrets.
const SECRET_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "keystore", "jks", "kdbx"];
/// Noms exacts de fichiers sensibles.
const SECRET_FILES: &[&str] = &[".npmrc", ".netrc", ".pgpass", ".git-credentials", "credentials", "credentials.json"];

const MAX_READ_BYTES: u64 = 1024 * 1024; // on ne lit pas un fichier de plus de 1 Mo
const MAX_LINES: usize = 400; // lignes renvoyées par lecture (la suite avec start_line)
const MAX_OUTPUT: usize = 20_000; // caractères renvoyés au modèle par appel
const MAX_LIST_ENTRIES: usize = 400;
const MAX_SEARCH_FILES: usize = 5_000;
const MAX_SEARCH_MATCHES: usize = 80;

/// Dossiers choisis par l'utilisateur (enregistrés pour les prochains lancements).
#[derive(Default)]
pub struct Workspaces(Mutex<Option<BTreeSet<PathBuf>>>);

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("workspaces.json"))
        .map_err(|e| format!("Dossier de configuration introuvable : {e}"))
}

/// Liste des dossiers autorisés (chargée depuis le disque au premier appel).
fn with_granted<T>(app: &AppHandle, state: &Workspaces, f: impl FnOnce(&mut BTreeSet<PathBuf>) -> T) -> T {
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let set = guard.get_or_insert_with(|| {
        store_path(app)
            .ok()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<PathBuf>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            .collect()
    });
    f(set)
}

fn save_granted(app: &AppHandle, set: &BTreeSet<PathBuf>) -> Result<(), String> {
    let path = store_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Impossible de créer le dossier de config : {e}"))?;
    }
    let json = serde_json::to_string_pretty(&set.iter().collect::<Vec<_>>()).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("Impossible d'enregistrer le dossier : {e}"))
}

/// Refuse les dossiers beaucoup trop larges (tout le disque, tout le dossier personnel).
fn is_too_broad(path: &Path) -> bool {
    let home = std::env::var_os("HOME").map(PathBuf::from).and_then(|h| h.canonicalize().ok());
    path.parent().is_none() || home.is_some_and(|h| h == path || h.starts_with(path))
}

/// Ouvre la fenêtre « Choisir un dossier » de macOS. `None` = annulé.
#[tauri::command]
pub async fn pick_workspace(app: AppHandle, state: State<'_, Workspaces>) -> Result<Option<String>, String> {
    // Commande async : on n'est pas sur le fil principal, la fenêtre bloquante est donc permise.
    let Some(picked) = app.dialog().file().set_title("Dossier que l'agent pourra lire").blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| "Dossier invalide.".to_string())?
        .canonicalize()
        .map_err(|e| format!("Dossier inaccessible : {e}"))?;
    if is_too_broad(&path) {
        return Err("Ce dossier est trop large (disque entier ou dossier personnel). Choisis le dossier d'un projet.".into());
    }
    with_granted(&app, &state, |set| {
        set.insert(path.clone());
        save_granted(&app, set)
    })?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Retire un dossier de la liste autorisée (projet de code supprimé, ou dossier changé).
/// Cette commande ne peut que RETIRER un droit : pour en donner un, il faut `pick_workspace`.
#[tauri::command]
pub fn release_workspace(app: AppHandle, state: State<'_, Workspaces>, path: String) -> Result<(), String> {
    with_granted(&app, &state, |set| {
        let target = PathBuf::from(&path);
        // Le dossier a pu être supprimé entre-temps : on compare aussi le chemin tel quel.
        let real = target.canonicalize().unwrap_or_else(|_| target.clone());
        if release(set, &real) || release(set, &target) { save_granted(&app, set) } else { Ok(()) }
    })
}

fn release(set: &mut BTreeSet<PathBuf>, path: &Path) -> bool {
    set.remove(path)
}

/// Exécute un outil de lecture dans un dossier autorisé. Renvoie du texte pour le modèle.
#[tauri::command]
pub async fn workspace_tool(
    app: AppHandle,
    state: State<'_, Workspaces>,
    root: String,
    tool: String,
    args: Value,
) -> Result<String, String> {
    let root = PathBuf::from(&root).canonicalize().map_err(|_| "Le dossier de travail n'existe plus.".to_string())?;
    if !with_granted(&app, &state, |set| set.contains(&root)) {
        return Err("Dossier non autorisé : choisis-le à nouveau dans la zone de saisie.".into());
    }
    // La recherche peut parcourir des milliers de fichiers : on la sort du fil async.
    tauri::async_runtime::spawn_blocking(move || run_tool(&root, &tool, &args))
        .await
        .map_err(|e| format!("Erreur interne : {e}"))?
}

pub fn run_tool(root: &Path, tool: &str, args: &Value) -> Result<String, String> {
    match tool {
        "list_dir" => {
            let a: ListArgs = parse(args)?;
            list_dir(root, a.path.as_deref().unwrap_or("."), a.depth.unwrap_or(1).clamp(1, 3))
        }
        "read_file" => {
            let a: ReadArgs = parse(args)?;
            read_file(root, &a.path, a.start_line.unwrap_or(1).max(1), a.end_line)
        }
        "search" => {
            let a: SearchArgs = parse(args)?;
            search(root, &a.query, a.path.as_deref().unwrap_or("."))
        }
        _ => Err(format!("Outil inconnu : {tool}")),
    }
}

#[derive(Deserialize)]
struct ListArgs {
    path: Option<String>,
    depth: Option<usize>,
}
#[derive(Deserialize)]
struct ReadArgs {
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
}
#[derive(Deserialize)]
struct SearchArgs {
    query: String,
    path: Option<String>,
}

fn parse<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|e| format!("Arguments invalides : {e}"))
}

// --- Sécurité des chemins --------------------------------------------------------------

fn is_secret_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let env_file = lower == ".env" || (lower.starts_with(".env.") && !lower.ends_with(".example") && !lower.ends_with(".sample"));
    let ext = Path::new(&lower).extension().and_then(|e| e.to_str()).unwrap_or("");
    env_file
        || SECRET_FILES.contains(&lower.as_str())
        || SECRET_EXTENSIONS.contains(&ext)
        || lower.starts_with("id_rsa")
        || lower.starts_with("id_ed25519")
        || lower.starts_with("id_ecdsa")
}

/// Un chemin (relatif au dossier de travail) passe-t-il par un dossier exclu ou un fichier secret ?
fn blocked_reason(relative: &Path) -> Option<&'static str> {
    let names: Vec<&str> = relative.components().filter_map(|c| c.as_os_str().to_str()).collect();
    if names.iter().any(|n| SKIPPED_DIRS.contains(n)) {
        return Some("dossier exclu (.git, node_modules, build…)");
    }
    if names.last().is_some_and(|n| is_secret_file(n)) {
        return Some("fichier qui peut contenir des secrets (.env, clés…)");
    }
    None
}

/// « src/App.tsx » → chemin absolu vérifié, qui reste DANS le dossier de travail.
fn resolve(root: &Path, requested: &str) -> Result<PathBuf, String> {
    let requested = requested.trim();
    let candidate = Path::new(requested);
    // Chemin absolu donné par le modèle : accepté seulement s'il est dans le dossier.
    let joined = if candidate.is_absolute() { candidate.to_path_buf() } else { root.join(candidate) };
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Les chemins avec « .. » ne sont pas autorisés.".into());
    }
    let real = joined.canonicalize().map_err(|_| format!("Introuvable : {requested}"))?;
    let relative = real.strip_prefix(root).map_err(|_| format!("Hors du dossier de travail : {requested}"))?;
    if let Some(reason) = blocked_reason(relative) {
        return Err(format!("Accès refusé à « {requested} » : {reason}."));
    }
    Ok(real)
}

fn display(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy().into_owned();
    if rel.is_empty() { ".".into() } else { rel }
}

fn truncate(mut text: String) -> String {
    if text.len() > MAX_OUTPUT {
        let mut cut = MAX_OUTPUT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n… (résultat tronqué)");
    }
    text
}

// --- Les outils ------------------------------------------------------------------------

fn list_dir(root: &Path, requested: &str, depth: usize) -> Result<String, String> {
    let dir = resolve(root, requested)?;
    if !dir.is_dir() {
        return Err(format!("« {requested} » n'est pas un dossier."));
    }
    let mut lines = Vec::new();
    let mut count = 0;
    list_into(root, &dir, depth, 0, &mut lines, &mut count);
    if lines.is_empty() {
        return Ok(format!("{} : dossier vide.", display(root, &dir)));
    }
    let mut out = format!("Contenu de {} :\n{}", display(root, &dir), lines.join("\n"));
    if count >= MAX_LIST_ENTRIES {
        out.push_str("\n… (liste coupée : précise un sous-dossier)");
    }
    Ok(truncate(out))
}

fn list_into(root: &Path, dir: &Path, depth: usize, level: usize, lines: &mut Vec<String>, count: &mut usize) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = read.flatten().collect();
    // Dossiers d'abord, puis ordre alphabétique.
    entries.sort_by_key(|e| (!e.path().is_dir(), e.file_name().to_ascii_lowercase()));
    let indent = "  ".repeat(level);
    for entry in entries {
        if *count >= MAX_LIST_ENTRIES {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(meta) = entry.metadata() else { continue }; // suit les liens symboliques
        let is_link = entry.file_type().is_ok_and(|t| t.is_symlink());
        if meta.is_dir() {
            *count += 1;
            if SKIPPED_DIRS.contains(&name.as_str()) || is_link {
                lines.push(format!("{indent}{name}/ (non exploré)"));
            } else {
                lines.push(format!("{indent}{name}/"));
                if level + 1 < depth {
                    list_into(root, &entry.path(), depth, level + 1, lines, count);
                }
            }
        } else if !is_secret_file(&name) {
            *count += 1;
            lines.push(format!("{indent}{name} ({})", human_size(meta.len())));
        }
    }
}

fn human_size(bytes: u64) -> String {
    match bytes {
        b if b < 1024 => format!("{b} o"),
        b if b < 1024 * 1024 => format!("{:.1} Ko", b as f64 / 1024.0),
        b => format!("{:.1} Mo", b as f64 / (1024.0 * 1024.0)),
    }
}

/// Lit un fichier texte (ou rien si binaire / trop gros).
fn read_text(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Lecture impossible : {e}"))?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("Fichier trop gros ({}) : 1 Mo maximum.", human_size(meta.len())));
    }
    let bytes = fs::read(path).map_err(|e| format!("Lecture impossible : {e}"))?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err("Fichier binaire (image, archive…) : impossible à lire comme du texte.".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_file(root: &Path, requested: &str, start: usize, end: Option<usize>) -> Result<String, String> {
    let path = resolve(root, requested)?;
    if path.is_dir() {
        return Err(format!("« {requested} » est un dossier : utilise list_dir."));
    }
    let text = read_text(&path)?;
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    if total == 0 {
        return Ok(format!("{} : fichier vide.", display(root, &path)));
    }
    if start > total {
        return Err(format!("Le fichier n'a que {total} lignes."));
    }
    let last = end.unwrap_or(usize::MAX).min(total).min(start + MAX_LINES - 1).max(start);
    let mut out = format!("{} (lignes {start}-{last} sur {total}) :\n", display(root, &path));
    for (i, line) in lines[start - 1..last].iter().enumerate() {
        out.push_str(&format!("{:>5}  {line}\n", start + i));
    }
    if last < total {
        out.push_str(&format!("… suite avec start_line = {}", last + 1));
    }
    Ok(truncate(out))
}

fn search(root: &Path, query: &str, requested: &str) -> Result<String, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Err("Recherche vide.".into());
    }
    let base = resolve(root, requested)?;
    let mut matches = Vec::new();
    let mut scanned = 0;
    let walker = walkdir::WalkDir::new(&base).follow_links(false).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        !(e.file_type().is_dir() && e.depth() > 0 && SKIPPED_DIRS.contains(&name.as_ref()))
    });
    'files: for entry in walker.flatten() {
        if !entry.file_type().is_file() || is_secret_file(&entry.file_name().to_string_lossy()) {
            continue;
        }
        scanned += 1;
        if scanned > MAX_SEARCH_FILES {
            break;
        }
        let Ok(text) = read_text(entry.path()) else { continue };
        for (i, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                let snippet: String = line.trim().chars().take(200).collect();
                matches.push(format!("{}:{}: {snippet}", display(root, entry.path()), i + 1));
                if matches.len() >= MAX_SEARCH_MATCHES {
                    break 'files;
                }
            }
        }
    }
    if matches.is_empty() {
        return Ok(format!("Aucun résultat pour « {query} »."));
    }
    let mut out = format!("{} résultat(s) pour « {query} » :\n{}", matches.len(), matches.join("\n"));
    if matches.len() >= MAX_SEARCH_MATCHES {
        out.push_str("\n… (résultats coupés : précise la recherche ou le dossier)");
    }
    Ok(truncate(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Petit projet de test dans un dossier temporaire unique.
    fn sample() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aery-ws-{}-{}", std::process::id(), rand_suffix()));
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("package.json"), "{\n  \"name\": \"demo\"\n}\n").unwrap();
        fs::write(dir.join("src/App.tsx"), "export function App() {\n  return 'Bonjour'\n}\n").unwrap();
        fs::write(dir.join(".env"), "SECRET=1\n").unwrap();
        fs::write(dir.join(".env.example"), "SECRET=\n").unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "Bonjour\n").unwrap();
        fs::write(dir.join("image.bin"), [0u8, 1, 2, 3]).unwrap();
        dir.canonicalize().unwrap()
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn reads_inside_and_refuses_outside() {
        let root = sample();
        let ok = run_tool(&root, "read_file", &json!({ "path": "src/App.tsx" })).unwrap();
        assert!(ok.contains("    2    return 'Bonjour'"));
        assert!(run_tool(&root, "read_file", &json!({ "path": "../etc/passwd" })).is_err());
        assert!(run_tool(&root, "read_file", &json!({ "path": "/etc/passwd" })).is_err());
        assert!(run_tool(&root, "read_file", &json!({ "path": "image.bin" })).is_err());
    }

    #[test]
    fn refuses_secrets_and_skipped_dirs() {
        let root = sample();
        assert!(run_tool(&root, "read_file", &json!({ "path": ".env" })).is_err());
        assert!(run_tool(&root, "read_file", &json!({ "path": "./.env" })).is_err());
        assert!(run_tool(&root, "read_file", &json!({ "path": ".env.example" })).is_ok());
        assert!(run_tool(&root, "read_file", &json!({ "path": "node_modules/pkg/index.js" })).is_err());
        let list = run_tool(&root, "list_dir", &json!({})).unwrap();
        assert!(!list.contains(".env ("), "{list}");
        assert!(list.contains("node_modules/ (non exploré)"));
    }

    #[test]
    fn symlink_cannot_escape() {
        let root = sample();
        let outside = std::env::temp_dir().join(format!("aery-outside-{}", rand_suffix()));
        fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("lien.txt")).unwrap();
        let err = run_tool(&root, "read_file", &json!({ "path": "lien.txt" })).unwrap_err();
        assert!(err.contains("Hors du dossier"), "{err}");
        // Lien vers un secret DANS le dossier : refusé aussi (on vérifie le chemin réel).
        std::os::unix::fs::symlink(root.join(".env"), root.join("innocent.txt")).unwrap();
        assert!(run_tool(&root, "read_file", &json!({ "path": "innocent.txt" })).is_err());
    }

    #[test]
    fn search_skips_excluded_files() {
        let root = sample();
        let out = run_tool(&root, "search", &json!({ "query": "bonjour" })).unwrap();
        assert!(out.contains("src/App.tsx:2:"), "{out}");
        assert!(!out.contains("node_modules"));
        let none = run_tool(&root, "search", &json!({ "query": "SECRET=1" })).unwrap();
        assert!(none.starts_with("Aucun résultat"), "{none}");
    }

    #[test]
    fn read_file_pages_long_files() {
        let root = sample();
        let long: String = (1..=1000).map(|i| format!("ligne {i}\n")).collect();
        fs::write(root.join("long.txt"), long).unwrap();
        let first = run_tool(&root, "read_file", &json!({ "path": "long.txt" })).unwrap();
        assert!(first.contains("lignes 1-400 sur 1000") && first.contains("start_line = 401"));
        let next = run_tool(&root, "read_file", &json!({ "path": "long.txt", "start_line": 990 })).unwrap();
        assert!(next.contains("lignes 990-1000 sur 1000"));
    }

    #[test]
    fn release_only_removes() {
        let mut set: BTreeSet<PathBuf> = [PathBuf::from("/a/projet"), PathBuf::from("/b/autre")].into();
        assert!(release(&mut set, Path::new("/a/projet")));
        assert!(!release(&mut set, Path::new("/c/jamais-autorise")));
        assert_eq!(set.len(), 1);
        assert!(set.contains(Path::new("/b/autre")));
    }

    #[test]
    fn too_broad_roots_are_refused() {
        assert!(is_too_broad(Path::new("/")));
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from).and_then(|h| h.canonicalize().ok()) {
            assert!(is_too_broad(&home));
            assert!(!is_too_broad(&home.join("Projets/demo")));
        }
    }
}
