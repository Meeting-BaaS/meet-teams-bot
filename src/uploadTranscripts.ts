import { Api } from './api/methods'
import { ApiTypes } from './api/types'
import { GLOBAL } from './singleton'

import * as asyncLib from 'async'

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
    speaker: ApiTypes.PostableTranscript,
): Promise<void> {
    if (GLOBAL.isServerless()) {
        console.log(
            '📤 [SERVERLESS] Would send transcript to server:',
            JSON.stringify(speaker, null, 2),
        )
        return
    }
    if (speaker.start_time === null || speaker.start_time === undefined) {
        console.log('Skipping transcript upload - timestamps not yet available')
        return
    }

    return new Promise((resolve, reject) => {
        TRANSCRIPT_QUEUE.push(async () => {
            try {
                await upload(speaker)
                resolve()
            } catch (error) {
                reject(error)
            }
        })
    })
}

async function upload(speaker: ApiTypes.PostableTranscript) {
    if (TRANSCIBER_STOPED) {
        console.info('Transcriber is stopped')
        return
    }

    try {
        console.log(
            '📤 [API] Sending transcript to server:',
            JSON.stringify(speaker, null, 2),
        )
        const api = Api.instance
        await api.postTranscript(speaker)
        console.log('✅ [API] Transcript sent successfully')
    } catch (e) {
        console.error('Failed to post transcript, continuing execution:', e)
        // Continue execution despite error
    }
}
