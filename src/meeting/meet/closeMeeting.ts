import type { Page } from "@playwright/test"

export async function closeMeeting(page: Page): Promise<void> {
  console.log("Attempting to close meeting...")

  // Add a timeout to ensure the function completes
  const closePromise = async () => {
    try {
      // Raccourcis clavier en premier - très rapide, sans attente excessive
      await page.keyboard.press("Control+w")
      await page.waitForTimeout(100)
      await page.keyboard.press("Meta+w")
      await page.waitForTimeout(100)

      // Sélecteurs les plus courants pour quitter rapidement
      const quickExitSelectors = [
        'button:has-text("Leave")',
        'button[aria-label="Leave call"]',
        'div[jsname="CQylAd"][aria-label="Leave call"]'
      ]

      // Essayer chaque sélecteur rapidement
      for (const selector of quickExitSelectors) {
        try {
          const button = page.locator(selector).first()
          const count = await button.count()
          if (count > 0) {
            await button.click({ timeout: 300, force: true })
            break
          }
        } catch (_e) {}
      }

      // Tentative supplémentaire avec l'icône - sans attente
      try {
        const iconButton = page.locator('button span[jsname="S5tZuc"] i:has-text("call_end")')
        const count = await iconButton.count()
        if (count > 0) {
          await iconButton.click({ force: true, timeout: 300 })
        }
      } catch (_e) {
        // Ignore, continue
      }

      // Confirmation finale rapide
      try {
        const leaveButton = page
          .locator('button:has-text("Leave"), button:has-text("Exit"), button:has-text("Quit")')
          .first()
        const count = await leaveButton.count()
        if (count > 0) {
          await leaveButton.click({ timeout: 300, force: true })
        }
      } catch (_e) {
        // Ignore
      }

      // Dernier recours ultra-rapide : naviguer ailleurs sans attente
      try {
        await page.goto("about:blank", { timeout: 1000 })
      } catch (_e) {
        // Probablement déjà fermé, ignoré
      }

      console.log("Meeting close sequence completed")
    } catch (error) {
      console.error("Error during meeting closure:", error)
    }
  }

  // Ensure the function doesn't hang for more than 3 seconds
  try {
    await Promise.race([
      closePromise(),
      new Promise((_, reject) =>
        setTimeout(() => {
          console.log("Meeting close timed out, but this is normal if the bot was removed")
          reject(new Error("Meeting close timeout"))
        }, 3000)
      )
    ])
  } catch (_error) {
    // Even timeout errors are expected and not critical
    console.log("Meeting close did not complete normally, but continuing")
  }
}
