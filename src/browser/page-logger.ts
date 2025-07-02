import { Page } from '@playwright/test'
import { DEBUG_LOGS } from '../main'

const formatValue = (value: any): string => {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value, null, 2)
        } catch (e) {
            return String(value)
        }
    }
    return String(value)
}

export function listenPage(page: Page) {
    page.on('console', async (message) => {
        try {
            const text = message.text()
            const location = message.location()

            // Only show DEBUG logs when --debug flag is used
            const isDebugLog = text.includes('DEBUG')

            if (!DEBUG_LOGS || !isDebugLog) {
                return // Skip all logs unless --debug is enabled and log contains DEBUG
            }

            const args = await Promise.all(
                message.args().map(async (arg) => {
                    try {
                        const value = await arg.jsonValue()
                        return formatValue(value)
                    } catch {
                        return 'Unable to serialize value'
                    }
                }),
            )

            const type = message.type().substr(0, 3).toUpperCase()
            const tags = `${location.url}:${location.lineNumber}`
            const formattedText = args.length === 1 ? args[0] : args.join(' ')

            switch (type) {
                case 'LOG':
                    console.log(`${tags}\n${formattedText}`)
                    break
                case 'WAR':
                    console.log(
                        '\x1b[38;5;214m%s\x1b[0m',
                        `${tags}\n${formattedText}`,
                    )
                    break
                case 'ERR':
                    console.log(
                        '\x1b[31m%s\x1b[0m',
                        `${tags}\n${formattedText}`,
                    )
                    break
                case 'INF':
                    console.log(
                        '\x1b[32m%s\x1b[0m',
                        `${tags}\n${formattedText}`,
                    )
                    break
                default:
                    console.log(
                        `DEFAULT CASE ${type} ! ${tags}\n${formattedText}`,
                    )
            }
        } catch (e) {
            console.log(`Failed to log forward logs: ${e}`)
        }
    })
}
