//! Mises à jour de l'appli à partir du repo git du projet.
//!
//!  - `scripts/install-app.sh` grave dans l'appli le commit et l'arbre git à partir desquels elle
//!    a été construite (FREELLM_BUILD_COMMIT / FREELLM_BUILD_TREE) ;
//!  - `check_updates` fait un `git fetch` et compare avec le repo local et GitHub ;
//!  - `run_update` lance `git pull` + la construction pendant que l'appli tourne encore (si ça
//!    échoue, rien n'a changé), puis démarre l'installation en arrière-plan et quitte l'appli :
//!    le script attend qu'elle soit fermée, remplace le .app et la relance.
//!
//! Sécurité : le dossier du projet et le script sont figés à la compilation. L'interface ne
//! choisit ni la commande ni ses arguments.

use serde::Serialize;
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, ipc::Channel};

const BUILD_COMMIT: Option<&str> = option_env!("FREELLM_BUILD_COMMIT");
const BUILD_TREE: Option<&str> = option_env!("FREELLM_BUILD_TREE");
const BUILD_PATH: Option<&str> = option_env!("FREELLM_BUILD_PATH");
const FALLBACK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_COMMITS: usize = 30;
const ERROR_TAIL_LINES: usize = 25;

static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    hash: String,
    summary: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// Commit (court) de la version installée. `None` = construite sans `npm run app:install`.
    installed: Option<String>,
    /// Commit (court) qu'on obtiendrait en mettant à jour.
    latest: String,
    available: bool,
    /// Nouveautés depuis la version installée (les plus récentes d'abord).
    commits: Vec<CommitInfo>,
    /// Pourquoi le bouton « Mettre à jour » est désactivé, s'il l'est.
    blocked: Option<String>,
    warnings: Vec<String>,
}

/// Dossier du projet : celui d'où l'appli a été compilée (src-tauri/..).
fn project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().map(Path::to_path_buf).unwrap_or_default()
}

fn command(program: &str, root: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.current_dir(root)
        .env("PATH", BUILD_PATH.unwrap_or(FALLBACK_PATH))
        // Pas de terminal : git ne doit jamais attendre un mot de passe.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        .stdin(Stdio::null());
    cmd
}

