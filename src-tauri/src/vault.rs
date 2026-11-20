//! Export du second cerveau vers un dossier Markdown (coffre Obsidian).
//!
//! Règles de sécurité :
//!  - l'interface ne choisit jamais le dossier elle-même : il vient de la fenêtre native de macOS
//!    (`pick_vault`), et il est gardé côté Rust (`vault.json`). Disque entier et dossier personnel refusés ;
//!  - l'interface envoie seulement des chemins RELATIFS, revérifiés ici (pas de `..`, pas de chemin
//!    absolu, pas de fichier caché, seulement des `.md`, 3 niveaux au plus), et le dossier final
//!    (liens symboliques résolus) doit rester dans le coffre ;
//!  - on ne perd jamais rien : un fichier modifié à la main dans Obsidian (son contenu n'est plus
//!    celui qu'on avait écrit) est copié dans `.aery/sauvegardes/<date>/` avant d'être remplacé ;
//!  - on ne supprime que nos propres fichiers, et seulement s'ils n'ont pas été modifiés depuis.
//!    Un fichier qu'on n'a jamais écrit n'est jamais touché.
//!
//! `.aery/manifest.json` retient les fichiers écrits et l'empreinte de leur contenu.

use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const MAX_FILES: usize = 5_000;
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 200 * 1024 * 1024;
const MAX_DEPTH: usize = 3; // « 3 - Ressources/React/Note.md »
const MAX_PATH_CHARS: usize = 300;
const META_DIR: &str = ".aery";

#[derive(Deserialize)]
pub struct VaultFile {
    path: String,
    content: String,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    path: String,
    written: usize,
    unchanged: usize,
    removed: usize,
    backed_up: usize,
}

#[derive(Serialize, Deserialize, Default)]
struct Manifest {
    /// Chemin relatif → empreinte du contenu qu'on a écrit.
    files: BTreeMap<String, String>,
}

// --- Dossier choisi ----------------------------------------------------------------------

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("vault.json"))
        .map_err(|e| format!("Dossier de configuration introuvable : {e}"))
}

fn read_vault(app: &AppHandle) -> Option<PathBuf> {
    let raw = fs::read_to_string(store_path(app).ok()?).ok()?;
    let path: PathBuf = serde_json::from_str(&raw).ok()?;
    path.canonicalize().ok().filter(|p| p.is_dir())
}

/// Dossier d'export choisi, s'il existe encore.
#[tauri::command]
pub fn get_vault(app: AppHandle) -> Option<String> {
    read_vault(&app).map(|p| p.to_string_lossy().into_owned())
}

