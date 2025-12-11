import { Page } from '@playwright/test'

export type ReadyState = 'loading' | 'interactive' | 'complete'

export interface WaitForPageReadyOptions {
    /**
     * Timeout in milliseconds (default: 5000)
     */
    timeout?: number
    /**
     * Which readyState values to accept (default: ['complete', 'interactive'])
     */
    acceptStates?: ReadyState[]
    /**
     * Whether to throw on timeout (default: false - returns false instead)
     */
    throwOnTimeout?: boolean
    /**
     * Optional context string for logging
     */
    context?: string
}

/**
 * Generic utility to wait for page readyState to reach a desired state
 *
 * @param page - Playwright page instance
 * @param options - Configuration options
 * @returns true if page reached desired state, false if timeout (unless throwOnTimeout is true)
 * @throws Error if throwOnTimeout is true and timeout occurs
 *
 * @example
 * // Wait for page to be complete or interactive (default)
 * const ready = await waitForPageReady(page)
 *
 * @example
 * // Wait only for complete state with custom timeout
 * const ready = await waitForPageReady(page, {
 *   acceptStates: ['complete'],
 *   timeout: 10000
 * })
 *
 * @example
 * // Throw on timeout (for critical operations)
 * await waitForPageReady(page, {
 *   throwOnTimeout: true,
 *   context: 'joining meeting'
 * })
 */
export async function waitForPageReady(
    page: Page,
    options: WaitForPageReadyOptions = {},
): Promise<boolean> {
    const {
        timeout = 5000,
        acceptStates = ['complete', 'interactive'],
        throwOnTimeout = false,
        context,
    } = options

    // Validate page is still open
    if (page.isClosed()) {
        const error = new Error(
            `Page is closed${context ? ` (${context})` : ''}`,
        )
        if (throwOnTimeout) {
            throw error
        }
        return false
    }

    try {
        await page.waitForFunction(
            (states: ReadyState[]) => {
                return states.includes(document.readyState as ReadyState)
            },
            acceptStates,
            { timeout },
        )

        if (context) {
            console.log(
                `✅ Page ready${context ? ` (${context})` : ''} - readyState: ${acceptStates.join(' or ')}`,
            )
        }

        return true
    } catch (error) {
        const errorMessage = `Page readyState check timeout after ${timeout}ms${context ? ` (${context})` : ''}`

        if (throwOnTimeout) {
            throw new Error(errorMessage)
        }

        console.warn(errorMessage)
        return false
    }
}

/**
 * Convenience function to wait for page to be complete (strict check)
 * Throws on timeout - use for critical operations
 */
export async function ensurePageReady(
    page: Page,
    timeout: number = 20000,
    context?: string,
): Promise<void> {
    await waitForPageReady(page, {
        acceptStates: ['complete'],
        timeout,
        throwOnTimeout: true,
        context,
    })
}
