import {
  BookOpen,
  Bot,
  Briefcase,
  Calculator,
  Camera,
  Code,
  Coffee,
  Database,
  Dumbbell,
  Film,
  FlaskConical,
  Folder,
  FolderCode,
  FolderOpen,
  Gamepad2,
  Globe,
  GraduationCap,
  Heart,
  House,
  Leaf,
  Lightbulb,
  Music,
  Palette,
  PawPrint,
  PenLine,
  Plane,
  Rocket,
  Server,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Star,
  Target,
  Terminal,
  Trophy,
  Utensils,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { projectColor, projectSpace, type Project } from '@/lib/projects'

/**
 * Icônes proposées pour un projet. On stocke l'id (« rocket »…), pas le composant :
 * si une icône disparaît un jour de la liste, le projet retombe simplement sur le dossier.
 */
export const PROJECT_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  code: { icon: Code, label: 'Code' },
  terminal: { icon: Terminal, label: 'Terminal' },
  database: { icon: Database, label: 'Base de données' },
  server: { icon: Server, label: 'Serveur' },
  smartphone: { icon: Smartphone, label: 'Mobile' },
  bot: { icon: Bot, label: 'Robot' },
  book: { icon: BookOpen, label: 'Livre' },
  graduation: { icon: GraduationCap, label: 'Études' },
  pen: { icon: PenLine, label: 'Écriture' },
  calculator: { icon: Calculator, label: 'Maths' },
  flask: { icon: FlaskConical, label: 'Sciences' },
  globe: { icon: Globe, label: 'Monde' },
  briefcase: { icon: Briefcase, label: 'Travail' },
  target: { icon: Target, label: 'Objectif' },
  lightbulb: { icon: Lightbulb, label: 'Idée' },
  rocket: { icon: Rocket, label: 'Fusée' },
  sparkles: { icon: Sparkles, label: 'Étincelles' },
  star: { icon: Star, label: 'Étoile' },
  trophy: { icon: Trophy, label: 'Trophée' },
  heart: { icon: Heart, label: 'Cœur' },
  palette: { icon: Palette, label: 'Art' },
  music: { icon: Music, label: 'Musique' },
  camera: { icon: Camera, label: 'Photo' },
  film: { icon: Film, label: 'Film' },
  gamepad: { icon: Gamepad2, label: 'Jeu' },
  plane: { icon: Plane, label: 'Voyage' },
  house: { icon: House, label: 'Maison' },
  wallet: { icon: Wallet, label: 'Budget' },
  cart: { icon: ShoppingCart, label: 'Courses' },
  utensils: { icon: Utensils, label: 'Cuisine' },
  coffee: { icon: Coffee, label: 'Café' },
  dumbbell: { icon: Dumbbell, label: 'Sport' },
  leaf: { icon: Leaf, label: 'Nature' },
  paw: { icon: PawPrint, label: 'Animaux' },
}

/** Icône par défaut : dossier (ouvert / fermé) dans le Chat, dossier de code dans le Code. */
export function defaultProjectIcon(project: Pick<Project, 'space'>, open = false): LucideIcon {
  return projectSpace(project) === 'code' ? FolderCode : open ? FolderOpen : Folder
}

export function projectIconOf(project: Pick<Project, 'space' | 'icon'>, open = false): LucideIcon {
  return (project.icon && PROJECT_ICONS[project.icon]?.icon) || defaultProjectIcon(project, open)
}

/** Style de couleur : la variable CSS du thème, ou rien (le parent décide, gris en général). */
export function projectColorStyle(project: Pick<Project, 'color'>): CSSProperties | undefined {
  const color = projectColor(project)
  return color ? { color: `var(--project-${color})` } : undefined
}

/**
 * L'icône d'un projet, avec sa couleur.
 * `open` : pour l'icône par défaut du Chat (dossier ouvert quand le projet est déplié).
 */
export function ProjectIcon({
  project,
  open,
  className,
}: {
  project: Pick<Project, 'space' | 'icon' | 'color'>
  open?: boolean
  className?: string
}) {
  const Icon = projectIconOf(project, open)
  const style = projectColorStyle(project)
  return <Icon className={cn(!style && 'text-muted-foreground', className)} style={style} aria-hidden />
}

/**
 * Pastille de l'accueil d'un projet : fond légèrement teinté de la couleur choisie
 * (color-mix, pour rester lisible en clair comme en sombre).
 */
export function ProjectBadge({ project, className }: { project: Pick<Project, 'space' | 'icon' | 'color'>; className?: string }) {
  const color = projectColor(project)
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-2xl bg-muted', className)}
      style={color ? { backgroundColor: `color-mix(in oklab, var(--project-${color}) 16%, transparent)` } : undefined}
    >
      <ProjectIcon project={project} open className={cn('size-1/2', !color && 'text-foreground')} />
    </span>
  )
}
