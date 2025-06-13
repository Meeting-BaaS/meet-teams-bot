import axios from 'axios'

export type MeetingProvider = 'Zoom' | 'Meet' | 'Teams'

type MessageType = 'SPEAKERS' | 'LOG' | 'UPLOAD_CHUNK' | 'UPLOAD_CHUNK_FINAL'

// Yes, any is funny :cow:
type MessagePayload = any

export const sleep = (milliseconds: number) => {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export type RecordingMode = 'speaker_view' | 'gallery_view' | 'audio_only'

export class ApiService {
    private static RecordingServerLocation: string | null = null

    private constructor() {}

    public static async init(url: string): Promise<void> {
        return new Promise((resolve) => {
            chrome.storage.local.set({ RecordingServerLocation: url }, () => {
                ApiService.RecordingServerLocation = url
                // console.log('ApiService initialized with URL:', url)
                resolve()
            })
        })
    }

    public static async getRecordingServerLocation(): Promise<string | null> {
        if (ApiService.RecordingServerLocation) {
            return ApiService.RecordingServerLocation
        }

        return new Promise((resolve) => {
            chrome.storage.local.get(['RecordingServerLocation'], (result) => {
                ApiService.RecordingServerLocation =
                    result.RecordingServerLocation || null
                resolve(ApiService.RecordingServerLocation)
            })
        })
    }

    public static async sendMessageToRecordingServer(
        messageType: MessageType,
        payload: MessagePayload,
    ): Promise<void> {
        const url = await ApiService.getRecordingServerLocation()
        if (!url) {
            throw new Error('ApiService not initialized. Call init() first.')
        }

        // console.log(
        //     'Sending message to recording server with PATH:',
        //     messageType,
        //     payload,
        //     url,
        // )

        async function upload_chunk(isFinal: boolean) {
            // OBSOLETE: Ces routes transcoder n'existent plus avec le nouveau système ScreenRecorder
            console.warn('OBSOLETE: transcoder routes no longer exist with new ScreenRecorder system')
            console.warn('Chunks are no longer needed - ScreenRecorder captures directly')
            return
            
            // Ancien code conservé pour référence :
            // let route = !isFinal ? 'upload_chunk' : 'upload_chunk_final'
            // await axios.post(`${url}transcoder/${route}`, payload, {
            //     headers: { 'Content-Type': 'application/octet-stream' },
            //     maxContentLength: 500 * 1024 * 1024,
            // })
        }

        switch (messageType) {
            case 'UPLOAD_CHUNK':
                await upload_chunk(false)
                break
            case 'UPLOAD_CHUNK_FINAL':
                await upload_chunk(true)
                break
            case 'SPEAKERS':
                await axios
                    .post(`${url}add_speaker`, payload)
                    .catch((error) => {
                        console.error('Failed to send SPEAKER message:', error)
                    })
                break
            case 'LOG':
                await axios
                    .post(`${url}broadcast_message`, payload)
                    .catch((error) => {
                        console.error('Failed to send LOG message:', error)
                    })
                break
            default:
                console.error('Unexpected message type !')
        }
    }
}
