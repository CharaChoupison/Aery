<p align="center">
  <img src="src-tauri/app-icon.png" width="128" alt="Logo d'Aery" />
</p>

# Aery

Une interface de chat façon ChatGPT pour [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi), le proxy compatible OpenAI qui regroupe les quotas gratuits de nombreux fournisseurs de LLM derrière un seul endpoint `/v1`.

Aery fonctionne **dans le navigateur** (Vite) et en **application macOS** (Tauri v2).

## Fonctionnalités

- **Chat en streaming** (SSE) avec bouton Stop, gestion des erreurs 429/5xx et bouton Réessayer
- **Rendu Markdown** (tableaux GFM, blocs de code colorés avec bouton copier)
- **Modèles à raisonnement** : la réflexion s'affiche à part, avant la réponse
- **Sélecteur de modèle** à partir de `/v1/models`, avec `auto` par défaut et affichage du modèle réellement utilisé
- **Historique** des conversations dans IndexedDB : renommer, supprimer, titre généré automatiquement
- **Paramètres** : thème clair/sombre/système, animations, largeur de conversation, prompt système, température, top P, max tokens, nombre de messages envoyés
- **Pages Modèles et Analytique** (lecture seule) : scores de fiabilité, de vitesse et d'intelligence, requêtes, erreurs, journaux
- **Animations** GSAP qui respectent « Réduire les animations » de macOS

## Sécurité

- La clé FreeLLMAPI est saisie dans l'interface puis gardée **côté serveur** : dans `~/.freellm-chat/` (droits 600) en version web, dans le **Trousseau macOS** en version appli. L'interface peut l'écrire mais ne la relit jamais.
- Le navigateur ne parle jamais directement à FreeLLMAPI : un petit proxy local (plugin Vite ou Rust) ajoute l'en-tête `Authorization` et ne relaie qu'une liste blanche de routes.
- Protection CSRF (`Sec-Fetch-Site`, `Origin`), validation stricte des entrées, pas de HTML brut dans le rendu Markdown, CSP stricte dans l'appli.
- Les routes d'administration utilisées pour les statistiques sont limitées à des requêtes `GET` en lecture seule.

## Stack

React 19 · TypeScript · Vite · Tailwind CSS v4 · shadcn/ui (Base UI) · react-markdown · highlight.js · Dexie · GSAP · lucide-react · Tauri v2 (Rust)

## Prérequis

- [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) lancé en local (appli desktop, port `31415` par défaut) et sa clé unifiée `freellmapi-…`
- Node.js 20+
- Pour l'appli : Rust (`rustup`) et les [prérequis Tauri](https://tauri.app/start/prerequisites/)

## Lancer le projet

```bash
npm install
```

Version web, sur http://localhost:5173 :

```bash
npm run dev
```

Appli de bureau, avec rechargement automatique :

```bash
npm run app:dev
```

Construire l'appli (`.app` et `.dmg` dans `src-tauri/target/release/bundle/macos/`) :

```bash
npm run app:build
```

Au premier lancement, ouvre **Paramètres → Connexion** pour saisir la clé et le port de FreeLLMAPI.

## Structure

```
server/freellmPlugin.ts   proxy local et stockage de la clé (version web)
src-tauri/src/            proxy, réglages et Trousseau (version appli)
src/lib/                  API, SSE, historique, préférences, thème, animations
src/components/           interface du chat
src/pages/                pages Modèles et Analytique
```
