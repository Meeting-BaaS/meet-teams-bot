import { execFile, execSync } from 'child_process'
import express from 'express'
import { unlinkSync } from 'fs'
import * as path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

import { SoundContext, VideoContext } from './media_context'
import { GLOBAL } from './singleton'
import { MeetingStateMachine } from './state-machine/machine'
import { MeetingEndReason } from './state-machine/types'
import { StopRecordParams } from './types'

const HOST = '0.0.0.0'
const PORT = 8080

async function getAllowedOrigins(): Promise<string[]> {
    return [process.env.ALLOWED_ORIGIN]
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

    // Leave bot request from api server
    app.post('/stop_record', async (req, res) => {
        const data: StopRecordParams = req.body
        console.log('end meeting from api server :', data)

        // Validate meeting URL with the one stored in Singleton
        try {
            const globalParams = GLOBAL.get()
            if (data.meeting_url !== globalParams.meeting_url) {
                console.log('Meeting URL mismatch:', {
                    requested: data.meeting_url,
                    stored: globalParams.meeting_url,
                })
                return res.status(400).json({
                    error: 'Meeting URL mismatch',
                    details:
                        'The provided meeting URL does not match the active meeting',
                })
            }
        } catch (error) {
            console.log('No active meeting found in Singleton')
            return res.status(404).json({
                error: 'No active meeting found',
                details: 'No meeting parameters are currently set',
            })
        }

        return stop_record(res, MeetingEndReason.ApiRequest)
    })

    async function stop_record(res: any, reason: MeetingEndReason) {
        try {
            const meetingHandle = MeetingStateMachine.instance

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

    // Upload ressources into the server
    app.post('/upload', async (request, result) => {
        const params: Upload = request.body
        console.log(params)

        const extension = path.extname(params.url)
        if (
            !Object.values(FileExtension).includes(extension as FileExtension)
        ) {
            result.status(400).json({
                error: 'This extension is not compatible',
            })
            return
        }
        const filename = path.basename(params.url)

        try {
            // Use curl with non-blocking execFile to avoid shell injection and event-loop blocking
            await execFileAsync('curl', [
                '--connect-timeout',
                '10',
                '--max-time',
                '10',
                '--compressed',
                '-fS',
                '-L',
                '-o',
                filename,
                params.url,
            ])
            console.log('Ressource downloaded @', filename)

            // In case of image, create a video from it with FFMPEG and delete tmp files
            if (
                extension === FileExtension.Jpg ||
                extension === FileExtension.Png
            ) {
                try {
                    const command = `ffmpeg -y -i ${filename} -vf scale=${VideoContext.WIDTH}:${VideoContext.HEIGHT} -y resized_${filename}`
                    const output = execSync(command)
                    console.log(output.toString())
                } catch (e) {
                    console.error(`Unexpected error when scaling image : ${e}`)
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
        } catch (e) {
            console.log(e)
            result.status(400).json({
                error: e,
            })
        }
    })

    // Play a given ressource into microphone, camera or both
    app.post('/play', async (request, result) => {
        const params: Upload = request.body
        console.log(params)

        const extension = path.extname(params.url)
        if (
            !Object.values(FileExtension).includes(extension as FileExtension)
        ) {
            result.status(400).json({
                error: 'This extension is not compatible',
            })
            return
        }
        const filename = path.basename(params.url)
        switch (extension as FileExtension) {
            case FileExtension.Png:
            case FileExtension.Jpg:
                await VideoContext.instance.stop()
                VideoContext.instance.play(`${filename}.mp4`, true)
                break
            case FileExtension.Mp3:
                await SoundContext.instance.stop()
                SoundContext.instance.play(`${filename}`, false)
                break
            case FileExtension.Mp4:
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

    try {
        app.listen(PORT, HOST)
        console.log(`Running on http://${HOST}:${PORT}`)
    } catch (e) {
        console.error(`Failed to register instance: ${e}`)
    }
}
