/** Use the current, unoccluded layout window, not screen size or the visual
 * viewport shortened by a keyboard. Ordinary iPhone landscape is wide but
 * remains short; folding or Split View must withdraw expanded-only behavior. */
export function expandedIphoneWindow(platform: string, userAgent: string, width: number, height: number) {
  return platform === 'ios' && /\biPhone\b/.test(userAgent)
    && Number.isFinite(width) && Number.isFinite(height) && Math.min(width, height) >= 600;
}
