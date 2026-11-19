fn main() {
  // Mises à jour (src/updates.rs) : on grave dans l'appli le PATH du terminal qui la construit,
  // pour retrouver git, node et npm quand elle se relance elle-même (une appli ouverte depuis
  // le Finder n'a qu'un PATH minimal). Le commit et l'arbre git (FREELLM_BUILD_COMMIT/TREE)
  // sont lus directement par option_env!, et cargo recompile quand ils changent.
  println!("cargo:rerun-if-env-changed=PATH");
  if let Ok(path) = std::env::var("PATH") {
    println!("cargo:rustc-env=FREELLM_BUILD_PATH={path}");
  }
  tauri_build::build()
}
