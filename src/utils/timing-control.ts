/**
 * Handles timing control for precise meeting join times.
 * If start_time is provided, waits until that exact time before joining.
 * This allows for pre-warmed bots to join at the precise scheduled time.
 * Returns the actual start time (either scheduled or current) for reporting to backend.
 *
 * @param abortCheck - Optional async callback polled every ~3s during the wait.
 *                     If it returns true the wait is terminated early (e.g. page navigated away).
 */
export async function handleTimingControl(
    startTime?: number,
    abortCheck?: () => Promise<boolean>,
): Promise<number> {
    if (!startTime) {
        // No scheduled start time - capture actual start time
        const actualStartTime = Math.floor(Date.now() / 1000)
        console.log(
            `No timing control needed - joining immediately at actual start time: ${actualStartTime}`,
        )
        return actualStartTime
    }

    const currentTime = Math.floor(Date.now() / 1000) // Current time in seconds

    if (startTime > currentTime) {
        const waitDuration = startTime - currentTime
        console.log(
            `Bot is early by ${waitDuration} seconds. Waiting until scheduled start time: ${startTime}`,
        )

        // Poll in short intervals so we can detect page state changes (e.g. denial redirects)
        const POLL_INTERVAL_MS = 3000
        const endTime = Date.now() + waitDuration * 1000
        while (Date.now() < endTime) {
            if (abortCheck) {
                try {
                    if (await abortCheck()) {
                        console.log('Timing control: abort check triggered, stopping wait early')
                        return Math.floor(Date.now() / 1000)
                    }
                } catch (err) {
                    console.warn(`Timing control: abortCheck threw, treating as no-abort: ${err}`)
                }
            }
            const remaining = endTime - Date.now()
            if (remaining <= 0) break
            await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)))
        }

        console.log(
            'Timing control: Bot is now ready to join at scheduled time',
        )
        return startTime
    } else {
        console.log(
            `Bot is late by ${currentTime - startTime} seconds. Joining immediately (scheduled: ${startTime}, current: ${currentTime})`,
        )
        return startTime
    }
}
