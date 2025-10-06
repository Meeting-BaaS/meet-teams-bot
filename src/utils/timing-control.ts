/**
 * Handles timing control for precise meeting join times.
 * If start_time is provided, waits until that exact time before joining.
 * This allows for pre-warmed bots to join at the precise scheduled time.
 */
export async function handleTimingControl(startTime?: number): Promise<void> {
    if (!startTime) {
        console.log('No timing control needed - joining immediately')
        return
    }

    const currentTime = Math.floor(Date.now() / 1000) // Current time in seconds
    
    if (startTime > currentTime) {
        const waitDuration = startTime - currentTime
        console.log(
            `Bot is early by ${waitDuration} seconds. Waiting until scheduled start time: ${startTime}`
        )
        
        // Wait until the scheduled start time
        await new Promise(resolve => setTimeout(resolve, waitDuration * 1000))
        
        console.log('Timing control: Bot is now ready to join at scheduled time')
    } else {
        console.log(
            `Bot is late by ${currentTime - startTime} seconds. Joining immediately (scheduled: ${startTime}, current: ${currentTime})`
        )
    }
}
