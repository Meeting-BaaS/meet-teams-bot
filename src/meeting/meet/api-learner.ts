/**
 * API Auto-Learner for Google Meet
 * 
 * This module provides a Playwright-based interface to automatically learn
 * API calls by observing network requests during UI interactions.
 * 
 * Usage:
 * ```typescript
 * const learner = new MeetAPILearner(page)
 * await learner.startSession('typing_bot_name')
 * 
 * const action = await learner.recordAction('type', {
 *   selector: 'input[name="name"]',
 *   value: 'Bot Name'
 * })
 * 
 * await page.type('input[name="name"]', 'Bot Name')
 * await learner.waitForRequests(action.id)
 * 
 * const requests = await learner.getActionRequests(action.id)
 * const session = await learner.endSession()
 * ```
 */

import { Page } from 'playwright'

export interface ActionData {
    selector?: string
    value?: string
    text?: string
    coordinates?: { x: number; y: number }
    [key: string]: any
}

export interface LearnedRequest {
    id: number
    type: 'fetch' | 'xhr'
    url: string
    method: string
    headers: Record<string, string>
    body: any
    timestamp: number
    uiContext: string | null
    isMeetRequest: boolean
    status: number
    responseBody: any
}

export interface LearnedAction {
    id: number
    type: string
    data: ActionData
    timestamp: number
    requestCountBefore: number
}

export interface LearningSession {
    name: string
    duration: number
    actions: LearnedAction[]
    requests: LearnedRequest[]
    summary: {
        totalActions: number
        totalRequests: number
        meetRequests: number
    }
}

export interface ActionPattern {
    action: LearnedAction
    requests: LearnedRequest[]
    meetRequests: LearnedRequest[]
    pattern: {
        actionType: string
        requestCount: number
        meetRequestCount: number
        methods: string[]
        urls: string[]
        meetUrls: string[]
    }
}

export class MeetAPILearner {
    private page: Page
    private sessionActive = false

    constructor(page: Page) {
        this.page = page
    }

    /**
     * Ensure the API learner is available in the page
     */
    private async ensureLearnerAvailable(): Promise<boolean> {
        try {
            const available = await this.page.evaluate(() => {
                return typeof (window as any).__apiLearner !== 'undefined'
            })

            if (!available) {
                console.warn(
                    '[API Learner] ⚠️ API Learner not found. Make sure the extension is loaded.',
                )
                return false
            }

            return true
        } catch (e) {
            console.error('[API Learner] ❌ Error checking availability:', e)
            return false
        }
    }

    /**
     * Start a new learning session
     */
    async startSession(sessionName: string): Promise<boolean> {
        if (!(await this.ensureLearnerAvailable())) {
            return false
        }

        try {
            const result = await this.page.evaluate(
                (name) => {
                    if ((window as any).__apiLearner) {
                        return (window as any).__apiLearner.startSession(name)
                    }
                    return { success: false, error: 'API Learner not found' }
                },
                sessionName,
            )

            if (result.success) {
                this.sessionActive = true
                console.log(
                    `[API Learner] 🎯 Started session: "${sessionName}"`,
                )
                return true
            } else {
                console.error(
                    `[API Learner] ❌ Failed to start session: ${result.error}`,
                )
                return false
            }
        } catch (e) {
            console.error('[API Learner] ❌ Error starting session:', e)
            return false
        }
    }

    /**
     * Record an action before performing it
     */
    async recordAction(
        actionType: string,
        actionData: ActionData,
    ): Promise<{ success: boolean; actionId?: number; error?: string }> {
        if (!this.sessionActive) {
            return { success: false, error: 'No active session' }
        }

        try {
            const result = await this.page.evaluate(
                ({ type, data }) => {
                    if ((window as any).__apiLearner) {
                        return (window as any).__apiLearner.recordAction(
                            type,
                            data,
                        )
                    }
                    return { success: false, error: 'API Learner not found' }
                },
                { type: actionType, data: actionData },
            )

            return result
        } catch (e) {
            console.error('[API Learner] ❌ Error recording action:', e)
            return { success: false, error: String(e) }
        }
    }

