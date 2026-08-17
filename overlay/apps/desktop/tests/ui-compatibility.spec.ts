import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_UI_COMPATIBILITY_CSS,
  installDesktopUiCompatibility,
} from '../src/ui-compatibility.ts'

describe('desktop Web UI compatibility styles', () => {
  it('neutralizes the git graph dock negative margin that overlaps the composer', () => {
    expect(DESKTOP_UI_COMPATIBILITY_CSS).toContain('[data-gitgraph-chip-anchor]')
    expect(DESKTOP_UI_COMPATIBILITY_CSS).toContain('margin-bottom: 0 !important')
  })

  it('reapplies the compatibility stylesheet after every page load', async () => {
    let didFinishLoad: (() => void) | undefined
    const insertCSS = vi.fn(async () => 'compatibility-style')
    const webContents = {
      insertCSS,
      on: vi.fn((event: string, listener: () => void) => {
        expect(event).toBe('did-finish-load')
        didFinishLoad = listener
        return webContents
      }),
    } as unknown as Pick<WebContents, 'insertCSS' | 'on'>

    installDesktopUiCompatibility(webContents)
    expect(didFinishLoad).toBeTypeOf('function')

    didFinishLoad?.()
    await Promise.resolve()

    expect(insertCSS).toHaveBeenCalledWith(DESKTOP_UI_COMPATIBILITY_CSS)
  })
})
