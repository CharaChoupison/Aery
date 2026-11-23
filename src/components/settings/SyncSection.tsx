import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Group, Row } from '@/components/settings/layout'
import { syncNow, useSyncStatus, type SyncStatus } from '@/lib/sync'

const timeFormat = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short' })

function statusText(s: SyncStatus, now: number): string {
  switch (s.phase) {
    case 'syncing':
      return 'Synchronisation en cours…'
    case 'offline':
      return 'Hors ligne : tes changements partiront au retour du réseau.'
    case 'unavailable':
      return 'Pas de serveur de synchro pour cette version (rien n’est envoyé).'
    case 'error':
      return `Dernier essai échoué : ${(s.message ?? 'erreur inconnue').replace(/\.$/, '')}.`
    default:
      if (s.lastSyncAt === null) return 'Pas encore synchronisé.'
      return now - s.lastSyncAt < 60_000 ? 'À jour.' : `À jour (dernière synchro à ${timeFormat.format(s.lastSyncAt)}).`
  }
}

/** Paramètres › Général : état de la synchro entre appareils. */
export function SyncSection() {
  const status = useSyncStatus()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  const pending =
    status.pending > 0 ? ` ${status.pending} changement${status.pending > 1 ? 's' : ''} en attente d’envoi.` : ''

  return (
    <Group
      title="Synchronisation"
      description="Conversations, projets et cerveau sont partagés entre tes appareils via ton serveur. Chaque appareil garde aussi sa copie : tout marche hors ligne."
    >
      <Row
        label="État"
        description={statusText(status, now) + pending}
        control={
          <Button variant="outline" size="sm" disabled={status.phase === 'syncing'} onClick={() => void syncNow(true)}>
            <RefreshCw aria-hidden className={status.phase === 'syncing' ? 'animate-spin' : undefined} />
            Synchroniser maintenant
          </Button>
        }
      />
    </Group>
  )
}
