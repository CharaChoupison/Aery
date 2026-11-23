#!/usr/bin/env bash
# Enregistre le compte d'admin FreeLLMAPI pour Aery (pages Modèles, Clés, Utilisation, Analytique).
# À lancer sur le serveur :  ssh -t pronoti sudo /opt/aery/set-admin.sh
# Le mot de passe est tapé ici (invisible), jamais dans l'interface web ni dans un historique.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "À lancer avec sudo." >&2; exit 1; }

FILE=/etc/aery/freellm-admin.json
read -rp "E-mail du compte FreeLLMAPI : " EMAIL
read -rsp "Mot de passe : " PASSWORD; echo
[[ -n "$EMAIL" && -n "$PASSWORD" ]] || { echo "E-mail et mot de passe obligatoires." >&2; exit 1; }

BODY="$(EMAIL="$EMAIL" PASSWORD="$PASSWORD" python3 -c 'import json,os; print(json.dumps({"email":os.environ["EMAIL"].strip(),"password":os.environ["PASSWORD"]}))')"

# Vérifie le compte auprès de FreeLLMAPI avant de l'enregistrer.
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:3001/api/auth/login <<<"$BODY")"
[[ "$STATUS" == 200 ]] || { echo "FreeLLMAPI refuse ce compte (HTTP $STATUS). Rien n'a été changé." >&2; exit 1; }

TMP="$(mktemp "$FILE.XXXXXX")"
chmod 600 "$TMP"
printf '%s\n' "$BODY" > "$TMP"
mv "$TMP" "$FILE"
systemctl restart aery
echo "Compte enregistré, Aery redémarré."
