import express from 'express'
import * as fs from 'fs/promises'
import * as redis from 'redis'

import { execSync } from 'child_process'
import { SoundContext, VideoContext } from './media_context'
import { MessageToBroadcast, SpeakerData, StopRecordParams } from './types'

import axios from 'axios'
import { unlinkSync } from 'fs'
import { MeetingHandle } from './meeting'

import { SpeakerManager } from './speaker-manager'
import { RecordingEndReason } from './state-machine/types'

const HOST = '0.0.0.0'
export const PORT = 8080

console.log('redis url: ', process.env.REDIS_URL)
export const clientRedis = redis.createClient({
    url: process.env.REDIS_URL,
})
clientRedis.on('error', (err) => {
    console.error('Redis error:', err)
})

const MEET_ORIGINS = [
    'https://meet.google.com',
    'https://meet.googleapis.com',
    'https://meetings.googleapis.com',
    'https://teams.microsoft.com',
    'https://teams.live.com',
]
async function getAllowedOrigins(): Promise<string[]> {
    return [
        process.env.ALLOWED_ORIGIN,
        'http://localhost:3005',
        ...MEET_ORIGINS,
    ]
}

export async function server() {
    const app = express()
    const allowedOrigins = await getAllowedOrigins()

    app.use(express.urlencoded({ extended: true }))
    app.use(express.raw({ type: 'application/octet-stream', limit: '1000mb' }))
    app.use(express.json({ limit: '1000mb' })) // To parse the incoming requests with JSON payloads
    app.use(express.urlencoded({ limit: '1000mb' }))

    app.use((req, res, next) => {
        const origin = req.headers.origin
        if (allowedOrigins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin)
        }
        res.header('Access-Control-Allow-Credentials', 'true')
        res.header(
            'Access-Control-Allow-Methods',
            'OPTIONS, GET, PUT, POST, DELETE',
        )
        res.header(
            'Access-Control-Allow-Headers',
            'Authorization2, Content-Type',
        )

        // trim meeting url
        if ((req.body as { meeting_url: string })?.meeting_url != null) {
            req.body.meeting_url = req.body.meeting_url.trim()
        }

        next()
    })

    app.options('*', (_req, res) => {
        const origin = _req.headers.origin
        if (allowedOrigins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin)
        }
        res.header('Access-Control-Allow-Credentials', 'true')
        res.header(
            'Access-Control-Allow-Methods',
            'OPTIONS, GET, PUT, POST, DELETE',
        )
        res.header(
            'Access-Control-Allow-Headers',
            'Authorization2, Content-Type',
        )
        res.sendStatus(204)
    })

    // Console log message (into logs)
    app.post('/broadcast_message', async (req, res) => {
        const message: MessageToBroadcast = req.body
        console.log('Message received from extension :', message)
        res.status(200).json({})
    })

    // Speakers event from All providers : Write logs and send data to extension
    app.post('/add_speaker', async (req, res) => {
        try {
            const speakers: SpeakerData[] = req.body
            await SpeakerManager.getInstance().handleSpeakerUpdate(speakers)
            res.status(200).send('ok')
        } catch (error) {
            console.error('Error in add_speaker route:', error)
            res.status(500).send('Internal server error')
        }
    })
    // Leave bot request from api server
    app.post('/stop_record', async (req, res) => {
        const data: StopRecordParams = req.body
        console.log('end meeting from api server :', data)

        // Mettre à jour immédiatement le contexte de la machine à états
        if (MeetingHandle.instance) {
            MeetingHandle.instance.stateMachine.context.endReason =
                RecordingEndReason.ApiRequest
        }

        stop_record(res, RecordingEndReason.ApiRequest)
    })

    //logger zoom
    app.post('/logs', (req, res) => {
        // console.log('logs from zoom', req.body)
        const { level, message, timestamp } = req.body

        // Function to colorize logs in terminal
        function colorLog(level, message, timestamp) {
            switch (level) {
                case 'warn':
                    console.warn(
                        '\x1b[33m%s\x1b[0m',
                        `[WARN] ${timestamp}: ${message}`,
                    )
                    break
                case 'info':
                    console.info(
                        '\x1b[36m%s\x1b[0m',
                        `[INFO] ${timestamp}: ${message}`,
                    )
                    break
                case 'error':
                    console.error(
                        '\x1b[31m%s\x1b[0m',
                        `[ERROR] ${timestamp}: ${message}`,
                    )
                    break
                default:
                    console.log(
                        '\x1b[0m%s\x1b[0m',
                        `[LOG] ${timestamp}: ${message}`,
                    )
            }
        }

        colorLog(level, message, timestamp)

        res.sendStatus(200)
    })

    async function stop_record(res: any, reason: RecordingEndReason) {
        try {
            const meetingHandle = MeetingHandle.instance

            if (!meetingHandle) {
                return res.status(404).json({
                    error: 'No active meeting found',
                })
            }

            // Appeler la méthode d'arrêt
            await meetingHandle.stopMeeting(reason)

            res.json({
                success: true,
                message: 'Meeting stopped successfully',
            })
        } catch (error) {
            console.error('Failed to stop meeting:', error)
            res.status(500).json({
                error: 'Failed to stop meeting',
                details: (error as Error).message,
            })
        }
    }

    // Get Recording Server Build Version Info
    app.get('/version', async (_req, res) => {
        console.log(`version requested`)
        await import('./buildInfo.json')
            .then((buildInfo) => {
                res.status(200).json(buildInfo)
            })
            .catch((_error) => {
                res.status(404).json({
                    error: 'None build has been done',
                })
            })
    })

    type Upload = {
        url: string
    }

    enum FileExtension {
        Jpg = '.jpg',
        Png = '.png',
        Mp4 = '.mp4',
        Mp3 = '.mp3',
    }

    const path = require('path')

    // Upload ressources into the server
    app.post('/upload', async (request, result) => {
        const params: Upload = request.body
        console.log(params)

        const extension = path.extname(params.url)
        if (!Object.values(FileExtension).includes(extension)) {
            result.status(400).json({
                error: 'This extension is not compatible',
            })
            return
        }
        await axios
            .get(params.url, { responseType: 'arraybuffer' })
            .then((file) => {
                const filename = path.basename(params.url)

                fs.writeFile(filename, file.data)
                console.log('Ressource downloaded @', filename)

                // In case of image, create a video from it with FFMPEG and delete tmp files
                if (extension == '.jpg' || extension == '.png') {
                    try {
                        const command = `ffmpeg -y -i ${filename} -vf scale=${VideoContext.WIDTH}:${VideoContext.HEIGHT} -y resized_${filename}`
                        const output = execSync(command)
                        console.log(output.toString())
                    } catch (e) {
                        console.error(
                            `Unexpected error when scaling image : ${e}`,
                        )
                        result.status(400).json({
                            error: 'Cannot scale image',
                        })
                        return
                    }
                    try {
                        const command = `ffmpeg -y -loop 1 -i resized_${filename} -c:v libx264 -preset ultrafast -tune stillimage -r 30 -t 1 -pix_fmt yuv420p ${filename}.mp4`
                        const output = execSync(command)
                        console.log(output.toString())
                    } catch (e) {
                        console.error(
                            `Unexpected error when generating video : ${e}`,
                        )
                        result.status(400).json({
                            error: 'Cannot generate video',
                        })
                        return
                    }
                    try {
                        unlinkSync(`${filename}`)
                        unlinkSync(`resized_${filename}`)
                    } catch (e) {
                        console.error(`Cannot unlink files : ${e}`)
                    }
                }
                result.status(200).json({
                    ok: 'New ressource uploaded',
                })
            })
            .catch((e) => {
                console.log(e)
                result.status(400).json({
                    error: e,
                })
            })
    })

    // Play a given ressource into microphone, camera or both
    app.post('/play', async (request, result) => {
        const params: Upload = request.body
        console.log(params)

        const extension = path.extname(params.url)
        if (!Object.values(FileExtension).includes(extension)) {
            result.status(400).json({
                error: 'This extension is not compatible',
            })
            return
        }
        const filename = path.basename(params.url)
        switch (extension) {
            case '.png':
            case '.jpg':
                await VideoContext.instance.stop()
                VideoContext.instance.play(`${filename}.mp4`, true)
                break
            case '.mp3':
                await SoundContext.instance.stop()
                SoundContext.instance.play(`${filename}`, false)
                break
            case '.mp4':
                await VideoContext.instance.stop()
                await SoundContext.instance.stop()
                VideoContext.instance.play(`${filename}`, false)
                SoundContext.instance.play(`${filename}`, false)
                break
            default:
                console.error('Unexpected Extension :', extension)
                result.status(400).json({
                    error: 'Unexpected Extension',
                })
                return
        }
        result.status(200).json({
            ok: 'Ressource on playing...',
        })
    })

    // Unused ?
    app.get('/shutdown', async (_req, res) => {
        console.warn('Shutdown requested')
        res.send('ok')
        process.exit(0)
    })

    // Routes transcoder supprimées - remplacées par ScreenRecorder direct

    try {
        app.listen(PORT, HOST)
        console.log(`Running on http://${HOST}:${PORT}`)
    } catch (e) {
        console.error(`Failed to register instance: ${e}`)
    }
}