    /**
     * Wait for network requests to settle after an action
     */
    async waitForRequests(
        actionId: number,
        timeout = 3000,
    ): Promise<{ success: boolean; duration?: number; totalRequests?: number }> {
        if (!this.sessionActive) {
            return { success: false }
        }

        try {
            const result = await this.page.evaluate(
                ({ id, timeout }) => {
                    if ((window as any).__apiLearner) {
                        return (window as any).__apiLearner.waitForRequests(
                            id,
                            timeout,
                        )
                    }
                    return { success: false, error: 'API Learner not found' }
                },
                { id: actionId, timeout },
            )

            return result
        } catch (e) {
            console.error('[API Learner] ❌ Error waiting for requests:', e)
            return { success: false }
        }
    }

    /**
     * Get requests associated with a specific action
     */
    async getActionRequests(actionId: number): Promise<{
        success: boolean
        action?: LearnedAction
        requests?: LearnedRequest[]
        meetRequests?: LearnedRequest[]
    }> {
        if (!this.sessionActive) {
            return { success: false }
        }

        try {
            const result = await this.page.evaluate(
                (id) => {
                    if ((window as any).__apiLearner) {
                        return (window as any).__apiLearner.getActionRequests(id)
                    }
                    return { success: false, error: 'API Learner not found' }
                },
                actionId,
            )

            return result
        } catch (e) {
            console.error('[API Learner] ❌ Error getting action requests:', e)
            return { success: false }
        }
    }

    /**
     * End the current session and return learned data
     */
    async endSession(): Promise<LearningSession | null> {
        if (!this.sessionActive) {
            return null
        }

        try {
            const result = await this.page.evaluate(() => {
                if ((window as any).__apiLearner) {
                    return (window as any).__apiLearner.endSession()
                }
                return { success: false, error: 'API Learner not found' }
            })

            if (result.success && result.data) {
                this.sessionActive = false
                console.log(
                    `[API Learner] ✅ Session ended: ${result.data.summary.totalActions} actions, ${result.data.summary.totalRequests} requests`,
                )
                return result.data as LearningSession
            }

            return null
        } catch (e) {
            console.error('[API Learner] ❌ Error ending session:', e)
            this.sessionActive = false
            return null
        }
    }

    /**
     * Analyze learned patterns
     */
    async analyze(): Promise<{
        success: boolean
        patterns?: ActionPattern[]
        summary?: { totalPatterns: number; patternsWithMeetRequests: number }
    }> {
        if (!this.sessionActive) {
            return { success: false }
        }

        try {
            const result = await this.page.evaluate(() => {
                if ((window as any).__apiLearner) {
                    return (window as any).__apiLearner.analyze()
                }
                return { success: false, error: 'API Learner not found' }
            })

            return result
        } catch (e) {
            console.error('[API Learner] ❌ Error analyzing:', e)
            return { success: false }
        }
    }

    /**
     * Get current session status
     */
    async getStatus(): Promise<{
        active: boolean
        session?: {
            name: string
            duration: number
            actions: number
            requests: number
        }
    }> {
        try {
            const result = await this.page.evaluate(() => {
                if ((window as any).__apiLearner) {
                    return (window as any).__apiLearner.getStatus()
                }
                return { active: false }
            })

            this.sessionActive = result.active
            return result
        } catch (e) {
            console.error('[API Learner] ❌ Error getting status:', e)
            return { active: false }
        }
    }

    /**
     * Helper: Perform an action and automatically learn its API calls
     */
    async learnAction(
        actionType: 'type' | 'click' | 'focus' | 'submit',
        selector: string,
        value?: string,
    ): Promise<{
        actionId: number
        requests: LearnedRequest[]
        meetRequests: LearnedRequest[]
    }> {
        // Record the action
        const action = await this.recordAction(actionType, {
            selector,
            value,
        })

        if (!action.success || !action.actionId) {
            throw new Error('Failed to record action')
        }

        // Perform the actual UI action
        switch (actionType) {
            case 'type':
                if (value) {
                    await this.page.type(selector, value)
                }
                break
            case 'click':
                await this.page.click(selector)
                break
            case 'focus':
                await this.page.focus(selector)
                break
            case 'submit':
                await this.page.locator(selector).press('Enter')
                break
        }

        // Wait for requests to settle
        await this.waitForRequests(action.actionId)

        // Get the associated requests
        const requests = await this.getActionRequests(action.actionId)

        if (!requests.success || !requests.requests) {
            throw new Error('Failed to get action requests')
        }

        return {
            actionId: action.actionId,
            requests: requests.requests,
            meetRequests: requests.meetRequests || [],
        }
    }
}

