#!/usr/bin/env bash
# Déploie la version web d'Aery sur le serveur (par défaut : pronoti, via ~/.ssh/config).
#
#   bash scripts/deploy-server.sh            → construit, envoie, redémarre
#   bash scripts/deploy-server.sh --setup    → 1re fois : crée l'utilisateur, le service et `tailscale serve`
#
# Options :
#   --no-build      réutilise dist/ tel quel (install-app.sh vient de le construire via Tauri)
#   --if-clean      s'il y a des modifs non commitées : ne déploie pas, sans erreur (utilisé par install-app.sh)
#   --allow-dirty   déploie quand même des modifs non commitées (pour tester)
#
# Par défaut, on refuse de déployer des modifs non commitées : le serveur doit toujours
# correspondre à un commit précis (noté dans /opt/aery/VERSION).
#
# Lancé automatiquement par scripts/install-app.sh (npm run app:install et bouton « Mettre à jour »).
#
# Sur le serveur :
#   /opt/aery/{dist,server}   code (appartient à root, lecture seule pour le service)
#   /var/lib/aery/config.json clé freellmapi- + port (écrits depuis Paramètres › Connexion)
#   /etc/aery/env             comptes Tailscale autorisés + compte d'admin FreeLLMAPI (root, 600)
#                              → à remplir avec : ssh -t pronoti sudo /opt/aery/set-admin.sh
set -euo pipefail

HOST="${AERY_HOST:-pronoti}"
ALLOWED_USERS="${AERY_ALLOWED_USERS:-}"
cd "$(dirname "$0")/.."

SETUP=0
BUILD=1
IF_CLEAN=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --setup) SETUP=1 ;;
    --no-build) BUILD=0 ;;
    --if-clean) IF_CLEAN=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

# --- Garde-fou : le serveur doit correspondre à un commit ---------------------------------
if [[ -n "$(git status --porcelain)" && $ALLOW_DIRTY == 0 ]]; then
  if [[ $IF_CLEAN == 1 ]]; then
    echo "Note : modifs non commitées, la version web du serveur n'est pas mise à jour (commit puis relance)."
    exit 0
  fi
  echo "Erreur : il y a des modifs non commitées. Commit-les (ou --allow-dirty pour tester)." >&2
  exit 1
fi
VERSION="$(git rev-parse HEAD)"
[[ -z "$(git status --porcelain)" ]] || VERSION="$VERSION-dirty"

# Serveur joignable ? (Tailscale coupé, pas de réseau… : on le dit clairement, en 10 s max)
SSH=(ssh -o ConnectTimeout=10)
if ! "${SSH[@]}" "$HOST" true 2>/dev/null; then
  echo "Erreur : le serveur $HOST ne répond pas en SSH (réseau ? 1Password verrouillé ?)." >&2
  exit 3
fi

if [[ $BUILD == 1 ]]; then
  echo "→ Construction de l'interface"
  npm run build >/dev/null 2>&1 || { echo "Erreur : la construction a échoué (lance npm run build pour voir)." >&2; exit 1; }
fi
[[ -f dist/index.html ]] || { echo "Erreur : dist/ est vide, lance d'abord npm run build." >&2; exit 1; }

STAGE="$("${SSH[@]}" "$HOST" 'mktemp -d /tmp/aery-deploy.XXXXXX')"
echo "→ Envoi vers $HOST (${VERSION:0:7})"
rsync -a --delete -e "ssh -o ConnectTimeout=10" dist/ "$HOST:$STAGE/dist/"
rsync -a -e "ssh -o ConnectTimeout=10" server/backend.ts server/standalone.ts server/sync.ts "$HOST:$STAGE/server/"
"${SSH[@]}" "$HOST" "printf '{\"type\":\"module\"}\n' > $STAGE/server/package.json && printf '%s\n' '$VERSION' > $STAGE/VERSION"
rsync -a -e "ssh -o ConnectTimeout=10" scripts/server/ "$HOST:$STAGE/tools/"

if [[ $SETUP == 1 ]]; then
  if [[ -z "$ALLOWED_USERS" ]]; then
    echo "AERY_ALLOWED_USERS manquant (ex. AERY_ALLOWED_USERS=moi@github bash scripts/deploy-server.sh --setup)" >&2
    exit 1
  fi
  echo "→ Première installation"
  ssh "$HOST" "sudo bash -s" -- "$STAGE" "$ALLOWED_USERS" <<'EOF'
set -euo pipefail
STAGE="$1"; USERS="$2"
id aery >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin aery
install -d -m 755 -o root -g root /opt/aery
install -d -m 700 -o root -g root /etc/aery
if [[ ! -f /etc/aery/env ]]; then
  (umask 077; printf 'AERY_ALLOWED_USERS=%s\n' "$USERS" > /etc/aery/env)
fi
# Vide tant que set-admin.sh n'a pas été lancé (systemd refuse de démarrer si le fichier manque).
[[ -f /etc/aery/freellm-admin.json ]] || install -m 600 -o root -g root /dev/null /etc/aery/freellm-admin.json
install -m 644 -o root -g root "$STAGE/tools/aery.service" /etc/systemd/system/aery.service
systemctl daemon-reload
systemctl enable aery >/dev/null 2>&1
EOF
fi

echo "→ Installation et redémarrage"
ssh "$HOST" "sudo bash -s" -- "$STAGE" <<'EOF'
set -euo pipefail
STAGE="$1"
rsync -a --delete --chown=root:root "$STAGE/dist/" /opt/aery/dist/
rsync -a --delete --chown=root:root "$STAGE/server/" /opt/aery/server/
install -m 755 -o root -g root "$STAGE/tools/set-admin.sh" /opt/aery/set-admin.sh
install -m 644 -o root -g root "$STAGE/VERSION" /opt/aery/VERSION
if ! cmp -s "$STAGE/tools/aery.service" /etc/systemd/system/aery.service; then
  install -m 644 -o root -g root "$STAGE/tools/aery.service" /etc/systemd/system/aery.service
  systemctl daemon-reload
fi
chmod -R a+rX /opt/aery/dist /opt/aery/server
rm -rf "$STAGE"
systemctl restart aery
sleep 2
systemctl is-active aery
EOF

if [[ $SETUP == 1 ]]; then
  echo "→ Publication sur ton réseau Tailscale (HTTPS)"
  ssh "$HOST" 'sudo timeout 20 tailscale serve --bg --yes --https=443 http://127.0.0.1:3080' ||
    echo "⚠ tailscale serve a échoué : active « HTTPS Certificates » dans login.tailscale.com › DNS, puis relance --setup." >&2
fi

echo "✓ Déployé : https://$(ssh "$HOST" "tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"Self\"][\"DNSName\"].rstrip(\".\"))'")"
