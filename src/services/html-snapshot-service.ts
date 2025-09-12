import { Page } from '@playwright/test'
import * as fs from 'fs/promises'
import * as path from 'path'
import { PathManager } from '../utils/PathManager'

export interface HtmlSnapshotResult {
    success: boolean
}

const SNAPSHOT_TIMEOUT = 10000

export class HtmlSnapshotService {
    private static instance: HtmlSnapshotService
    private pathManager: PathManager

    private constructor() {
        this.pathManager = PathManager.getInstance()
    }

    public static getInstance(): HtmlSnapshotService {
        if (!HtmlSnapshotService.instance) {
            HtmlSnapshotService.instance = new HtmlSnapshotService()
        }
        return HtmlSnapshotService.instance
    }

    /**
     * Capture HTML snapshot before DOM manipulation
     */
    public async captureSnapshot(
        page: Page,
        context: string,
    ): Promise<HtmlSnapshotResult> {
        // Ensure the snapshot promise cannot cause unhandled rejections if it loses the race
        const snapshotPromise = this.performSnapshot(page, context).catch(
            (error) => {
                console.error(
                    `[HtmlSnapshot] Snapshot error for ${context}:`,
                    error?.message ?? error,
                )
                return { success: false }
            },
        )

        // Create cancellable timeout to avoid warnings when snapshot succeeds
        let timeoutId: NodeJS.Timeout
        const timeoutPromise = new Promise<HtmlSnapshotResult>((resolve) => {
            timeoutId = setTimeout(() => {
                console.warn(
                    `[HtmlSnapshot] Snapshot operation timeout after ${SNAPSHOT_TIMEOUT / 1000}s for ${context}`,
                )
                resolve({ success: false })
            }, SNAPSHOT_TIMEOUT)
        })

        // Race the promises and clear timeout when done
        const result = await Promise.race([snapshotPromise, timeoutPromise])
        clearTimeout(timeoutId) // Cancel timeout regardless of which promise won
        return result
    }

    /**
     * Internal method to perform the actual snapshot operation
     */
    private async performSnapshot(
        page: Page,
        context: string,
    ): Promise<HtmlSnapshotResult> {
        // Check if page is still valid
        if (page.isClosed()) {
            console.warn(
                '[HtmlSnapshot] Cannot capture snapshot: page is closed',
            )
            return {
                success: false,
            }
        }

        // Additional page state checks
        try {
            await page.waitForFunction(
                () =>
                    document.readyState === 'complete' ||
                    document.readyState === 'interactive',
                undefined,
                { timeout: 1000 },
            )
        } catch (evalError) {
            console.warn(
                `[HtmlSnapshot] Page not responsive for ${context}, skipping snapshot`,
            )
            return { success: false }
        }

        console.log(`[HtmlSnapshot] Capturing snapshot for ${context}`)

        // Capture HTML content
        const html = await page.content()

        // Generate filename
        const filename = this.generateFilename(context)
        const filePath = path.join(
            this.pathManager.getHtmlSnapshotsPath(),
            filename,
        )

        // Ensure directory exists
        await fs.mkdir(path.dirname(filePath), { recursive: true })

        // Save HTML file
        await fs.writeFile(filePath, html, 'utf-8')

        console.log(`[HtmlSnapshot] Captured snapshot: ${filename}`)

        return {
            success: true,
        }
    }

    /**
     * Generate filename for snapshot
     */
    private generateFilename(context: string): string {
        const timestamp = Date.now()
        const safeContext = context.replace(/[^\w.-]+/g, '_').slice(0, 100)
        return `${timestamp}_${safeContext}.html`
    }
}
