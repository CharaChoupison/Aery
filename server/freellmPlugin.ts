/**
 * Plugin Vite = notre mini « backend » local (npm run dev / preview, sur ton Mac).
 *
 * Toute la logique (réglages, proxy /v1, admin) est dans server/backend.ts, partagée avec le
 * serveur autonome (server/standalone.ts). Ici, on la branche simplement sur le serveur de Vite.
 * La clé et le port sont gardés dans ~/.freellm-chat/config.json, HORS du projet.
 */
import os from 'node:os'
import path from 'node:path'
import type { Plugin } from 'vite'
import { createBackend } from './backend.ts'

export function freellmPlugin(): Plugin {
  const backend = createBackend({
    configFile: path.join(os.homedir(), '.freellm-chat', 'config.json'),
    defaultPort: 31415, // port par défaut de l'appli desktop FreeLLMAPI
  })
  const middleware = (req: Parameters<typeof backend.handle>[0], res: Parameters<typeof backend.handle>[1], next: () => void) => {
    if (!backend.handle(req, res)) next()
  }
  return {
    name: 'freellm-backend',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