/// Fenêtre « Choisir un dossier » de macOS. `None` = annulé.
#[tauri::command]
pub async fn pick_vault(app: AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Dossier où exporter le cerveau (coffre Obsidian)")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| "Dossier invalide.".to_string())?
        .canonicalize()
        .map_err(|e| format!("Dossier inaccessible : {e}"))?;
    if crate::workspace::is_too_broad(&path) {
        return Err("Ce dossier est trop large (disque entier ou dossier personnel). Crée ou choisis un dossier dédié.".into());
    }
    let store = store_path(&app)?;
    if let Some(dir) = store.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Impossible de créer le dossier de config : {e}"))?;
    }
    fs::write(&store, serde_json::to_string(&path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Impossible d'enregistrer le dossier : {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Oublie le dossier d'export (les fichiers déjà écrits restent où ils sont).
#[tauri::command]
pub fn forget_vault(app: AppHandle) -> Result<(), String> {
    match fs::remove_file(store_path(&app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Impossible d'oublier le dossier : {e}")),
    }
}

/// Écrit le cerveau dans le dossier choisi.
#[tauri::command]
pub async fn export_vault(app: AppHandle, files: Vec<VaultFile>) -> Result<ExportReport, String> {
    let root = read_vault(&app).ok_or("Choisis d'abord un dossier d'export.")?;
    let stamp = backup_stamp();
    tauri::async_runtime::spawn_blocking(move || write_vault(&root, &files, &stamp))
        .await
        .map_err(|e| format!("Erreur interne : {e}"))?
}

// --- Écriture ----------------------------------------------------------------------------------

/// Empreinte FNV-1a 64 bits (stable d'une version de Rust à l'autre, contrairement à DefaultHasher).
fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}-{}", bytes.len())
}

/// Nom du dossier de sauvegarde : date et heure UTC (« 2026-11-20_200000 »).
fn backup_stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // Jours depuis 1970 → date (algorithme « civil_from_days » de Howard Hinnant).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}_{:02}{:02}{:02}", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// Chemin relatif accepté : des noms simples séparés par « / », sans fichier caché, en `.md`.
fn safe_rel_path(raw: &str) -> Option<PathBuf> {
    if raw.is_empty() || raw.chars().count() > MAX_PATH_CHARS || raw.contains('\\') || raw.chars().any(char::is_control) {
        return None;
    }
    let parts: Vec<&str> = raw.split('/').collect();
    if parts.len() > MAX_DEPTH || parts.iter().any(|p| p.trim().is_empty() || p.starts_with('.') || *p != p.trim()) {
        return None;
    }
    if !raw.to_lowercase().ends_with(".md") || raw.len() <= 3 {
        return None;
    }
    let path = PathBuf::from(raw);
    path.components().all(|c| matches!(c, Component::Normal(_))).then_some(path)
}

/// Dossier parent créé et vérifié : une fois les liens symboliques résolus, il est toujours dans le coffre.
fn checked_parent(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let parent = root.join(rel).parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf());
    fs::create_dir_all(&parent).map_err(|e| format!("Impossible de créer « {} » : {e}", rel.display()))?;
    let real = parent.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(root) {
        return Err(format!("« {} » sort du dossier d'export (lien symbolique ?).", rel.display()));
    }
    Ok(real)
}

/// Copie un fichier dans `.aery/sauvegardes/<date>/` avant de le remplacer ou de le supprimer.
fn backup(root: &Path, rel: &Path, stamp: &str) -> Result<(), String> {
    let dest = root.join(META_DIR).join("sauvegardes").join(stamp).join(rel);
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Sauvegarde impossible : {e}"))?;
    }
    fs::copy(root.join(rel), &dest).map(|_| ()).map_err(|e| format!("Sauvegarde de « {} » impossible : {e}", rel.display()))
}

