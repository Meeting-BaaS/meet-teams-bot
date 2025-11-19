import { Api } from './api/methods'
import { ApiTypes } from './api/types'
import { GLOBAL } from './singleton'
import { MeetingStateMachine } from './state-machine/machine'
import { SpeakerData } from './types'

import * as asyncLib from 'async'

var LAST_TRANSRIPT: ApiTypes.QueryableTranscript | null = null
var TRANSCIBER_STOPED: boolean = false
var TRANSCRIPT_QUEUE = newTranscriptQueue()

function newTranscriptQueue() {
    return asyncLib.queue(async function (
        task: () => Promise<void>,
        done: any,
    ) {
        await task()
        done()
    }, 1) // One operation at the same time
}

// IMPORTANT : For reasons of current compatibility, this function is only called
// with a single speaker and not an array of multiple speakers. Handling multiple
// speakers should be implemented at some point.
export async function uploadTranscriptTask(
    speaker: SpeakerData,
    end: boolean,
    endTimeSeconds?: number,
): Promise<void> {
    if (GLOBAL.isServerless()) {
        console.log('Skipping transcript upload - serverless mode')
        return
    }
    if (speaker.timestamp === null || speaker.timestamp === undefined) {
        console.log('Skipping transcript upload - timestamps not yet available')
        return
    }

    return new Promise((resolve, reject) => {
        TRANSCRIPT_QUEUE.push(async () => {
            try {
                await upload(speaker, end, endTimeSeconds)
                resolve()
            } catch (error) {
                reject(error)
            }
        })
    })
}

async function upload(
    speaker: SpeakerData,
    end: boolean,
    endTimeSeconds?: number,
) {
    if (TRANSCIBER_STOPED) {
        console.info('Transcriber is stoped')
        return
    }
    const meetingStartTime = MeetingStateMachine.instance.getStartTime()
    if (meetingStartTime == null || meetingStartTime == undefined) {
        console.warn(
            'Meeting start time not available for posting transcript - skipping',
        )
        return
    }

    try {
        const api = Api.instance
        if (LAST_TRANSRIPT) {
            try {
                // Use provided endTimeSeconds if available (for meeting end), otherwise use speaker timestamp
                const endTime =
                    endTimeSeconds !== undefined
                        ? endTimeSeconds
                        : (speaker.timestamp - meetingStartTime) / 1000

                await api.patchTranscript({
                    id: LAST_TRANSRIPT.id,
                    end_time: endTime,
                } as ApiTypes.ChangeableTranscript)
            } catch (e) {
                console.error(
                    'Failed to patch transcript, continuing execution:',
                    e,
                )
                // Continue execution despite error
            }
        }

        if (end === true) {
            // Just patch the last transcript if in end
            TRANSCIBER_STOPED = true
            return
        } else {
            try {
                if (meetingStartTime == null || meetingStartTime == undefined) {
                    console.warn(
                        'Meeting start time not available for posting transcript - skipping',
                    )
                    return
                }

                LAST_TRANSRIPT = await api.postTranscript({
                    speaker: speaker.name,
                    start_time: (speaker.timestamp - meetingStartTime) / 1000,
                } as ApiTypes.PostableTranscript)
            } catch (e) {
                console.error(
                    'Failed to post transcript, continuing execution:',
                    e,
                )
                // Continue execution despite error
            }
        }
    } catch (e) {
        console.error(
            'Unexpected error in transcript upload, continuing execution:',
            e,
        )
        // Continue execution despite any errors
    }
}
