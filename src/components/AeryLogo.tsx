import type { SVGProps } from 'react'

/**
 * Le symbole d'Aery (« Souffle ») seul, sans le fond de l'icône d'appli.
 * Même tracé que src-tauri/app-icon.svg. Il prend la couleur du texte (currentColor)
 * et sa taille via className, comme une icône lucide.
 */
export function AeryLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="13 15 92 92" fill="none" {...props}>
      <path
        d="M24 88 C24 52 46 34 72 34 A22 22 0 0 1 72 78 A11 11 0 0 1 61 67"
        stroke="currentColor"
        strokeWidth="15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