/// Écriture atomique : fichier temporaire, puis renommage (jamais de fichier à moitié écrit).
fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("md.aery-tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| format!("Écriture impossible : {e}"))?;
    file.write_all(content).and_then(|()| file.sync_all()).map_err(|e| format!("Écriture impossible : {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("Écriture impossible : {e}"))
}

/// Supprime les dossiers devenus vides entre `dir` et la racine (une note déplacée laisse son ancien dossier).
fn remove_empty_dirs(root: &Path, mut dir: PathBuf) {
    while dir != root && dir.starts_with(root) {
        if fs::remove_dir(&dir).is_err() {
            break; // pas vide (ou autre souci) : on s'arrête là
        }
        if !dir.pop() {
            break;
        }
    }
}

pub fn write_vault(root: &Path, files: &[VaultFile], stamp: &str) -> Result<ExportReport, String> {
    if files.len() > MAX_FILES {
        return Err(format!("Trop d'éléments à exporter ({} au maximum).", MAX_FILES));
    }
    if files.iter().map(|f| f.content.len()).sum::<usize>() > MAX_TOTAL_BYTES {
        return Err("Le cerveau est trop gros pour être exporté en une fois.".into());
    }
    // Tout est vérifié AVANT d'écrire quoi que ce soit.
    let mut wanted: BTreeMap<String, (PathBuf, &str)> = BTreeMap::new();
    let mut lower = BTreeSet::new();
    for f in files {
        let rel = safe_rel_path(&f.path).ok_or_else(|| format!("Chemin refusé : « {} ».", f.path))?;
        if f.content.len() > MAX_FILE_BYTES {
            return Err(format!("« {} » est trop gros.", f.path));
        }
        // macOS ne distingue pas les majuscules : deux noms qui ne diffèrent que par elles = même fichier.
        if !lower.insert(f.path.to_lowercase()) {
            return Err(format!("Deux éléments veulent le même fichier : « {} ».", f.path));
        }
        wanted.insert(f.path.clone(), (rel, f.content.as_str()));
    }

    let manifest_path = root.join(META_DIR).join("manifest.json");
    let old: Manifest = fs::read_to_string(&manifest_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let mut next = Manifest::default();
    let mut report = ExportReport { path: root.to_string_lossy().into_owned(), ..Default::default() };

    for (key, (rel, content)) in &wanted {
        let parent = checked_parent(root, rel)?;
        let target = parent.join(rel.file_name().ok_or("Nom de fichier invalide.")?);
        let new_print = fingerprint(content.as_bytes());
        match fs::symlink_metadata(&target) {
            Ok(meta) if !meta.is_file() => return Err(format!("« {key} » existe déjà et n'est pas un fichier.")),
            Ok(_) => {
                let current = fs::read(&target).map_err(|e| format!("Lecture de « {key} » impossible : {e}"))?;
                if current == content.as_bytes() {
                    report.unchanged += 1;
                    next.files.insert(key.clone(), new_print);
                    continue;
                }
                // Pas le contenu qu'on avait écrit : modifié dans Obsidian, ou fichier qui n'est pas à nous.
                if old.files.get(key) != Some(&fingerprint(&current)) {
                    backup(root, rel, stamp)?;
                    report.backed_up += 1;
                }
            }
            Err(_) => {}
        }
        write_atomic(&target, content.as_bytes())?;
        report.written += 1;
        next.files.insert(key.clone(), new_print);
    }

    // Nos anciens fichiers qui ne sont plus voulus (note supprimée, renommée ou déplacée).
    for (key, print) in &old.files {
        if wanted.contains_key(key) {
            continue;
        }
        let Some(rel) = safe_rel_path(key) else { continue };
        let target = root.join(&rel);
        let Ok(meta) = fs::symlink_metadata(&target) else { continue };
        if !meta.is_file() || !target.parent().and_then(|p| p.canonicalize().ok()).is_some_and(|p| p.starts_with(root)) {
            continue;
        }
        let unchanged = fs::read(&target).is_ok_and(|c| &fingerprint(&c) == print);
        if unchanged {
            if fs::remove_file(&target).is_ok() {
                report.removed += 1;
                if let Some(dir) = target.parent() {
                    remove_empty_dirs(root, dir.to_path_buf());
                }
            }
        }
        // Modifié dans Obsidian : on le laisse tel quel, il n'est plus à nous (retiré du manifeste).
    }

    fs::create_dir_all(root.join(META_DIR)).map_err(|e| format!("Impossible de créer {META_DIR} : {e}"))?;
    let json = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
    fs::write(&manifest_path, json).map_err(|e| format!("Impossible d'enregistrer le manifeste : {e}"))?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("aery-vault-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn file(path: &str, content: &str) -> VaultFile {
        VaultFile { path: path.into(), content: content.into() }
    }

    #[test]
    fn accepts_only_simple_relative_markdown_paths() {
        assert!(safe_rel_path("0 - Boîte de réception/Ma note.md").is_some());
        assert!(safe_rel_path("3 - Ressources/React/Hooks.md").is_some());
        assert!(safe_rel_path("Note.md").is_some());
        for bad in [
            "",
            "../evil.md",
            "a/../../evil.md",
            "/etc/passwd.md",
            "a/./b.md",
            ".obsidian/app.md",
            "a/.cache.md",
            "note.txt",
            "note.sh",
            "a\\b.md",
            "a//b.md",
            "a/b/c/d.md",
            " a/b.md",
            "a/b.md\n",
            ".md",
        ] {
            assert!(safe_rel_path(bad).is_none(), "devrait refuser {bad:?}");
        }
    }

    #[test]
    fn writes_then_skips_unchanged_files() {
        let root = temp_vault();
        let files = [file("1 - Projets/Aery.md", "# Aery\n"), file("Note.md", "Bonjour\n")];
        let first = write_vault(&root, &files, "t1").unwrap();
        assert_eq!((first.written, first.unchanged, first.backed_up), (2, 0, 0));
        assert_eq!(fs::read_to_string(root.join("1 - Projets/Aery.md")).unwrap(), "# Aery\n");
        let second = write_vault(&root, &files, "t2").unwrap();
        assert_eq!((second.written, second.unchanged), (0, 2));
        assert!(root.join(".aery/manifest.json").exists());
    }

    #[test]
    fn backs_up_a_file_edited_in_obsidian_before_replacing_it() {
        let root = temp_vault();
        write_vault(&root, &[file("Note.md", "v1\n")], "t1").unwrap();
        fs::write(root.join("Note.md"), "modifié dans Obsidian\n").unwrap();
        let report = write_vault(&root, &[file("Note.md", "v2\n")], "t2").unwrap();
        assert_eq!(report.backed_up, 1);
        assert_eq!(fs::read_to_string(root.join("Note.md")).unwrap(), "v2\n");
        assert_eq!(fs::read_to_string(root.join(".aery/sauvegardes/t2/Note.md")).unwrap(), "modifié dans Obsidian\n");
        // Un fichier qui n'est pas à nous est aussi sauvegardé avant d'être remplacé.
        fs::write(root.join("Perso.md"), "à moi\n").unwrap();
        let report = write_vault(&root, &[file("Note.md", "v2\n"), file("Perso.md", "Aery\n")], "t3").unwrap();
        assert_eq!(report.backed_up, 1);
        assert_eq!(fs::read_to_string(root.join(".aery/sauvegardes/t3/Perso.md")).unwrap(), "à moi\n");
    }

    #[test]
    fn removes_only_our_unmodified_files() {
        let root = temp_vault();
        write_vault(&root, &[file("A/Vieux.md", "a\n"), file("B/Modifié.md", "b\n")], "t1").unwrap();
        fs::write(root.join("B/Modifié.md"), "b modifié\n").unwrap();
        fs::write(root.join("A/Pas à nous.md"), "x\n").unwrap();
        fs::write(root.join("Ailleurs.md"), "y\n").unwrap();
        let report = write_vault(&root, &[file("C/Neuf.md", "c\n")], "t2").unwrap();
        assert_eq!(report.removed, 1);
        assert!(!root.join("A/Vieux.md").exists());
        assert!(root.join("A/Pas à nous.md").exists(), "un fichier jamais écrit par Aery n'est pas touché");
        assert_eq!(fs::read_to_string(root.join("B/Modifié.md")).unwrap(), "b modifié\n");
        assert!(root.join("Ailleurs.md").exists());
        // Le fichier modifié n'est plus suivi : un nouvel export ne le supprime pas non plus.
        write_vault(&root, &[], "t3").unwrap();
        assert!(root.join("B/Modifié.md").exists());
    }

    #[test]
    fn removes_empty_folders_after_a_move() {
        let root = temp_vault();
        write_vault(&root, &[file("0 - Boîte de réception/N.md", "n\n")], "t1").unwrap();
        write_vault(&root, &[file("3 - Ressources/N.md", "n\n")], "t2").unwrap();
        assert!(!root.join("0 - Boîte de réception").exists());
        assert!(root.join("3 - Ressources/N.md").exists());
    }

    #[test]
    fn refuses_bad_paths_before_writing_anything() {
        let root = temp_vault();
        let err = write_vault(&root, &[file("Ok.md", "ok"), file("../dehors.md", "x")], "t1").unwrap_err();
        assert!(err.contains("Chemin refusé"));
        assert!(!root.join("Ok.md").exists(), "rien n'est écrit si un chemin est refusé");
        assert!(write_vault(&root, &[file("a.md", "1"), file("A.md", "2")], "t1").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_follow_a_symlink_out_of_the_vault() {
        let root = temp_vault();
        let outside = temp_vault();
        std::os::unix::fs::symlink(&outside, root.join("Lien")).unwrap();
        let err = write_vault(&root, &[file("Lien/Note.md", "x")], "t1").unwrap_err();
        assert!(err.contains("sort du dossier"));
        assert!(!outside.join("Note.md").exists());
    }

    #[test]
    fn stamp_looks_like_a_date() {
        let s = backup_stamp();
        assert_eq!(s.len(), 17, "{s}");
        assert!(s.starts_with("20"));
    }
}
