#!/usr/bin/env bash
# Construit Aery et remplace la version installée dans /Applications.
#
#   npm run app:install         construit, ferme l'appli, installe, relance
#
# Options (utilisées par le bouton « Mettre à jour » de l'appli, src-tauri/src/updates.rs) :
#   --pull                      récupère d'abord les nouveautés de GitHub (git pull en avance rapide)
#   --build-only                construit seulement
#   --install-only --wait-pid N installe le .app déjà construit, une fois le processus N terminé
#
# L'historique (IndexedDB), la clé (Trousseau) et le port sont stockés hors du .app : rien n'est perdu.
set -euo pipefail

APP_NAME="Aery"
# Ancien nom de l'appli : sa version installée est fermée puis supprimée (sinon deux applis cohabitent).
OLD_APP_NAME="FreeLLM Chat"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILT="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"
OLD_DEST="/Applications/$OLD_APP_NAME.app"

PULL=0
BUILD=1
INSTALL=1
WAIT_PID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pull) PULL=1 ;;
    --build-only) INSTALL=0 ;;
    --install-only) BUILD=0 ;;
    --wait-pid) WAIT_PID="${2:?--wait-pid attend un numéro de processus}"; shift ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$ROOT"
# Rust (rustup via Homebrew, keg-only) doit être dans le PATH pour la compilation.
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

# --- 1. Nouveautés de GitHub ------------------------------------------------------------
if [ "$PULL" = 1 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "Erreur : il y a des modifications pas encore commitées dans le projet. Commit-les avant de mettre à jour." >&2
    exit 1
  fi
  if git rev-parse --verify --quiet '@{u}' >/dev/null; then
    echo "==> Récupération des nouveautés (git pull)"
    OLD_HEAD="$(git rev-parse HEAD)"
    git fetch --quiet
    if git merge-base --is-ancestor HEAD '@{u}'; then
      git merge --ff-only --quiet '@{u}'
    else
      echo "Ton repo local et GitHub ont divergé : on construit la version locale."
    fi
    # Nouvelles dépendances ? Sans elles, la construction échouerait.
    if ! git diff --quiet "$OLD_HEAD" HEAD -- package.json package-lock.json; then
      echo "==> Installation des nouvelles dépendances (npm install)"
      npm install --no-audit --no-fund
    fi
  fi
fi

# --- 2. Construction --------------------------------------------------------------------
if [ "$BUILD" = 1 ]; then
  # Le commit et l'arbre git sont gravés dans l'appli : c'est comme ça qu'elle sait si elle est à jour.
  # `git stash create` fabrique un commit temporaire avec les modifs en cours, sans rien toucher.
  if git rev-parse --git-dir >/dev/null 2>&1; then
    FREELLM_BUILD_COMMIT="$(git rev-parse HEAD)"
    STASH="$(git stash create)"
    FREELLM_BUILD_TREE="$(git rev-parse "${STASH:-HEAD}^{tree}")"
    export FREELLM_BUILD_COMMIT FREELLM_BUILD_TREE
  fi
  echo "==> Construction de l'appli"
  npx tauri build --bundles app
  if [ ! -d "$BUILT" ]; then
    echo "Erreur : $BUILT introuvable après la construction." >&2
    exit 1
  fi
fi

# --- 3. Installation --------------------------------------------------------------------
if [ "$INSTALL" = 1 ]; then
  if [ ! -d "$BUILT" ]; then
    echo "Erreur : $BUILT introuvable. Lance d'abord la construction." >&2
    exit 1
  fi

  if [ -n "$WAIT_PID" ]; then
    # Lancé par l'appli elle-même : on attend qu'elle ait fini de se fermer.
    # En cas de pépin, on rouvre ce qui est installé pour ne pas te laisser sans appli.
    trap 'open "$DEST" 2>/dev/null || true' ERR
    for _ in $(seq 1 150); do
      kill -0 "$WAIT_PID" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$WAIT_PID" 2>/dev/null; then
      echo "Erreur : l'appli ne s'est pas fermée." >&2
      exit 1
    fi
  else
    # Le processus s'appelle "freellm-chat" (nom du binaire) : on le repère par son chemin.
    is_running() { pgrep -qf "$DEST/Contents/MacOS/" || pgrep -qf "$OLD_DEST/Contents/MacOS/"; }
    if is_running; then
      echo "==> Fermeture de $APP_NAME"
      osascript -e "quit app \"$APP_NAME\"" 2>/dev/null || true
      osascript -e "quit app \"$OLD_APP_NAME\"" 2>/dev/null || true
      for _ in $(seq 1 20); do
        is_running || break
        sleep 0.5
      done
      if is_running; then
        echo "Erreur : $APP_NAME ne s'est pas fermée. Quitte-la puis relance la commande." >&2
        exit 1
      fi
    fi
  fi

  echo "==> Installation dans /Applications"
  # Copie à côté puis échange : si la copie échoue, l'ancienne version reste intacte.
  rm -rf "$DEST.new"
  ditto "$BUILT" "$DEST.new"
  rm -rf "$DEST"
  mv "$DEST.new" "$DEST"
  if [ -d "$OLD_DEST" ]; then
    echo "==> Suppression de l'ancienne version ($OLD_APP_NAME)"
    rm -rf "$OLD_DEST"
  fi

  echo "==> Lancement"
  open "$DEST"
  echo "OK : $APP_NAME est à jour."
fi
