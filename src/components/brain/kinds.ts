import { FileText, Globe, MessageSquareQuote, StickyNote, type LucideIcon } from 'lucide-react'
import type { BrainKind } from '@/lib/brain'

/** Icône de chaque type d'élément du cerveau. */
export const BRAIN_KIND_ICONS: Record<BrainKind, LucideIcon> = {
  note: StickyNote,
  reply: MessageSquareQuote,
  file: FileText,
  web: Globe,
}
