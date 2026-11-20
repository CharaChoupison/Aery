import { MessageSquarePlus } from 'lucide-react'
import type { useChat } from '@/hooks/useChat'
import type { ModelInfo } from '@/lib/api'
import type { Attachment } from '@/lib/attachments'
import {
  builtin,
  CODE_LANGUAGES,
  expandCustom,
  filterSuggestions,
  LANGUAGES,
  PROMPTS,
  splitFirstWord,
  type CommandSuggestion,
  type CustomCommand,
  type SlashCommand,
} from '@/lib/commands'
import { projectSpace, type Project } from '@/lib/projects'

interface Deps {
  chat: ReturnType<typeof useChat>
  models: ModelInfo[]
  projects: Project[]
  /** Nouvelle conversation (version de l'App : reste dans le projet de code ouvert). */
  newConversation: () => void
  /** Affiche la carte d'utilisation au-dessus du champ. */
  showUsage: () => void
  custom: CustomCommand[]
  /** /note : garde le texte dans le second cerveau. */
  saveNote: (text: string) => void
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
const NO_PROJECT = 'aucun'

/** Suggestions du premier mot seulement (tant qu'on n'a pas tapé d'espace après). */
function firstWordSuggestions(items: string[], arg: string): CommandSuggestion[] {
  if (/\s/.test(arg)) return []
  return filterSuggestions(items.map((value) => ({ value, label: value })), arg)
}

/**
 * Toutes les commandes slash, avec leurs actions branchées sur l'état de l'appli.
 * Recalculé à chaque rendu (c'est léger) : les actions voient toujours l'état à jour.
 */
export function useSlashCommands({ chat, models, projects, newConversation, showUsage, custom, saveNote }: Deps): SlashCommand[] {
  const active = chat.active
  const hasMessages = (active?.messages.length ?? 0) > 0
  const busy = chat.isStreaming ? 'Une réponse est en cours.' : undefined
  const noConversation = active ? undefined : 'Ouvre d’abord une conversation.'

  /** Envoie un message (commandes de prompt), avec les pièces jointes du champ. */
  const send = (text: string, attachments: Attachment[], overrides?: Parameters<typeof chat.send>[2]) => {
    chat.send(text, attachments, overrides)
  }
  const needsText = (arg: string, attachments: Attachment[], usage: string) =>
    !arg && attachments.length === 0 ? `Écris ton message après la commande : ${usage}` : undefined

  const modelItems: CommandSuggestion[] = models.map((m) => ({ value: m.id, label: m.name, detail: m.id !== m.name ? m.id : undefined }))
  if (!models.some((m) => m.id === 'auto')) modelItems.unshift({ value: 'auto', label: 'Auto', detail: 'le routeur choisit' })

  const projectItems: CommandSuggestion[] = [
    { value: NO_PROJECT, label: 'Hors projet', detail: 'Chat' },
    ...projects.map((p) => ({ value: p.name, label: p.name, detail: projectSpace(p) === 'code' ? 'Code' : 'Chat' })),
  ]

  const builtins: SlashCommand[] = [
    {
      ...builtin('new'),
      run: () => newConversation(),
    },
    {
      ...builtin('model'),
      argIsChoice: true,
      suggest: (arg) => filterSuggestions(modelItems, arg),
      run: (arg) => {
        if (!arg) return 'Indique un modèle, par exemple : /model auto'
        // Nom exact, sinon le seul modèle qui correspond à ce qui est tapé.
        const exact = modelItems.find((m) => fold(m.value) === fold(arg) || fold(m.label) === fold(arg))
        const close = filterSuggestions(modelItems, arg, 2)
        const guess = exact ?? (close.length === 1 ? close[0] : undefined)
        if (!guess) return models.length ? `Modèle « ${arg} » introuvable.` : 'La liste des modèles n’est pas encore chargée.'
        chat.setModel(guess.value)
      },
    },
    {
      ...builtin('search'),
      sends: true,
      disabled: busy,
      run: (arg, files) => needsText(arg, files, '/search quoi de neuf ?') ?? send(arg, files, { webSearch: true }),
    },
    {
      ...builtin('nosearch'),
      sends: true,
      disabled: busy,
      run: (arg, files) => needsText(arg, files, '/nosearch ta question') ?? send(arg, files, { webSearch: false }),
    },
    {
      ...builtin('cerveau'),
      sends: true,
      disabled: busy,
      run: (arg, files) => needsText(arg, files, '/cerveau qu’est-ce que j’avais noté sur React ?') ?? send(arg, files, { brain: true }),
    },
    {
      ...builtin('note'),
      run: (arg) => {
        if (!arg) return 'Écris la note après la commande : /note Penser à relire le cours de BDD'
        saveNote(arg)
      },
    },
    {
      ...builtin('fusion'),
      sends: true,
      disabled: busy,
      run: (arg, files) => {
        if (models.length && !models.some((m) => m.id === 'fusion')) return 'Fusion n’est pas disponible dans ton FreeLLMAPI.'
        return (
          needsText(arg, files, '/fusion ta question') ??
          send(arg, files, { model: 'fusion', note: 'Réponse de Fusion : plusieurs modèles, puis un juge (consomme plusieurs requêtes).' })
        )
      },
    },
    {
      ...builtin('retry'),
      disabled: busy ?? noConversation ?? (hasMessages ? undefined : 'Rien à régénérer pour l’instant.'),
      run: () => chat.regenerate() ?? undefined,
    },
    {
      ...builtin('title'),
      disabled: noConversation,
      run: (arg) => {
        if (!arg) return 'Écris le nouveau titre : /title Mon super titre'
        chat.renameConversation(active!.id, arg)
      },
    },
    {
      ...builtin('move'),
      argIsChoice: true,
      disabled: noConversation,
      suggest: (arg) => filterSuggestions(projectItems, arg),
      run: (arg) => {
        if (!arg) return 'Indique un projet, ou « aucun » pour la sortir de son projet.'
        if (fold(arg) === NO_PROJECT || fold(arg) === 'hors projet') return chat.moveConversation(active!.id, null)
        const exact = projects.filter((p) => fold(p.name) === fold(arg))
        const partial = projects.filter((p) => fold(p.name).includes(fold(arg)))
        const target = exact.length === 1 ? exact[0] : exact.length === 0 && partial.length === 1 ? partial[0] : undefined
        if (!target) return exact.length + partial.length > 1 ? `Plusieurs projets correspondent à « ${arg} ».` : `Projet « ${arg} » introuvable.`
        chat.moveConversation(active!.id, target.id)
      },
    },
    {
      ...builtin('usage'),
      run: () => showUsage(),
    },
    {
      ...builtin('resume'),
      sends: true,
      disabled: busy ?? (hasMessages ? undefined : 'Rien à résumer pour l’instant.'),
      run: (arg, files) => send(PROMPTS.summary(arg), files),
    },
    {
      ...builtin('traduis'),
      sends: true,
      disabled: busy,
      suggest: (arg) => firstWordSuggestions(LANGUAGES, arg),
      run: (arg, files) => {
        const [language, text] = splitFirstWord(arg)
        if (!language) return 'Indique la langue : /traduis anglais Bonjour à tous'
        if (!text && !hasMessages) return 'Écris le texte à traduire après la langue.'
        send(PROMPTS.translate(language, text), files)
      },
    },
    {
      ...builtin('corrige'),
      sends: true,
      disabled: busy,
      run: (arg, files) => (arg ? send(PROMPTS.fix(arg), files) : 'Colle le texte à corriger après /corrige.'),
    },
    {
      ...builtin('explique'),
      sends: true,
      disabled: busy,
      run: (arg, files) => {
        if (!arg && !hasMessages) return 'Écris ce qu’il faut expliquer : /explique les closures en JS'
        send(PROMPTS.explain(arg), files)
      },
    },
    {
      ...builtin('code'),
      sends: true,
      disabled: busy,
      suggest: (arg) => firstWordSuggestions(CODE_LANGUAGES, arg),
      run: (arg, files) => {
        const [language, request] = splitFirstWord(arg)
        if (!language || !request) return 'Indique le langage puis la demande : /code python trier une liste'
        send(PROMPTS.code(language, request), files)
      },
    },
  ]

  const mine: SlashCommand[] = custom.map((c) => ({
    name: c.name,
    description: c.description || 'Commande personnalisée',
    icon: MessageSquarePlus,
    argHint: '[texte]',
    sends: true,
    custom: true,
    disabled: busy,
    run: (arg, files) => {
      const text = expandCustom(c.prompt, arg)
      if (!text && files.length === 0) return 'Cette commande ne produit aucun texte.'
      send(text, files)
    },
  }))

  return [...builtins, ...mine]
}
