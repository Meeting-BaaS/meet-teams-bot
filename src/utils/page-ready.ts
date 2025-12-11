import type { Page } from '@playwright/test'

// Default timeout for page ready state (non-critical operations)
export const PAGE_READY_TIMEOUT = 5000

// Default timeout for critical page ready checks (operations that must succeed)
export const CRITICAL_PAGE_READY_TIMEOUT = 20000

export type ReadyState = 'loading' | 'interactive' | 'complete'

export interface WaitForPageReadyOptions {
    /**
     * Timeout in milliseconds (default: PAGE_READY_TIMEOUT)
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
        timeout = PAGE_READY_TIMEOUT,
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

        // Capture the actual readyState reached for more informative logging
        const finalState = await page.evaluate(
            () => document.readyState as ReadyState,
        )

        if (context) {
            console.log(
                `✅ Page ready${context ? ` (${context})` : ''} - readyState: ${finalState}`,
            )
        }

        return true
    } catch (error) {
        // Distinguish timeout errors from other failures (navigation, closure, etc.)
        const isTimeout =
            error instanceof Error && error.name === 'TimeoutError'
        const baseMessage = `Page readyState check ${
            isTimeout ? 'timeout' : 'failure'
        }${context ? ` (${context})` : ''}`

        if (throwOnTimeout) {
            // Preserve original error for non-timeout failures to aid debugging
            throw isTimeout
                ? new Error(`${baseMessage} after ${timeout}ms`)
                : error
        }

        console.warn(
            isTimeout
                ? `${baseMessage} after ${timeout}ms`
                : `${baseMessage}: ${String(error)}`,
        )
        return false
    }
}

export interface EnsurePageReadyOptions {
    /**
     * Timeout in milliseconds (default: CRITICAL_PAGE_READY_TIMEOUT)
     */
    timeout?: number
    /**
     * Optional context string for logging
     */
    context?: string
}

/**
 * Convenience function to wait for page to be complete (strict check)
 * Throws on timeout - use for critical operations
 *
 * @example
 * // Use default timeout
 * await ensurePageReady(page, { context: 'loading meeting page' })
 *
 * @example
 * // Custom timeout
 * await ensurePageReady(page, { timeout: 30000, context: 'critical operation' })
 */
export async function ensurePageReady(
    page: Page,
    {
        timeout = CRITICAL_PAGE_READY_TIMEOUT,
        context,
    }: EnsurePageReadyOptions = {},
): Promise<void> {
    await waitForPageReady(page, {
        acceptStates: ['complete'],
        timeout,
        throwOnTimeout: true,
        context,
    })
}
