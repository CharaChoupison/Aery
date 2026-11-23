import { ArrowUp, Bot, Brain, CircleAlert, Eye, FileText, FolderCode, FolderOpen, Globe, Mic, Paperclip, Plus, Square, Upload, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Appear } from '@/components/Appear'
import { DictationControls, DictationNotices } from '@/components/DictationControls'
import { IconButton } from '@/components/IconButton'
import { SlashMenu } from '@/components/SlashMenu'
import {
  ACCEPT,
  AttachmentError,
  formatSize,
  MAX_ATTACHMENTS,
  MAX_IMAGES,
  readAttachment,
  type Attachment,
} from '@/lib/attachments'
import { gsap, useMotion } from '@/lib/motion'
import { folderName, pickWorkspace, type AgentSettings } from '@/lib/agent/tools'
import { matchCommands, parseCommand, slashOptionId, type SlashCommand, type SlashItem } from '@/lib/commands'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useDictation } from '@/hooks/useDictation'
import { CAN_DICTATE, spliceDictation, type DictationBase } from '@/lib/dictation'
import { setPreferences, usePreferences } from '@/lib/preferences'
import { IS_TAURI } from '@/lib/transport'
import { cn } from '@/lib/utils'

interface Props {
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
  isStreaming: boolean // CETTE conversation reçoit une réponse → bouton Stop
  busy?: boolean // une AUTRE conversation reçoit une réponse → envoi bloqué (une seule à la fois)
  /** Quand cette valeur change (ex. changement de conversation), on remet le focus dans le champ. */
  focusKey?: string
  /** false = le modèle choisi ne lit pas les images (null = on ne sait pas). */
  modelReadsImages?: boolean | null
  /** Espace Code : l'agent et son dossier (null = chat normal). Affiché en lecture seule. */
  agent?: AgentSettings | null
  /** Espace Chat : dossier joint en lecture seule, et son changement (absent = option masquée). */
  folder?: string | null
  onFolderChange?: (folder: string | null) => void
  /** false = le modèle choisi ne sait pas appeler d'outils : pas de recherche web (null = on ne sait pas). */
  modelUsesTools?: boolean | null
  /** Commandes slash (« /new », « /model »…) proposées quand le message commence par « / ». */
  commands?: SlashCommand[]
  /** Texte d'exemple du champ (absent = celui par défaut). */
  placeholder?: string
  /** Texte déjà écrit dans le champ au montage (ex. premier message proposé), modifiable. */
  initialValue?: string
}

const MAX_HEIGHT = 200 // px : au-delà, le champ défile au lieu de grandir

// Sur écran tactile, Entrée fait un retour à la ligne (comme ChatGPT mobile) : on envoie avec le bouton.
const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

