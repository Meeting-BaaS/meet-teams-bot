import { ChildProcess, spawn } from 'child_process'
import * as fs from 'fs'
import internal from 'stream'

// sudo apt install linux-modules-extra-`uname -r`
// The env variable VIRTUAL_MIC is used to set the virtual mic name. It needs to be prefixed with 'pulse:'
const MICRO_DEVICE: string = `pulse:${process.env.VIRTUAL_MIC || 'virtual_mic'}` // pulseaudio virtual mic
const CAMERA_DEVICE: string = process.env.VIDEO_DEVICE || '/dev/video10'

// This abstract claas contains the current ffmpeg process
// A derived class must implement play and stop methods
//
// ___DUAL_CHANNEL_EXAMPLES
// ffmpeg -re -i La_bataille_de_Farador2.mp4 \
// -map 0:v -f v4l2 -vcodec copy /dev/video10 \
// -map 0:a -f alsa -ac 2 -ar 44100 hw:Loopback,
//
// ffmpeg -re -i La_bataille_de_Farador.mp4 \
//    -map 0:v -f v4l2 -vcodec mjpeg -s 640x360 /dev/video10 \
//    -map 0:a -f alsa -ac 2 -ar 44100 hw:Loopback,1
abstract class MediaContext {
    private process: ChildProcess | null
    private promise: Promise<number> | null

    constructor() {
        this.process = null
        this.promise = null
    }

    protected execute(
        args: string[],
        after: { (): void },
    ): ChildProcess | null {
        if (this.process) {
            console.warn('Already on execution')
            return null
        }

        this.process = spawn('ffmpeg', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        
        const stdoutListener = (data: Buffer) => {
            console.log(`[ffmpeg stdout] ${data.toString()}`)
        }
        const stderrListener = (data: Buffer) => {
            const output = data.toString()
            // Filter out repetitive fps progress updates, but keep important diagnostic info
            // Note: FFmpeg outputs normal logs to stderr, not just errors, so we use console.log
            if (output.trim() && 
                !output.match(/^frame=\s*\d+\s+fps=\s*[\d.]+\s+q=/)) { // Filter repetitive progress lines
                console.log(`[ffmpeg stderr] ${output}`)
            }
        }

        this.process.stdout.addListener('data', stdoutListener)
        this.process.stderr.addListener('data', stderrListener)

        this.promise = new Promise((resolve, reject) => {
            this.process.on('exit', (code) => {
                console.log(`process exited with code ${code}`)
                // Remove event listeners to prevent memory leaks
                this.process.stdout.removeListener('data', stdoutListener)
                this.process.stderr.removeListener('data', stderrListener)
                if (code == 0) {
                    this.process = null
                    after()
                }
                resolve(code)
            })
            this.process.on('error', (err) => {
                console.error(err)
                // Remove event listeners to prevent memory leaks
                this.process.stdout.removeListener('data', stdoutListener)
                this.process.stderr.removeListener('data', stderrListener)
                reject(err)
            })
        })
        return this.process
    }

    protected async stop_process() {
        if (!this.process) {
            console.warn('Already stoped')
            return
        }

        let res = this.process.kill('SIGTERM')
        console.log(`Signal sended to process : ${res}`)

        await this.promise
            .then((code) => {
                console.log(`process exited with code ${code}`)
            })
            .catch((err) => {
                console.log(`process exited with error ${err}`)
            })
            .finally(() => {
                this.process = null
                this.promise = null
            })
    }

    public abstract play(pathname: string, loop: boolean): void

    public abstract stop(): void
}

// Sound events into microphone device
export class SoundContext extends MediaContext {
    public static instance: SoundContext

    private sampleRate: number
    constructor(sampleRate: number) {
        super()
        this.sampleRate = sampleRate
        SoundContext.instance = this
    }

    public default() {
        SoundContext.instance.play(`../silence.opus`, false)
    }

    public play(pathname: string, loop: boolean) {
        // ffmpeg -stream_loop -1 -re -i La_bataille_de_Farador.mp4 -f alsa -ac 2 -ar 44100 hw:Loopback,1
        // ffmpeg -re -i cow_sound.mp3 -f alsa -acodec pcm_s16le "pulse:virtual_mic"
        let args: string[] = []
        if (loop) {
            args.push(`-stream_loop`, `-1`)
        }
        args.push(
            `-re`,
            `-i`,
            pathname,
            `-f`,
            `alsa`,
            `-acodec`,
            `pcm_s16le`,
            MICRO_DEVICE,
        )
        super.execute(args, this.default)
    }

    // Return stdin and play sound to microphone
    public play_stdin(): internal.Writable {
        // ffmpeg -f f32le -ar 48000 -ac 1 -i - -f alsa -acodec pcm_s16le "pulse:virtual_mic"
        let args: string[] = []
        args.push(
            `-f`,
            `f32le`,
            `-ar`,
            `${this.sampleRate}`,
            `-ac`,
            `1`,
            `-i`,
            `-`,
            `-f`,
            `alsa`,
            `-acodec`,
            `pcm_s16le`,
            MICRO_DEVICE,
        )
        return super.execute(args, () => {
            console.warn(`[play_stdin] Sequence ended`)
        }).stdin
    }

    public async stop() {
        await super.stop_process()
    }
}

// Video events into camera device
//
// https://github.com/umlaeute/v4l2loopback
// Add user to video group for accessing video device
// sudo usermod -a -G video ubuntu
//
// ___COMMON_ISSUE___ After many attempts or a long time
// [video4linux2,v4l2 @ 0x5581ac5f8ac0] ioctl(VIDIOC_G_FMT): Invalid argument
// Could not write header for output file #0 (incorrect codec parameters ?): Invalid argument
// Error initializing output stream 0:0 --
// Conversion failed!
export class VideoContext extends MediaContext {
    public static instance: VideoContext
    static readonly WIDTH: number = 1280
    static readonly HEIGHT: number = 720

    private fps: number // TODO : Use it later
    constructor(fps: number) {
        super()
        this.fps = fps
        VideoContext.instance = this
    }

    public default() {
        VideoContext.instance.play(`../branding.mjpeg`, true)
    }

    public play(pathname: string, loop: boolean) {
        // Check if file exists before attempting to play
        if (!fs.existsSync(pathname)) {
            console.log(`Video file not found: ${pathname}`)
            return
        }

        // ffmpeg -stream_loop -1 -re -i branding.mjpeg -f v4l2 -vcodec mjpeg -q:v 5 -threads 0 /dev/video10
        let args: string[] = []
        if (loop) {
            args.push(`-stream_loop`, `-1`)
        }
        args.push(
            `-re`,
            `-i`,
            pathname,
            `-f`,
            `v4l2`,
            `-vcodec`,
            `mjpeg`,
            `-q:v`,
            `5`,
            `-threads`,
            `0`,
            CAMERA_DEVICE,
        )
        super.execute(args, this.default)
    }

    public async stop() {
        await super.stop_process()
    }
}
