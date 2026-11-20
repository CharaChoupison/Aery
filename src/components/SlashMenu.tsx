import { CornerDownLeft, Slash } from 'lucide-react'
import { Appear } from '@/components/Appear'
import { slashOptionId, type SlashItem, type SlashCommand } from '@/lib/commands'
import { cn } from '@/lib/utils'

interface Props {
  id: string
  items: SlashItem[]
  activeIndex: number
  /** Commande reconnue dont on tape l'argument : rappel de sa syntaxe en haut du menu. */
  current: SlashCommand | null
  /** Nom tapé qui ne correspond à aucune commande. */
  unknown: string | null
  placement: 'above' | 'below'
  onHover: (index: number) => void
  onChoose: (index: number) => void
}

/** Menu des commandes slash, affiché au-dessus (ou en dessous) du champ de saisie. */
export function SlashMenu({ id, items, activeIndex, current, unknown, placement, onHover, onChoose }: Props) {
  return (
    <Appear
      from={{ autoAlpha: 0, y: placement === 'above' ? 6 : -6, duration: 0.18 }}
      className={cn(
        'absolute right-0 left-0 z-20 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-lg',
        placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-2',
      )}
    >
      {current && (
        <div className="flex items-center gap-2 border-b px-3.5 py-2.5 text-sm">
          <current.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="font-medium">/{current.name}</span>
          {current.argHint && <span className="text-muted-foreground">{current.argHint}</span>}
          <span className={cn('ml-auto truncate pl-4 text-xs', current.disabled ? 'text-destructive' : 'text-muted-foreground')}>
            {current.disabled ?? current.description}
          </span>
        </div>
      )}
      {unknown !== null && (
        <p className="px-3.5 py-2.5 text-sm text-muted-foreground">
          Aucune commande « /{unknown} ». Entrée l’enverra comme un message normal.
        </p>
      )}
      {items.length > 0 && (
        <ul id={id} role="listbox" aria-label="Commandes" className="max-h-72 overflow-y-auto p-1.5">
          {items.map((item, i) => {
            const active = i === activeIndex
            const c = item.command
            return (
              <li
                key={item.kind === 'command' ? c.name : `${c.name}:${item.suggestion.value}`}
                id={slashOptionId(id, i)}
                role="option"
                aria-selected={active}
                aria-disabled={item.kind === 'command' && c.disabled ? true : undefined}
                // mousedown : on garde le focus dans le champ de saisie.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => !active && onHover(i)}
                onClick={() => onChoose(i)}
                className={cn(
                  'flex cursor-default items-center gap-3 rounded-xl px-2.5 py-2 text-sm select-none',
                  active && 'bg-muted',
                  item.kind === 'command' && c.disabled && 'opacity-60',
                )}
              >
                {item.kind === 'command' ? (
                  <>
                    <c.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="shrink-0 font-medium">/{c.name}</span>
                    {c.argHint && <span className="hidden shrink-0 text-muted-foreground sm:inline">{c.argHint}</span>}
                    {c.custom && <span className="shrink-0 rounded-full border px-1.5 text-[11px] text-muted-foreground">perso</span>}
                    <span className="ml-auto min-w-0 truncate pl-2 text-right text-xs text-muted-foreground">{c.disabled ?? c.description}</span>
                  </>
                ) : (
                  <>
                    <Slash className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 truncate font-medium">{item.suggestion.label}</span>
                    {item.suggestion.detail && (
                      <span className="ml-auto min-w-0 shrink truncate pl-2 text-right text-xs text-muted-foreground">{item.suggestion.detail}</span>
                    )}
                  </>
                )}
                {active && <CornerDownLeft className={cn('size-3.5 shrink-0 text-muted-foreground', item.kind === 'arg' && !item.suggestion.detail && 'ml-auto')} aria-hidden />}
              </li>
            )
          })}
        </ul>
      )}
      <p className="hidden border-t px-3.5 py-1.5 text-[11px] text-muted-foreground sm:block">
        ↑ ↓ pour naviguer · Entrée pour choisir · Tab pour compléter · Échap pour fermer
      </p>
    </Appear>
  )
}