export function Composer({
  onSend,
  onStop,
  isStreaming,
  busy = false,
  focusKey,
  modelReadsImages = null,
  agent = null,
  folder = null,
  onFolderChange,
  modelUsesTools = null,
  commands = [],
  placeholder,
  initialValue = '',
}: Props) {
  // Recherche web et second cerveau : simples préférences (activées par défaut), lues par useChat à chaque envoi.
  const { webSearch, brain } = usePreferences()
  const [value, setValue] = useState(initialValue)
  // Nouveau texte proposé alors que le champ est déjà affiché (ex. fin de l'écran de connexion) :
  // on le pose dans le champ (synchronisé pendant le rendu), puis on y met le curseur (effet plus bas).
  const [lastInitial, setLastInitial] = useState(initialValue)
  if (initialValue !== lastInitial) {
    setLastInitial(initialValue)
    if (initialValue) setValue(initialValue)
  }
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [reading, setReading] = useState(0) // fichiers en cours de lecture
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const motion = useMotion()

  // --- Dictée (appli seulement) : le texte s'écrit en direct là où était le curseur ---------
  // On retient le champ tel qu'il était au début : chaque texte reçu (provisoire puis final)
  // remplace le précédent à cet endroit, et un texte vide (Annuler) remet le champ comme avant.
  const baseRef = useRef<DictationBase | null>(null)
  const cursorRef = useRef<number | null>(null) // où remettre le curseur à la fin
  const dictation = useDictation((text) => {
    if (!baseRef.current) return
    const { value: next, cursor } = spliceDictation(baseRef.current, text)
    cursorRef.current = cursor
    setValue(next)
  })
  const dictating = dictation.phase !== 'idle'

  function startDictation() {
    const el = ref.current
    baseRef.current = { text: value, start: el?.selectionStart ?? value.length, end: el?.selectionEnd ?? value.length }
    void dictation.start()
  }

  // Pendant la dictée, le champ suit le texte qui s'écrit (défile jusqu'en bas).
  useEffect(() => {
    if (dictating && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [value, dictating])

  // Fin de la dictée : le champ revient, avec le curseur juste après le texte dicté.
  useEffect(() => {
    if (dictation.phase !== 'idle' || cursorRef.current === null) return
    const pos = cursorRef.current
    cursorRef.current = null
    ref.current?.focus()
    ref.current?.setSelectionRange(pos, pos)
  }, [dictation.phase])

  // --- Commandes slash ---------------------------------------------------------------
  const menuId = useId()
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false) // Échap : fermé jusqu'à la prochaine frappe
  const [menuPlacement, setMenuPlacement] = useState<'above' | 'below'>('above')
  const [commandError, setCommandError] = useState<string | null>(null)
  const parsed = commands.length ? parseCommand(value) : null
  const current = parsed?.hasArg ? (commands.find((c) => c.name === parsed.name) ?? null) : null
  let menuItems: SlashItem[] = []
  if (parsed && !parsed.hasArg) menuItems = matchCommands(commands, parsed.name).map((command) => ({ kind: 'command', command }))
  else if (current?.suggest && parsed) menuItems = current.suggest(parsed.arg).map((suggestion) => ({ kind: 'arg', command: current, suggestion }))
  const unknown = parsed && !parsed.hasArg && parsed.name && menuItems.length === 0 ? parsed.name : null
  const menuOpen = parsed !== null && !menuClosed && (menuItems.length > 0 || current !== null || unknown !== null)
  const activeIndex = Math.min(menuIndex, Math.max(0, menuItems.length - 1))

  /** Texte modifié (frappe ou choix dans le menu) : le menu se rouvre, l'erreur s'efface. */
  function changeValue(next: string) {
    // Le menu s'ouvre : au-dessus du champ s'il y a la place, sinon en dessous (accueil d'un projet).
    if (next.startsWith('/') && !value.startsWith('/') && formRef.current) {
      setMenuPlacement(formRef.current.getBoundingClientRect().top < 300 ? 'below' : 'above')
    }
    setValue(next)
    setMenuIndex(0)
    setMenuClosed(false)
    setCommandError(null)
  }

  /** Exécute une commande. Les commandes qui envoient un message emportent les pièces jointes. */
  function runCommand(command: SlashCommand, arg: string) {
    if (command.disabled) return setCommandError(command.disabled)
    if (command.sends && reading > 0) return setCommandError('Attends la fin de la lecture des fichiers.')
    const error = command.run(arg, command.sends ? attachments : [])
    if (error) return setCommandError(error)
    setValue('')
    setCommandError(null)
    if (command.sends) {
      setAttachments([])
      setFileError(null)
      pouf()
    }
  }

  /** Choix d'une ligne du menu. complete = Tab : on complète le texte sans rien exécuter. */
  function chooseItem(index: number, complete = false) {
    const item = menuItems[index]
    if (!item) return
    const c = item.command
    if (item.kind === 'command') {
      if (!complete && !c.argHint) runCommand(c, '')
      else changeValue(`/${c.name}${c.argHint ? ' ' : ''}`)
    } else if (!complete && c.argIsChoice) {
      runCommand(c, item.suggestion.value)
    } else {
      changeValue(`/${c.name} ${item.suggestion.value}${c.argIsChoice ? '' : ' '}`)
    }
    ref.current?.focus()
  }

  function moveSelection(delta: number) {
    const n = menuItems.length
    if (!n) return
    const next = (activeIndex + delta + n) % n
    setMenuIndex(next)
    document.getElementById(slashOptionId(menuId, next))?.scrollIntoView({ block: 'nearest' })
  }

  // Le champ grandit avec le texte : on remet la hauteur à « auto », puis on prend la hauteur du contenu.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  useEffect(() => {
    if (!isTouch) ref.current?.focus()
  }, [focusKey])

  // Texte proposé : curseur à la fin, prêt à être modifié ou envoyé.
  useEffect(() => {
    const el = ref.current
    if (!initialValue || !el || isTouch) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [initialValue])

  /** Lit les fichiers choisis (bouton, glisser-déposer ou coller) et les ajoute à la liste. */
  async function addFiles(files: File[]) {
    if (!files.length) return
    setFileError(null)
    const room = MAX_ATTACHMENTS - attachments.length
    if (files.length > room) setFileError(`${MAX_ATTACHMENTS} fichiers maximum par message.`)
    setReading((n) => n + Math.min(files.length, room))
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        const attachment = await readAttachment(file)
        setAttachments((prev) => {
          if (attachment.kind === 'image' && prev.filter((a) => a.kind === 'image').length >= MAX_IMAGES) {
            setFileError(`${MAX_IMAGES} images maximum par message.`)
            return prev
          }
          return [...prev, attachment]
        })
      } catch (e) {
        setFileError(e instanceof AttachmentError ? e.message : `Impossible de lire « ${file.name} ».`)
      } finally {
        setReading((n) => n - 1)
      }
    }
  }

  // Glisser-déposer n'importe où dans la fenêtre (pas seulement sur la zone de saisie).
  // Dans l'appli Tauri, il faut "dragDropEnabled": false (tauri.conf.json), sinon macOS donne
  // les fichiers à Tauri et la page ne reçoit jamais l'événement « drop ».
  const addFilesRef = useRef(addFiles)
  useEffect(() => {
    addFilesRef.current = addFiles
  })
  useEffect(() => {
    let depth = 0 // dragenter/dragleave se déclenchent pour chaque élément survolé : on compte
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
    // Une fenêtre (Paramètres, projet…) est ouverte : on la laisse tranquille.
    const blocked = () => document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e) || blocked()) return
      depth++
      setDragging(true)
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onOver = (e: DragEvent) => {
      if (hasFiles(e) && !blocked()) e.preventDefault() // sans ça, le navigateur ouvrirait le fichier
    }
    const onDrop = (e: DragEvent) => {
      depth = 0
      setDragging(false)
      if (!hasFiles(e) || blocked()) return
      e.preventDefault()
      void addFilesRef.current([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // ⌘U (Ctrl+U ailleurs) : ajouter des fichiers, comme dans l'appli Claude.
  const openFilesRef = useRef(() => {})
  useEffect(() => {
    openFilesRef.current = () => {
      if (attachments.length < MAX_ATTACHMENTS) fileRef.current?.click()
    }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'u') return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      e.preventDefault()
      openFilesRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** Espace Chat : fenêtre « Choisir un dossier » de macOS (chemin vérifié et autorisé côté Rust). */
  async function chooseFolder() {
    setFileError(null)
    try {
      const picked = await pickWorkspace()
      if (picked) onFolderChange?.(picked)
    } catch (e) {
      setFileError((e as Error).message)
    }
  }

  const canSend = (value.trim() !== '' || attachments.length > 0) && reading === 0 && !busy

  /** Petit « pouf » de la zone de saisie à l'envoi (animation ponctuelle, pas besoin de useGSAP). */
  function pouf() {
    if (motion && formRef.current) {
      gsap.fromTo(formRef.current, { scale: 0.98 }, { scale: 1, duration: 0.5, ease: 'elastic.out(1, 0.4)', clearProps: 'transform' })
    }
  }

  function submit() {
    // Commande connue (« /new », « /model auto »…) : exécutée, même pendant une réponse
    // (c'est la commande qui dit si elle peut attendre). Inconnue : envoyée comme un message.
    if (dictating) return
    const command = parsed && commands.find((c) => c.name === parsed.name)
    if (command) return runCommand(command, parsed.arg)
    if (!canSend || isStreaming) return
    onSend(value, attachments)
    setValue('')
    setAttachments([])
    setFileError(null)
    pouf()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (dictating) return // Entrée / Échap gérés par la dictée (voir plus haut)
    if (menuOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (menuItems.length) {
          e.preventDefault()
          moveSelection(e.key === 'ArrowDown' ? 1 : -1)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuClosed(true)
        return
      }
      if (menuItems.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
        e.preventDefault()
        chooseItem(activeIndex, e.key === 'Tab')
        return
      }
    }
    // isComposing : l'utilisateur tape un caractère composé (accents sur certains claviers, japonais…).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch) {
      e.preventDefault()
      submit()
    }
  }

  const imageAttached = attachments.some((a) => a.kind === 'image')

  return (
    <div className="relative flex flex-col gap-2">
      {menuOpen && (
        <SlashMenu
          id={menuId}
          items={menuItems}
          activeIndex={activeIndex}
          current={current}
          unknown={unknown}
          placement={menuPlacement}
          onHover={setMenuIndex}
          onChoose={(i) => chooseItem(i)}
        />
      )}
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className="flex flex-col rounded-3xl border bg-background p-2 shadow-sm transition-colors focus-within:border-ring"
      >
        {agent && <AgentBar agent={agent} />}

        {folder && onFolderChange && (
          <div className="flex px-1 pt-1 pb-2">
            <span
              className="flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border pr-1 pl-2.5 text-xs"
              title={`Dossier en lecture seule : ${folder}\nLe modèle peut le lister, le lire et y chercher (sans rien modifier).`}
            >
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate font-medium">{folderName(folder)}</span>
              <span className="shrink-0 text-muted-foreground">· lecture seule</span>
              <button
                type="button"
                onClick={() => onFolderChange(null)}
                disabled={isStreaming}
                aria-label={`Retirer le dossier « ${folderName(folder)} »`}
                title="Retirer le dossier"
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          </div>
        )}

        {(attachments.length > 0 || reading > 0) && (
          <ul aria-label="Fichiers joints" className="flex flex-wrap gap-2 px-1 pt-1 pb-2">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} onRemove={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))} />
            ))}
            {reading > 0 && (
              <li className="flex h-14 w-14 animate-pulse items-center justify-center rounded-xl bg-muted" aria-label="Lecture du fichier" />
            )}
          </ul>
        )}

        {/* Pendant la dictée, le champ reste visible (le texte s'y écrit en direct) mais en lecture seule. */}
        <div className="flex items-end gap-1">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])])
              e.target.value = '' // pour pouvoir rechoisir le même fichier
            }}
          />
          {/* Bouton « + » : un petit menu, comme dans l'appli Claude (fichiers, dossier). */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  disabled={dictating}
                  aria-label="Ajouter des fichiers, options"
                  title="Ajouter des fichiers, options"
                  className="rounded-full text-muted-foreground data-[popup-open]:bg-muted"
                />
              }
            >
              <Plus className="size-5" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-auto min-w-64 whitespace-nowrap">
              <DropdownMenuItem disabled={attachments.length >= MAX_ATTACHMENTS} onClick={() => fileRef.current?.click()}>
                <Paperclip aria-hidden />
                Ajouter des fichiers ou des photos
                <DropdownMenuShortcut>⌘U</DropdownMenuShortcut>
              </DropdownMenuItem>
              {onFolderChange && (
                <DropdownMenuItem disabled={!IS_TAURI || isStreaming} onClick={() => void chooseFolder()}>
                  <FolderOpen aria-hidden />
                  {folder ? 'Changer de dossier' : 'Ajouter un dossier'}
                  <DropdownMenuShortcut>{IS_TAURI ? 'lecture seule' : 'appli Aery'}</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {/* Le menu reste ouvert quand on bascule l'option, pour voir le changement. */}
              <DropdownMenuCheckboxItem
                checked={webSearch}
                onCheckedChange={(checked) => setPreferences({ webSearch: checked })}
                closeOnClick={false}
                className="pr-1.5 [&_[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
              >
                <Globe aria-hidden />
                Recherche web
                {webSearch && modelUsesTools === false && (
                  <span className="ml-auto pl-4 text-xs text-muted-foreground">pas avec ce modèle</span>
                )}
                <SwitchLook on={webSearch} className={cn(!(webSearch && modelUsesTools === false) && 'ml-auto')} />
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={brain}
                onCheckedChange={(checked) => setPreferences({ brain: checked })}
                closeOnClick={false}
                className="pr-1.5 [&_[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
              >
                <Brain aria-hidden />
                Second cerveau
                {brain && modelUsesTools === false && (
                  <span className="ml-auto pl-4 text-xs text-muted-foreground">pas avec ce modèle</span>
                )}
                <SwitchLook on={brain} className={cn(!(brain && modelUsesTools === false) && 'ml-auto')} />
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => changeValue(e.target.value)}
            readOnly={dictating}
            onKeyDown={handleKeyDown}
            onBlur={() => setMenuClosed(true)}
            onFocus={() => setMenuClosed(false)}
            onPaste={(e) => {
              // Une capture d'écran collée (Cmd+V) devient une pièce jointe.
              const files = [...e.clipboardData.files]
              if (files.length) {
                e.preventDefault()
                void addFiles(files)
              }
            }}
            rows={1}
            placeholder={dictating ? 'Parle, le texte s’écrit ici…' : placeholder ?? (agent ? 'Demande quelque chose à l’agent…' : commands.length ? 'Écris ton message, ou / pour les commandes…' : 'Écris ton message…')}
            aria-label="Message"
            {...(commands.length > 0 && {
              role: 'combobox',
              'aria-autocomplete': 'list' as const,
              'aria-expanded': menuOpen,
              'aria-controls': menuOpen && menuItems.length ? menuId : undefined,
              'aria-activedescendant': menuOpen && menuItems.length ? slashOptionId(menuId, activeIndex) : undefined,
            })}
            className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 leading-6 outline-none placeholder:text-muted-foreground"
          />
          {CAN_DICTATE && !dictating && (
            <IconButton
              label="Dicter (transcrit sur ton Mac)"
              side="top"
              type="button"
              onClick={startDictation}
              size="icon-lg"
              className="rounded-full text-muted-foreground"
            >
              <Mic className="size-5" aria-hidden />
            </IconButton>
          )}
          {dictating ? null : isStreaming ? (
            <IconButton label="Arrêter la réponse" side="top" type="button" onClick={onStop} variant="default" size="icon-lg" className="rounded-full">
              <Square className="size-3.5 fill-current" aria-hidden />
            </IconButton>
          ) : (
            <IconButton
              label={busy ? 'Une réponse est en cours dans une autre conversation' : reading > 0 ? 'Lecture des fichiers…' : 'Envoyer'}
              side="top"
              type="submit"
              disabled={!canSend}
              variant="default"
              size="icon-lg"
              className="rounded-full"
            >
              <ArrowUp className="size-5" aria-hidden />
            </IconButton>
          )}
        </div>
        {dictating && <DictationControls dictation={dictation} className="mt-1 border-t pt-2" />}
      </form>

      {/* Voile affiché pendant qu'on fait glisser des fichiers au-dessus de la fenêtre. */}
      {dragging &&
        createPortal(
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm">
            <Appear
              from={{ autoAlpha: 0, scale: 0.94, ease: 'back.out(1.7)' }}
              className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-primary/60 bg-background px-12 py-10 text-center shadow-lg"
            >
              <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Upload className="size-6" aria-hidden />
              </span>
              <p className="font-medium">Dépose tes fichiers ici</p>
              <p className="text-sm text-muted-foreground">Images ou fichiers texte (code, Markdown, CSV…)</p>
            </Appear>
          </div>,
          document.body,
        )}

      {commandError && (
        <p role="alert" className="flex items-center gap-1.5 px-3 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {commandError}
        </p>
      )}
      <DictationNotices dictation={dictation} className="px-3" />
      {fileError && (
        <p role="alert" className="flex items-center gap-1.5 px-3 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {fileError}
        </p>
      )}
      {imageAttached && modelReadsImages === false && (
        <p role="status" className="flex items-center gap-1.5 px-3 text-xs text-muted-foreground">
          <Eye className="size-3.5 shrink-0" aria-hidden />
          Ce modèle ne lit pas les images : Auto choisira un modèle vision pour ce message.
        </p>
      )}
    </div>
  )
}

