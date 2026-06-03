import type { Page } from "@playwright/test"

// cloakbrowser saves original page methods at page._original before patching.
type CloakOriginals = {
  click?: Function;
  dblclick?: Function;
  hover?: Function;
  type?: Function;
  fill?: Function;
  check?: Function;
  uncheck?: Function;
  selectOption?: Function
  press?: Function;
  goto?: Function;
  isChecked?: Function
  mouseMove?: Function;
  mouseClick?: Function;
  mouseDblclick?: Function;
  mouseWheel?: Function;
  mouseDown?: Function;
  mouseUp?: Function;
  keyboardType?: Function;
  keyboardDown?: Function;
  keyboardUp?: Function;
  keyboardPress?: Function;
  keyboardInsertText?: Function;
}

const HUMANIZED_METHODS = [
  "click", "dblclick", "hover", "type", "fill", "check", "uncheck",
  "selectOption", "press", "pressSequentially", "tap", "clear",
  "goto", "isChecked", "dragAndDrop"
] as const

/**
 * Strip cloakbrowser's humanize patches from a page and all its frames.
 *
 * cloakbrowser patches page methods at launch (stored in page._original) and
 * frame methods as own properties (marked with frame._humanPatched). Locator-
 * based calls (locator.click() etc.) route through frame.click, so both layers
 * must be restored to get native Playwright speed.
 *
 * Call once the bot is confirmed in the meeting — humanize is only needed
 * during the join flow for bot-detection purposes.
 *
 * No-op if the page was not humanized.
 */
export function dehumanize(page: Page): void {
  const humanizedPatch = page as unknown as { _original?: CloakOriginals } & Record<string, unknown>
  const originalPatch = humanizedPatch._original
  if (!originalPatch) {
    console.log("[Humanize] Page was not humanized, nothing to restore")
    return
  }

  // Page-level methods — restore from stored originals
  const p = page as unknown as Record<string, unknown>
  if (originalPatch.click) p.click = originalPatch.click
  if (originalPatch.dblclick) p.dblclick = originalPatch.dblclick
  if (originalPatch.hover) p.hover = originalPatch.hover
  if (originalPatch.type) p.type = originalPatch.type
  if (originalPatch.fill) p.fill = originalPatch.fill
  if (originalPatch.check) p.check = originalPatch.check
  if (originalPatch.uncheck) p.uncheck = originalPatch.uncheck
  if (originalPatch.selectOption) p.selectOption = originalPatch.selectOption
  if (originalPatch.press) p.press = originalPatch.press
  if (originalPatch.goto) p.goto = originalPatch.goto
  if (originalPatch.isChecked) p.isChecked = originalPatch.isChecked

  const mouse = page.mouse as unknown as Record<string, unknown>
  if (originalPatch.mouseMove) mouse.move = originalPatch.mouseMove
  if (originalPatch.mouseClick) mouse.click = originalPatch.mouseClick
  if (originalPatch.mouseDblclick) mouse.dblclick = originalPatch.mouseDblclick
  if (originalPatch.mouseWheel) mouse.wheel = originalPatch.mouseWheel
  if (originalPatch.mouseDown) mouse.down = originalPatch.mouseDown
  if (originalPatch.mouseUp) mouse.up = originalPatch.mouseUp

  const keyboard = page.keyboard as unknown as Record<string, unknown>
  if (originalPatch.keyboardType) keyboard.type = originalPatch.keyboardType
  if (originalPatch.keyboardDown) keyboard.down = originalPatch.keyboardDown
  if (originalPatch.keyboardUp) keyboard.up = originalPatch.keyboardUp
  if (originalPatch.keyboardPress) keyboard.press = originalPatch.keyboardPress
  if (originalPatch.keyboardInsertText) keyboard.insertText = originalPatch.keyboardInsertText

  delete humanizedPatch._original

  // Frame-level methods — patchFrames patches as own properties marked with
  // _humanPatched. Deleting them exposes the Playwright prototype originals.
  for (const frame of page.frames()) {
    const f = frame as unknown as Record<string, unknown>
    if (!f._humanPatched) continue
    for (const method of HUMANIZED_METHODS) {
      if (Object.prototype.hasOwnProperty.call(f, method)) {
        delete f[method]
      }
    }
    delete f._humanPatched
  }

  console.log("[Humanize] ✅ Dehumanized — native Playwright methods restored (page + frames)")
}
