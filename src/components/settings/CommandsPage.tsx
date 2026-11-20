import { CircleAlert, MessageSquarePlus, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Group, Notice, Row } from '@/components/settings/layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  BUILTIN_COMMANDS,
  BUILTIN_NAMES,
  commandNameError,
  CUSTOM_LIMITS,
  PLACEHOLDER,
  type CustomCommand,
} from '@/lib/commands'
import { setPreferences, usePreferences } from '@/lib/preferences'

type Draft = Omit<CustomCommand, 'id'> & { id: string | null }

const EMPTY: Draft = { id: null, name: '', description: '', prompt: '' }

/**
 * Paramètres › Commandes : les commandes slash intégrées (rappel), et celles qu'on crée soi-même.
 * Une commande perso = un nom + un texte envoyé au modèle ({{texte}} = ce qu'on tape après).
 */
export function CommandsPage() {
  const { commands } = usePreferences()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)

  function save() {
    if (!draft) return
    const name = draft.name.trim().toLowerCase()
    const taken = [...BUILTIN_NAMES, ...commands.filter((c) => c.id !== draft.id).map((c) => c.name)]
    const problem = commandNameError(name, taken) ?? (draft.prompt.trim() ? null : 'Écris le texte que la commande enverra.')
    if (problem) return setError(problem)
    const command: CustomCommand = { id: draft.id ?? crypto.randomUUID(), name, description: draft.description.trim(), prompt: draft.prompt }
    setPreferences({
      commands: draft.id ? commands.map((c) => (c.id === draft.id ? command : c)) : [...commands, command],
    })
    setDraft(null)
    setError(null)
  }

  function edit(next: Draft | null) {
    setDraft(next)
    setError(null)
  }

  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">
        Tape <kbd className="rounded border bg-muted px-1 font-mono text-xs">/</kbd> au début d’un message pour ouvrir le menu des
        commandes. Les flèches pour choisir, Entrée pour lancer, Tab pour compléter.
      </p>

      <Group
        title="Tes commandes"
        description="Des raccourcis vers les prompts que tu utilises souvent."
        action={
          !draft && commands.length < CUSTOM_LIMITS.count ? (
            <Button variant="outline" className="h-8" onClick={() => edit(EMPTY)}>
              <Plus aria-hidden />
              Nouvelle commande
            </Button>
          ) : undefined
        }
      >
        {draft && (
          <div className="my-3 flex flex-col gap-3 rounded-2xl border p-4">
            <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
              <label className="flex flex-col gap-1.5 text-sm">
                Nom
                <span className="flex items-center rounded-lg border border-input focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
                  <span className="pl-2.5 text-muted-foreground" aria-hidden>
                    /
                  </span>
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase().replace(/\s/g, '-') })}
                    maxLength={CUSTOM_LIMITS.name}
                    placeholder="mail-pro"
                    autoFocus
                    className="h-8 min-w-0 flex-1 bg-transparent pr-2.5 pl-0.5 outline-none placeholder:text-muted-foreground"
                  />
                </span>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                Description <span className="sr-only">(facultative)</span>
                <Input
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  maxLength={CUSTOM_LIMITS.description}
                  placeholder="Facultatif : affichée dans le menu"
                  className="h-8"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1.5 text-sm">
              Texte envoyé
              <Textarea
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                maxLength={CUSTOM_LIMITS.prompt}
                placeholder={`Transforme ce texte en mail professionnel, poli et concis :\n\n${PLACEHOLDER}`}
                className="min-h-28"
              />
              <span className="text-xs text-muted-foreground">
                <code className="font-mono">{PLACEHOLDER}</code> est remplacé par ce que tu tapes après la commande. Sans lui, ton texte
                est ajouté à la fin.
              </span>
            </label>
            {error && (
              <Notice tone="error" icon={CircleAlert}>
                {error}
              </Notice>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" className="h-8" onClick={() => edit(null)}>
                Annuler
              </Button>
              <Button className="h-8" onClick={save}>
                Enregistrer
              </Button>
            </div>
          </div>
        )}

        {commands.length === 0 && !draft && (
          <p className="py-3 text-sm text-muted-foreground">Aucune commande pour l’instant. Crée la première avec « Nouvelle commande ».</p>
        )}
        {commands.map((c) => (
          <Row
            key={c.id}
            label={
              <span className="flex items-center gap-2">
                <MessageSquarePlus className="size-4 text-muted-foreground" aria-hidden />
                <span className="font-medium">/{c.name}</span>
              </span>
            }
            description={c.description || <span className="line-clamp-1">{c.prompt}</span>}
            control={
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => edit({ ...c })}
                  aria-label={`Modifier /${c.name}`}
                  title="Modifier"
                  className="text-muted-foreground"
                >
                  <Pencil aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    setPreferences({ commands: commands.filter((x) => x.id !== c.id) })
                    if (draft?.id === c.id) edit(null)
                  }}
                  aria-label={`Supprimer /${c.name}`}
                  title="Supprimer"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            }
          />
        ))}
      </Group>

      <Group title="Commandes intégrées">
        {BUILTIN_COMMANDS.map((c) => (
          <Row
            key={c.name}
            label={
              <span className="flex items-center gap-2">
                <c.icon className="size-4 text-muted-foreground" aria-hidden />
                <span className="font-medium">/{c.name}</span>
                {c.argHint && <span className="text-muted-foreground">{c.argHint}</span>}
              </span>
            }
            description={c.description}
          />
        ))}
      </Group>
    </>
  )
}
