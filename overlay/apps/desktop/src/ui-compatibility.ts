import type { WebContents } from 'electron'

/**
 * Desktop-only CSS guards for third-party Web UI plugins.
 *
 * The git graph plugin currently tightens its dock row with a negative bottom
 * margin. In the desktop shell that moves the branch chip into the composer
 * border, especially at fractional Windows display scaling. The data
 * attribute is the plugin's stable public marker; neutralizing the margin
 * leaves the host-owned composer gap in charge of vertical spacing.
 */
export const DESKTOP_UI_COMPATIBILITY_CSS = `
[data-gitgraph-chip-anchor] {
  margin-bottom: 0 !important;
}
`

/** Reapply compatibility CSS after navigation and user-triggered reloads. */
export function installDesktopUiCompatibility(webContents: Pick<WebContents, 'insertCSS' | 'on'>): void {
  webContents.on('did-finish-load', () => {
    void webContents.insertCSS(DESKTOP_UI_COMPATIBILITY_CSS)
  })
}