/** Petit interrupteur décoratif (l'état est porté par l'élément du menu, role="menuitemcheckbox"). */
function SwitchLook({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'ml-4 inline-flex h-[18px] w-8 shrink-0 items-center rounded-full p-0.5 transition-colors',
        on ? 'bg-primary' : 'bg-input dark:bg-input/80',
        className,
      )}
    >
      <span
        className={cn(
          'size-3.5 rounded-full bg-background shadow-sm transition-transform',
          on && 'translate-x-3.5',
        )}
      />
    </span>
  )
}

/** Espace Code : rappel en lecture seule de ce que l'agent peut faire (le dossier se change dans le projet). */
function AgentBar({ agent }: { agent: AgentSettings }) {
  const chip = 'flex h-7 min-w-0 items-center gap-1.5 rounded-full border px-2.5 text-xs'
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pt-1 pb-2">
      <span className={cn(chip, 'border-primary/30 bg-primary/10 font-medium text-primary')}>
        <Bot className="size-3.5" aria-hidden />
        Agent
      </span>
      {!IS_TAURI ? (
        <span className={cn(chip, 'text-muted-foreground')} title="La lecture de fichiers passe par la partie Rust de l’appli Aery.">
          JavaScript seulement · fichiers dans l’appli Aery
        </span>
      ) : agent.workspace ? (
        <span className={chip} title={`Dossier lu par l’agent : ${agent.workspace}`}>
          <FolderCode className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium">{folderName(agent.workspace)}</span>
        </span>
      ) : (
        <span className={cn(chip, 'text-muted-foreground')}>Aucun dossier : choisis-en un dans les réglages du projet</span>
      )}
    </div>
  )
}

function AttachmentChip({ attachment: a, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  return (
    <li className="group/chip relative">
      {a.kind === 'image' ? (
        <img src={a.dataUrl} alt={a.name} title={a.name} className="size-14 rounded-xl border object-cover" />
      ) : (
        <div className="flex h-14 max-w-56 items-center gap-2 rounded-xl border bg-muted/40 pr-3 pl-2" title={a.name}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText className="size-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{a.name}</span>
            <span className="block text-xs text-muted-foreground">{formatSize(a.size)}</span>
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Retirer « ${a.name} »`}
        title="Retirer"
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <X className="size-3" aria-hidden />
      </button>
    </li>
  )
}
