import type { ComponentProps, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type Props = Omit<ComponentProps<typeof Button>, 'children'> & {
  /** Texte de l'infobulle, aussi utilisé comme aria-label (lecteurs d'écran). */
  label: string
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}

/** Bouton avec seulement une icône + une infobulle au survol. */
export function IconButton({ label, children, side = 'bottom', variant = 'ghost', size = 'icon', ...props }: Props) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant={variant} size={size} aria-label={label} {...props} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
