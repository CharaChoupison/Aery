import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'
import { serviceWorkerPlugin } from './pwa/plugin.ts'
import { freellmPlugin } from './server/freellmPlugin.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), freellmPlugin(), serviceWorkerPlugin()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  // ⚠️ Sécurité : on écoute uniquement en local. Ne jamais mettre host: true / '0.0.0.0',
  // sinon n'importe qui sur ton réseau Wi-Fi pourrait utiliser ton chat (et tes quotas).
  // strictPort : l'historique (IndexedDB) est lié à l'adresse exacte de la page. Si Vite changeait
  // de port tout seul (5174…), tu croirais avoir perdu tes conversations. On préfère une erreur claire.
  server: { host: 'localhost', port: 5173, strictPort: true },
  preview: { host: 'localhost', port: 4173, strictPort: true },
})
