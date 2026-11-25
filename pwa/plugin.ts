import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

/**
 * Au build : écrit dist/sw.js à partir de pwa/sw.js, avec la liste des fichiers de l'interface et
 * une version = empreinte de leur contenu (même build = même service worker, rien à retélécharger).
 * Rien en dev (npm run dev) : le service worker n'est enregistré que par la version construite.
 */
export function serviceWorkerPlugin(): Plugin {
  let config: ResolvedConfig
  return {
    name: 'aery-service-worker',
    apply: 'build',
    configResolved(resolved) {
      config = resolved
    },
    closeBundle() {
      const outDir = path.resolve(config.root, config.build.outDir)
      const hash = crypto.createHash('sha256')
      const files: string[] = []
      for (const entry of fs.readdirSync(outDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.') || entry.name === 'sw.js') continue
        const full = path.join(entry.parentPath, entry.name)
        const url = '/' + path.relative(outDir, full).split(path.sep).join('/')
        files.push(url === '/index.html' ? '/' : url)
        hash.update(url).update(fs.readFileSync(full))
      }
      files.sort()
      const template = fs.readFileSync(path.resolve(import.meta.dirname, 'sw.js'), 'utf8')
      hash.update(template) // un changement du service worker lui-même = nouvelle version aussi
      const code = template
        .replace("const CACHE = 'aery-__VERSION__'", `const CACHE = 'aery-${hash.digest('hex').slice(0, 12)}'`)
        .replace('const FILES = __FILES__', `const FILES = ${JSON.stringify(files)}`)
      if (code.includes('= __') || code.includes("-__VERSION__")) throw new Error('pwa/sw.js : modèle modifié, remplacements impossibles.')
      fs.writeFileSync(path.join(outDir, 'sw.js'), code)
    },
  }
}
