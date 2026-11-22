//! Sauvegarde d'Aery (Paramètres › Général) : l'interface prépare le fichier JSON, Rust ouvre la
//! fenêtre « Enregistrer » de macOS et l'écrit là où l'utilisateur l'a choisi.
//!
//! L'interface ne donne jamais de chemin : seulement un nom proposé (vérifié) et le contenu.
//! Le seul endroit où l'on écrit est celui choisi à la main dans la fenêtre native.

use std::{fs, io::Write, path::Path};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Même limite que côté interface (`MAX_BACKUP_BYTES`).
const MAX_BYTES: usize = 500 * 1024 * 1024;

/// Nom proposé dans la fenêtre : lettres, chiffres, `-`, `_`, `.`, et qui finit par `.json`.
fn is_valid_name(name: &str) -> bool {
    (6..=80).contains(&name.len())
        && name.ends_with(".json")
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Écrit dans un fichier temporaire à côté puis le renomme : un fichier à moitié écrit
/// ne remplace jamais une ancienne sauvegarde.
fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.part");
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Renvoie le chemin écrit, ou `None` si l'utilisateur a annulé.
#[tauri::command]
pub async fn save_backup(app: AppHandle, name: String, contents: String) -> Result<Option<String>, String> {
    if !is_valid_name(&name) {
        return Err("Nom de fichier invalide.".into());
    }
    if contents.len() > MAX_BYTES {
        return Err("Sauvegarde trop lourde (plus de 500 Mo).".into());
    }
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Enregistrer la sauvegarde d'Aery")
        .set_file_name(&name)
        .add_filter("Sauvegarde Aery", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|_| "Emplacement invalide.".to_string())?;
    let shown = path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || write_atomic(&path, contents.as_bytes()))
        .await
        .map_err(|e| format!("Erreur interne : {e}"))?
        .map_err(|e| format!("Impossible d'écrire la sauvegarde : {e}"))?;
    Ok(Some(shown))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_names_are_checked() {
        assert!(is_valid_name("aery-sauvegarde-2026-11-22.json"));
        for bad in ["", ".json", "../x.json", "a/b.json", "x.txt", "x .json", ".cache.json", "x\n.json"] {
            assert!(!is_valid_name(bad), "{bad:?} devrait être refusé");
        }
    }

    #[test]
    fn writes_atomically() {
        let dir = std::env::temp_dir().join(format!("aery-backup-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.json");
        write_atomic(&path, b"{\"a\":1}").unwrap();
        write_atomic(&path, b"{\"a\":2}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":2}");
        assert!(!dir.join("s.json.part").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
