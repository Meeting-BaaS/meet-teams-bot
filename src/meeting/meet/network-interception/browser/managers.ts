// Browser-side managers for tracking receivers, users, and SSRCs (functional approach)

import type {
    DeviceOutput,
    RawDeviceOutput,
    RawUser,
    ReceiverManager,
    UserManager,
} from '../types'

// --- ReceiverManager: Tracks WebRTC receivers and contributing sources ---

export const createReceiverManager = (): ReceiverManager => ({
    receiverMap: new Map(),
    receiverToTrackMap: new Map(),
})

export const updateContributingSources = (
    manager: ReceiverManager,
    receiver: any,
    result: any,
): void => {
    manager.receiverMap.set(receiver, result)
}

export const getContributingSources = (
    manager: ReceiverManager,
    receiver: any,
): any[] => {
    return manager.receiverMap.get(receiver) || []
}

export const linkReceiverToTrack = (
    manager: ReceiverManager,
    receiver: any,
    trackId: any,
): void => {
    manager.receiverToTrackMap.set(receiver, trackId)
}

// --- UserManager: Maps device IDs, SSRCs, and user information ---

export const createUserManager = (): UserManager => ({
    deviceOutputMap: new Map(),
    allUsersMap: new Map(),
    ssrcToDeviceMap: new Map(),
})

export const updateDeviceOutputs = (
    manager: UserManager,
    deviceOutputs: RawDeviceOutput[],
): void => {
    deviceOutputs.forEach((output) => {
        const key = `${output.deviceId}-${output.deviceOutputType}`
        const deviceOutput: DeviceOutput = {
            deviceId: output.deviceId,
            outputType: output.deviceOutputType,
            streamId: output.streamId,
            lastUpdated: Date.now(),
        }
        manager.deviceOutputMap.set(key, deviceOutput)

        // Map streamId (SSRC) to device ID
        if (output.streamId) {
            // Store as string
            manager.ssrcToDeviceMap.set(output.streamId, output.deviceId)
            // Also try mapping as number since contributing sources might return numbers
            const numericSSRC = parseInt(output.streamId, 10)
            if (!isNaN(numericSSRC)) {
                manager.ssrcToDeviceMap.set(numericSSRC, output.deviceId)
            }
        }
    })
}

export const updateUsers = (manager: UserManager, users: RawUser[]): void => {
    users
        .filter((user) => user.deviceId)
        .forEach((user) => manager.allUsersMap.set(user.deviceId, user))
}

export const getUserByStreamId = (
    manager: UserManager,
    streamId: any,
): RawUser | null => {
    // Try direct lookup first (as-is)
    let deviceId = manager.ssrcToDeviceMap.get(streamId)

    // Try as string
    if (!deviceId && typeof streamId !== 'string') {
        deviceId = manager.ssrcToDeviceMap.get(streamId.toString())
    }

    // Try as number
    if (!deviceId && typeof streamId === 'string') {
        const numericSSRC = parseInt(streamId, 10)
        if (!isNaN(numericSSRC)) {
            deviceId = manager.ssrcToDeviceMap.get(numericSSRC)
        }
    }

    if (deviceId) {
        return manager.allUsersMap.get(deviceId)
    }

    // Fallback: Look through device outputs to find matching stream
    const matchingOutput = Array.from(manager.deviceOutputMap.values()).find(
        (deviceOutput) =>
            deviceOutput.streamId === streamId ||
            deviceOutput.streamId === streamId.toString() ||
            deviceOutput.streamId === String(streamId),
    )

    return matchingOutput
        ? manager.allUsersMap.get(matchingOutput.deviceId)
        : null
}

export const getAllUsers = (manager: UserManager): RawUser[] => {
    return Array.from(manager.allUsersMap.values())
}

// --- RTCRtpReceiverInterceptor: Intercepts getContributingSources calls ---

export const setupRTCRtpReceiverInterceptor = (
    onGetContributingSources: (receiver: any, sources: any[]) => void,
): void => {
    const OriginalRTCRtpReceiver = (window as any).RTCRtpReceiver
    if (
        !OriginalRTCRtpReceiver ||
        !OriginalRTCRtpReceiver.prototype.getContributingSources
    ) {
        console.error(
            '[NetworkInterceptor] ⚠️ RTCRtpReceiver.getContributingSources not available',
        )
        return
    }

    const originalGetContributingSources =
        OriginalRTCRtpReceiver.prototype.getContributingSources

    // Replace with intercepted version
    OriginalRTCRtpReceiver.prototype.getContributingSources = function () {
        // Call original method
        const result = originalGetContributingSources.apply(this, arguments)

        // Callback with receiver and result
        if (onGetContributingSources && result && result.length > 0) {
            onGetContributingSources(this, result)
        }

        return result
    }

    console.error(
        '[NetworkInterceptor] ✅ RTCRtpReceiver.getContributingSources intercepted',
    )
}
