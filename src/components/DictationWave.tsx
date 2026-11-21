import { useEffect, useState } from 'react'
import type { LevelSource } from '@/hooks/useDictation'
import { useMotion } from '@/lib/motion'

const BARS = 40

/**
 * Pendant la dictée : barres qui suivent le niveau du micro (les plus récentes à droite) + chrono.
 * Le niveau arrive environ 16 fois par seconde : seul ce petit composant se re-rend, pas le champ.
 */
export function DictationWave({ levels, startedAt }: { levels: LevelSource; startedAt: number }) {
  const motion = useMotion()
  const [history, setHistory] = useState<number[]>(() => Array(BARS).fill(0))
  const [now, setNow] = useState(() => Date.now())

  useEffect(
    () =>
      levels.subscribe((level) => {
        // Racine : la voix parlée est souvent faible, on l'amplifie pour qu'elle se voie.
        setHistory((h) => [...h.slice(1), Math.min(1, Math.sqrt(level) * 1.4)])
      }),
    [levels],
  )

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])

  const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 px-2" role="status" aria-label={`Dictée en cours, ${time}`}>
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
      <div className="flex h-7 min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden" aria-hidden>
        {history.map((level, i) => (
          <span
            key={i}
            className="w-[3px] shrink-0 rounded-full bg-foreground/70"
            style={{
              height: `${Math.max(3, level * 28)}px`,
              transition: motion ? 'height 90ms linear' : undefined,
            }}
          />
        ))}
      </div>
      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{time}</span>
    </div>
  )
}