/// Lance git et renvoie sa sortie, sans le retour à la ligne final.
fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = command("git", root).args(args).output().map_err(|e| format!("git introuvable : {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// `git fetch`, coupé au bout de FETCH_TIMEOUT (réseau lent ou absent). `true` si ça a marché.
fn git_fetch(root: &Path) -> bool {
    let Ok(mut child) = command("git", root).args(["fetch", "--quiet"]).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
    else {
        return false;
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if start.elapsed() < FETCH_TIMEOUT => thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn count(root: &Path, range: &str) -> Result<usize, String> {
    git(root, &["rev-list", "--count", range])?.parse().map_err(|_| "réponse de git inattendue".to_string())
}

fn is_hash(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn short(hash: &str) -> String {
    hash.chars().take(7).collect()
}

fn commits_between(root: &Path, from: &str, to: &str) -> Result<Vec<CommitInfo>, String> {
    let range = format!("{from}..{to}");
    let max = format!("--max-count={MAX_COMMITS}");
    let out = git(root, &["log", &max, "--format=%h%x1f%s", &range])?;
    Ok(out
        .lines()
        .filter_map(|line| line.split_once('\u{1f}'))
        .map(|(hash, summary)| CommitInfo { hash: hash.to_string(), summary: summary.to_string() })
        .collect())
}

/// Compare la version installée (`build_commit`/`build_tree`) avec le repo du projet.
fn compute_status(root: &Path, build_commit: Option<&str>, build_tree: Option<&str>, fetch: bool) -> Result<UpdateStatus, String> {
    if !root.join(".git").exists() {
        return Err(format!("Pas de repo git dans {} : le projet a été déplacé ?", root.display()));
    }
    let mut warnings = Vec::new();
    if fetch && !git_fetch(root) {
        warnings.push("GitHub est injoignable : seules les modifications de ton repo local sont vérifiées.".to_string());
    }

    let head = git(root, &["rev-parse", "HEAD"])?;
    // La version qu'on construirait : celle de GitHub si on peut l'atteindre en avance rapide.
    let mut target = head.clone();
    if let Ok(upstream) = git(root, &["rev-parse", "--verify", "--quiet", "@{u}"])
        && upstream != head
    {
        let behind = count(root, "HEAD..@{u}")?;
        let ahead = count(root, "@{u}..HEAD")?;
        if behind > 0 && ahead == 0 {
            target = upstream;
        } else if behind > 0 {
            warnings.push(
                "Ton repo local et GitHub ont divergé : fais un git pull à la main pour récupérer les nouveautés de GitHub."
                    .to_string(),
            );
        }
    }

    // On compare des arbres (le contenu des fichiers) plutôt que des commits : une version
    // construite avec des modifs en cours, puis commitées telles quelles, reste « à jour ».
    let target_tree = git(root, &["rev-parse", &format!("{target}^{{tree}}")])?;
    let dirty = !git(root, &["status", "--porcelain"])?.is_empty();
    // Installée avec `npm run app:install` pendant que des modifs étaient en cours : elle est en
    // avance sur le dernier commit, pas en retard. On la compare alors aux fichiers sur le disque
    // (`git stash create` fabrique un commit temporaire de ces fichiers sans rien toucher).
    let matches_disk = || -> Result<bool, String> {
        let stash = git(root, &["stash", "create"])?;
        Ok(!stash.is_empty() && build_tree == Some(git(root, &["rev-parse", &format!("{stash}^{{tree}}")])?.as_str()))
    };
    let available = build_tree != Some(target_tree.as_str()) && !(dirty && target == head && matches_disk()?);

    let installed = build_commit.filter(|c| is_hash(c));
    let commits = match installed {
        Some(c) if available && git(root, &["merge-base", "--is-ancestor", c, &target]).is_ok() => {
            commits_between(root, c, &target)?
        }
        _ => Vec::new(),
    };

    let blocked = if !dirty {
        None
    } else {
        Some(
            "Il y a des modifications pas encore commitées dans le projet. Commit-les d’abord, ou lance npm run app:install pour les inclure telles quelles."
                .to_string(),
        )
    };

    Ok(UpdateStatus { installed: installed.map(short), latest: short(&target), available, commits, blocked, warnings })
}

#[tauri::command]
pub async fn check_updates() -> Result<UpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(|| compute_status(&project_root(), BUILD_COMMIT, BUILD_TREE, true))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn run_update(app: AppHandle, on_step: Channel<String>) -> Result<(), String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("Une mise à jour est déjà en cours.".into());
    }
    let result = match app.path().app_log_dir() {
        Ok(dir) => tauri::async_runtime::spawn_blocking(move || update(&dir, &on_step))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r),
        Err(e) => Err(format!("Dossier des journaux introuvable : {e}")),
    };
    match result {
        // L'installation attend notre fermeture pour remplacer l'appli.
        Ok(()) => {
            app.exit(0);
            Ok(())
        }
        Err(e) => {
            RUNNING.store(false, Ordering::SeqCst);
            Err(e)
        }
    }
}

fn update(log_dir: &Path, on_step: &Channel<String>) -> Result<(), String> {
    let root = project_root();
    let script = root.join("scripts/install-app.sh");
    if !script.is_file() {
        return Err(format!("Script introuvable : {}", script.display()));
    }
    fs::create_dir_all(log_dir).map_err(|e| format!("Impossible de créer {} : {e}", log_dir.display()))?;
    let log_path = log_dir.join("update.log");
    let io_error = |e: std::io::Error| format!("Journal {} : {e}", log_path.display());

    // Étape 1 : git pull + construction. La sortie va dans un fichier (pas un tube), qu'on relit
    // au fur et à mesure pour afficher les étapes (« ==> … »).
    let log = File::create(&log_path).map_err(io_error)?;
    let mut child = command("/bin/bash", &root)
        .arg(&script)
        .args(["--pull", "--build-only"])
        .env("NO_COLOR", "1")
        .env("CARGO_TERM_COLOR", "never")
        .stdout(log.try_clone().map_err(io_error)?)
        .stderr(log)
        .spawn()
        .map_err(|e| format!("Impossible de lancer la mise à jour : {e}"))?;
    let status = follow(&mut child, &log_path, on_step)?;
    if !status.0.success() {
        return Err(format!(
            "La mise à jour a échoué, l’appli installée n’a pas changé.\n\n{}\n\nJournal complet : {}",
            status.1,
            log_path.display()
        ));
    }

    // Étape 2 : installation, détachée de l'appli (son propre groupe de processus) pour
    // survivre à sa fermeture. Elle écrit à la suite du même journal.
    let _ = on_step.send("Redémarrage".into());
    let log = OpenOptions::new().append(true).open(&log_path).map_err(io_error)?;
    command("/bin/bash", &root)
        .arg(&script)
        .args(["--install-only", "--wait-pid", &std::process::id().to_string()])
        .stdout(log.try_clone().map_err(io_error)?)
        .stderr(log)
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Impossible de lancer l’installation : {e}"))?;
    Ok(())
}

/// Attend la fin du script en relisant son journal. Renvoie son statut et les dernières lignes.
fn follow(child: &mut std::process::Child, log_path: &Path, on_step: &Channel<String>) -> Result<(ExitStatus, String), String> {
    let mut reader = File::open(log_path).map_err(|e| e.to_string())?;
    let mut pending = String::new();
    let mut tail: VecDeque<String> = VecDeque::new();
    let mut handle_line = |line: &str| {
        if let Some(step) = line.strip_prefix("==> ") {
            let _ = on_step.send(step.to_string());
        }
        if tail.len() == ERROR_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line.to_string());
    };
    loop {
        // On regarde d'abord si c'est fini, PUIS on lit : ainsi on n'oublie aucune ligne.
        let done = child.try_wait().map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        pending.push_str(&String::from_utf8_lossy(&buf));
        while let Some(i) = pending.find('\n') {
            let line: String = pending.drain(..=i).collect();
            handle_line(line.trim_end());
        }
        if let Some(status) = done {
            if !pending.is_empty() {
                handle_line(pending.trim_end());
            }
            let tail = tail.into_iter().filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
            return Ok((status, tail));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Petit repo git jetable dans le dossier temporaire.
    struct Repo(PathBuf);

    impl Repo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("freellm-updates-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let repo = Repo(dir);
            repo.git(&["init", "--quiet", "-b", "main"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "user.name", "Test"]);
            repo
        }
        fn git(&self, args: &[&str]) -> String {
            git(&self.0, args).unwrap()
        }
        fn commit(&self, file: &str, content: &str, message: &str) -> String {
            fs::write(self.0.join(file), content).unwrap();
            self.git(&["add", "."]);
            self.git(&["commit", "--quiet", "-m", message]);
            self.git(&["rev-parse", "HEAD"])
        }
        fn tree(&self, rev: &str) -> String {
            self.git(&["rev-parse", &format!("{rev}^{{tree}}")])
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_jour_puis_nouveaux_commits() {
        let repo = Repo::new("local");
        let installed = repo.commit("a.txt", "1", "Premier");
        let tree = repo.tree("HEAD");

        let status = compute_status(&repo.0, Some(&installed), Some(&tree), false).unwrap();
        assert!(!status.available);
        assert!(status.commits.is_empty());
        assert_eq!(status.blocked, None);

        repo.commit("a.txt", "2", "Deuxième");
        repo.commit("b.txt", "3", "Troisième");
        let status = compute_status(&repo.0, Some(&installed), Some(&tree), false).unwrap();
        assert!(status.available);
        let summaries: Vec<_> = status.commits.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries, ["Troisième", "Deuxième"]);
        assert_eq!(status.installed.as_deref(), Some(&installed[..7]));
    }

    #[test]
    fn modifs_non_commitees_bloquent() {
        let repo = Repo::new("dirty");
        let installed = repo.commit("a.txt", "1", "Premier");
        let tree = repo.tree("HEAD");
        fs::write(repo.0.join("a.txt"), "modifié").unwrap();
        let status = compute_status(&repo.0, Some(&installed), Some(&tree), false).unwrap();
        assert!(!status.available);
        assert!(status.blocked.is_some());
    }

    #[test]
    fn installee_avec_des_modifs_en_cours_reste_a_jour() {
        let repo = Repo::new("ahead");
        let head = repo.commit("a.txt", "1", "Premier");
        fs::write(repo.0.join("a.txt"), "en cours").unwrap();
        // Ce que fait install-app.sh : l'arbre gravé est celui des fichiers sur le disque.
        let stash = repo.git(&["stash", "create"]);
        let tree = repo.tree(&stash);

        let status = compute_status(&repo.0, Some(&head), Some(&tree), false).unwrap();
        assert!(!status.available);

        // On commite exactement ces modifs : toujours à jour.
        repo.git(&["commit", "--quiet", "-am", "Modifs"]);
        let status = compute_status(&repo.0, Some(&head), Some(&tree), false).unwrap();
        assert!(!status.available);
        assert_eq!(status.blocked, None);
    }

    #[test]
    fn version_inconnue_propose_une_mise_a_jour() {
        let repo = Repo::new("unknown");
        repo.commit("a.txt", "1", "Premier");
        let status = compute_status(&repo.0, None, None, false).unwrap();
        assert!(status.available);
        assert_eq!(status.installed, None);
        assert!(status.commits.is_empty());
    }

    #[test]
    fn suit_github_quand_il_est_en_avance() {
        let remote = Repo::new("remote");
        let installed = remote.commit("a.txt", "1", "Premier");
        let local = Repo::new("clone");
        fs::remove_dir_all(&local.0).unwrap();
        git(&remote.0, &["clone", "--quiet", remote.0.to_str().unwrap(), local.0.to_str().unwrap()]).unwrap();
        let tree = local.tree("HEAD");

        remote.commit("a.txt", "2", "Sur GitHub");
        local.git(&["fetch", "--quiet"]);
        let status = compute_status(&local.0, Some(&installed), Some(&tree), false).unwrap();
        assert!(status.available);
        assert_eq!(status.commits.len(), 1);
        assert_eq!(status.commits[0].summary, "Sur GitHub");
        assert!(status.warnings.is_empty());
    }

    #[test]
    fn reconnait_un_hash() {
        assert!(is_hash("8327ded"));
        assert!(!is_hash("HEAD"));
        assert!(!is_hash("abc"));
        assert!(!is_hash("--all"));
    }
}

#[cfg(test)]
mod real_repo {
    /// Vérification sur le vrai repo du projet, avec le commit/arbre passés en variables
    /// d'environnement (comme install-app.sh) :
    /// `FREELLM_BUILD_COMMIT=… FREELLM_BUILD_TREE=… cargo test real_repo -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn affiche_l_etat_du_projet() {
        let status = super::compute_status(&super::project_root(), super::BUILD_COMMIT, super::BUILD_TREE, true).unwrap();
        println!("{status:#?}");
    }
}
