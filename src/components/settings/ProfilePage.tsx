import { ChevronRight } from 'lucide-react'
import { Group, Row, SelectControl } from '@/components/settings/layout'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  buildSystemPrompt,
  setPreferences,
  usePreferences,
  type Address,
  type BaseStyle,
  type Level,
  type Profile,
} from '@/lib/preferences'

const LEVEL_OPTIONS: { value: Level; label: string }[] = [
  { value: 'default', label: 'Par défaut' },
  { value: 'more', label: 'Plus' },
  { value: 'less', label: 'Moins' },
]

const STYLE_OPTIONS: { value: BaseStyle; label: string }[] = [
  { value: 'default', label: 'Par défaut' },
  { value: 'efficient', label: 'Efficace' },
  { value: 'detailed', label: 'Détaillé' },
  { value: 'teacher', label: 'Pédagogue' },
  { value: 'casual', label: 'Décontracté' },
  { value: 'professional', label: 'Professionnel' },
]

const ADDRESS_OPTIONS: { value: Address; label: string }[] = [
  { value: 'default', label: 'Au choix du modèle' },
  { value: 'tu', label: 'Tutoiement' },
  { value: 'vous', label: 'Vouvoiement' },
]

/** Personnalisation façon ChatGPT : ces infos sont ajoutées au prompt système de chaque conversation. */
export function ProfilePage() {
  const prefs = usePreferences()
  const profile = prefs.profile
  const update = (patch: Partial<Profile>) => setPreferences({ profile: { ...profile, ...patch } })
  const preview = buildSystemPrompt(prefs)

  return (
    <>
      <div className="mb-6">
        <Row
          label="Activer la personnalisation"
          description="Le profil et la personnalité ci-dessous sont envoyés au modèle avant chaque conversation. Ils restent sur cet appareil."
          control={<Switch checked={profile.enabled} onCheckedChange={(enabled) => update({ enabled })} aria-label="Activer la personnalisation" />}
        />
      </div>

      <fieldset disabled={!profile.enabled} className="mb-8 transition-opacity disabled:opacity-50">
        <Group title="Profil">
          <Row label="Comment t’appeler" description="Un prénom, un surnom…" control={
            <Input value={profile.name} onChange={(e) => update({ name: e.target.value })} maxLength={60} aria-label="Comment t’appeler" className="h-9 w-56" />
          } />
          <Row label="Pronoms" description="Pour que le modèle accorde correctement quand il parle de toi." control={
            <Input
              value={profile.pronouns}
              onChange={(e) => update({ pronouns: e.target.value })}
              maxLength={40}
              placeholder="elle, il, iel…"
              aria-label="Pronoms"
              className="h-9 w-56"
            />
          } />
          <Row
            label="Tutoiement ou vouvoiement"
            control={<SelectControl<Address> label="Tutoiement ou vouvoiement" value={profile.address} options={ADDRESS_OPTIONS} onChange={(address) => update({ address })} />}
          />
          <Row label="Métier ou études" control={
            <Input
              value={profile.occupation}
              onChange={(e) => update({ occupation: e.target.value })}
              maxLength={100}
              placeholder="Ex. : alternance en développement front"
              aria-label="Métier ou études"
              className="h-9 w-72"
            />
          } />
          <Row label="À propos de toi" description="Centres d’intérêt, valeurs, ce que tu aimerais que le modèle garde en tête.">
            <Textarea
              value={profile.about}
              onChange={(e) => update({ about: e.target.value })}
              maxLength={2000}
              placeholder="Ex. : j’apprends React et TypeScript, j’aime les explications avec des exemples concrets."
              aria-label="À propos de toi"
              className="max-h-48 min-h-20"
            />
          </Row>
        </Group>

        <Group title="Personnalité" description="Le ton des réponses. « Par défaut » laisse le modèle décider.">
          <Row
            label="Style et ton de base"
            control={<SelectControl<BaseStyle> label="Style et ton de base" value={profile.style} options={STYLE_OPTIONS} onChange={(style) => update({ style })} />}
          />
          {(
            [
              ['warmth', 'Chaleur'],
              ['enthusiasm', 'Enthousiasme'],
              ['emojis', 'Émojis'],
              ['formatting', 'Titres et listes'],
            ] as const
          ).map(([key, label]) => (
            <Row
              key={key}
              label={label}
              control={<SelectControl<Level> label={label} value={profile[key]} options={LEVEL_OPTIONS} onChange={(v) => update({ [key]: v } as Partial<Profile>)} />}
            />
          ))}
        </Group>
      </fieldset>

      <Group title="Instructions personnalisées">
        <Row label="Instructions" description="Envoyées avant chaque conversation, même si la personnalisation est désactivée (langue, rôle, règles…).">
          <Textarea
            value={prefs.systemPrompt}
            onChange={(e) => setPreferences({ systemPrompt: e.target.value })}
            placeholder="Ex. : Réponds toujours en français, avec des exemples de code en TypeScript."
            aria-label="Instructions personnalisées"
            className="max-h-60 min-h-24"
          />
        </Row>
      </Group>

      {/* Pour voir (et comprendre) exactement ce que reçoit le modèle. */}
      <details className="group rounded-xl border px-4 py-3">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />
          Aperçu du message envoyé au modèle
        </summary>
        <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs whitespace-pre-wrap">
          {preview || 'Rien pour l’instant : aucun message système n’est envoyé.'}
        </pre>
      </details>
    </>
  )
}
