import * as record from './record'
import { SoundStreamer } from './soundStreamer'

import { MeetingProvider, RecordingMode } from './api'

import { ApiService } from './api'

// Initialize API service separately from recording
export async function initApiService(
    local_recording_server_location: string,
): Promise<void> {
    await ApiService.init(local_recording_server_location)
}

export async function startRecording(
    local_recording_server_location: string,
    chunkDuration: number,
    streaming_output?: string,
    streaming_audio_frequency?: number,
): Promise<number> {
    try {
        ApiService.init(local_recording_server_location)

        await ApiService.sendMessageToRecordingServer(
            'LOG',
            'FROM_EXTENSION: ************ Start recording launched. ************',
        )

        await record.initMediaRecorder(
            streaming_output,
            streaming_audio_frequency,
        )
        return await record.startRecording(chunkDuration)
    } catch (e) {
        console.log('ERROR while start recording', JSON.stringify(e))
        throw e
    }
}

// Launch observeSpeakers.js() script inside web page DOM (Meet, teams ...)
export async function start_speakers_observer(
    recording_mode: RecordingMode,
    bot_name: string,
    meetingProvider: MeetingProvider,
    local_recording_server_location?: string,
) {
    // Initialize ApiService if URL is provided (needed for speakers communication)
    if (local_recording_server_location) {
        await ApiService.init(local_recording_server_location)
    }
    
    chrome.tabs.executeScript(
        {
            code: `var RECORDING_MODE = ${JSON.stringify(
                recording_mode,
            )}; var BOT_NAME = ${JSON.stringify(
                bot_name,
            )}; var MEETING_PROVIDER=${JSON.stringify(meetingProvider)}`,
        },
        function () {
            chrome.tabs.executeScript({
                file: './js/observeSpeakers.js',
            })
        },
    )
}

// Launch shittyHtml.js() script inside web page DOM (Meet, teams ...)
export async function remove_shitty_html(
    recording_mode: RecordingMode,
    meetingProvider: MeetingProvider,
) {
    chrome.tabs.executeScript(
        {
            code: `var RECORDING_MODE = ${JSON.stringify(
                recording_mode,
            )}; var MEETING_PROVIDER=${JSON.stringify(meetingProvider)}`,
        },
        function () {
            chrome.tabs.executeScript({
                file: './js/shittyHtml.js',
            })
        },
    )
}

export async function stopMediaRecorder(): Promise<void> {
    return await record.stop()
}

// Stop the Audio Recording
export async function stopAudioStreaming() {
    SoundStreamer.instance?.stop()
}

function setUserAgent(window: Window, userAgent: string) {
    // Works on Firefox, Chrome, Opera and IE9+
    if ((navigator as any).__defineGetter__) {
        Object.defineProperty(navigator, 'userAgent', {
            get: function () {
                return userAgent
            },
        })
    } else if (Object.defineProperty) {
        Object.defineProperty(navigator, 'userAgent', {
            get: function () {
                return userAgent
            },
        })
    }
    // Works on Safari
    if (window.navigator.userAgent !== userAgent) {
        const userAgentProp = {
            get: function () {
                return userAgent
            },
        }
        try {
            Object.defineProperty(window.navigator, 'userAgent', userAgentProp)
        } catch (e) {
            // console.warn('Failed to set userAgent', e)
        }
    }
}

setUserAgent(
    window,
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
)

const w = window as any
w.initApiService = initApiService // Initialize API service
w.startRecording = startRecording // Start screen recording
w.stopMediaRecorder = stopMediaRecorder // stop screen recording
w.stopAudioStreaming = stopAudioStreaming // Stop audio streaming
w.start_speakers_observer = start_speakers_observer // Start speakers observer
w.remove_shitty_html = remove_shitty_html // Remove shitty Html
