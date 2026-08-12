import { type ChildProcess, spawn } from "child_process"
import * as fs from "fs"
import type internal from "stream"
import { envVars } from "./config/env-vars"

// sudo apt install linux-modules-extra-`uname -r`
// The env variable VIRTUAL_MIC is used to set the virtual mic name. It needs to be prefixed with 'pulse:'
const MICRO_DEVICE: string = `pulse:${envVars.VIRTUAL_MIC}` // pulseaudio virtual mic
const CAMERA_DEVICE: string = envVars.VIDEO_DEVICE

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

  protected execute(args: string[], after: () => void): ChildProcess | null {
    if (this.process) {
      console.warn("Already on execution")
      return null
    }

    const child = spawn("ffmpeg", args, {
      stdio: ["pipe", "pipe", "pipe"]
    })
    this.process = child

    const stdoutListener = (data: Buffer) => {
      console.log(`[ffmpeg stdout] ${data.toString()}`)
    }
    const stderrListener = (data: Buffer) => {
      const output = data.toString()
      // Filter out repetitive fps progress updates, but keep important diagnostic info
      // Note: FFmpeg outputs normal logs to stderr, not just errors, so we use console.log
      if (output.trim() && !output.match(/^frame=\s*\d+\s+fps=\s*[\d.]+\s+q=/)) {
        // Filter repetitive progress lines
        console.log(`[ffmpeg stderr] ${output}`)
      }
    }

    child.stdout.addListener("data", stdoutListener)
    child.stderr.addListener("data", stderrListener)
    // Generic stdin guard for every MediaContext spawn (one-shot play() paths
    // included): without an "error" listener, a teardown-time EPIPE on the pipe
    // escalates to an uncaughtException that kills finalization.
    child.stdin?.on("error", (err) => {
      console.warn(`[MediaContext] ffmpeg stdin error (ignored during teardown): ${err}`)
    })

    this.promise = new Promise((resolve, reject) => {
      const cleanupListeners = () => {
        child.stdout.removeListener("data", stdoutListener)
        child.stderr.removeListener("data", stderrListener)
      }

      child.on("exit", (code) => {
        console.log(`process exited with code ${code}`)
        cleanupListeners()
        // Bind lifecycle cleanup to this child. A successful callback may start
        // a replacement before the old child's close event arrives.
        if (this.process === child) {
          this.process = null
        }
        if (code === 0) {
          after()
        }
        resolve(code)
      })
      child.on("error", (err) => {
        console.error("[MediaContext] ffmpeg process failed:", err)
        // Spawn failures have no live process and may safely release the slot
        // immediately. Kill/signaling errors can leave ffmpeg running, so keep
        // its handle until exit/close instead of allowing a duplicate spawn.
        if (child.pid === undefined && this.process === child) {
          this.process = null
        }
        reject(err)
      })
      child.on("close", () => {
        cleanupListeners()
        if (this.process === child) {
          this.process = null
        }
      })
    })
    // Nobody awaits this.promise until stop_process(), so a spawn/process
    // "error" before then would surface as an unhandledRejection and trip the
    // crash handler — crashing the whole bot over a degraded side-channel
    // (branding camera / spoken audio), while the recording itself is
    // unaffected. Mark it handled here; stop_process() still observes the
    // rejection through its own .catch().
    this.promise.catch(() => {})
    return child
  }

  protected async stop_process() {
    if (!this.process) {
      console.warn("Already stoped")
      return
    }

    const child = this.process
    const processPromise = this.promise!
    const res = child.kill("SIGTERM")
    console.log(`Signal sended to process : ${res}`)

    await processPromise
      .then((code) => {
        console.log(`process exited with code ${code}`)
      })
      .catch((err) => {
        console.log(`process exited with error ${err}`)
      })
      .finally(() => {
        // An error from kill/signaling can reject while ffmpeg is still alive.
        // Keep that child's handle until its exit/close handler clears it.
        if (
          this.process === child &&
          (child.exitCode !== null || child.signalCode !== null)
        ) {
          this.process = null
        }
        if (this.process !== child && this.promise === processPromise) {
          this.promise = null
        }
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
    SoundContext.instance.play("../silence.opus", false)
  }

  public play(pathname: string, loop: boolean) {
    // ffmpeg -stream_loop -1 -re -i La_bataille_de_Farador.mp4 -f alsa -ac 2 -ar 44100 hw:Loopback,1
    // ffmpeg -re -i cow_sound.mp3 -f alsa -acodec pcm_s16le "pulse:virtual_mic"
    const args: string[] = []
    if (loop) {
      args.push("-stream_loop", "-1")
    }
    args.push("-re", "-i", pathname, "-f", "alsa", "-acodec", "pcm_s16le", MICRO_DEVICE)
    super.execute(args, this.default)
  }

  // Return stdin and play sound to microphone
  public play_stdin(): internal.Writable {
    // ffmpeg -f f32le -ar <rate> -ac 1 -i - \
    //   -af aresample=async=1:min_hard_comp=0.100:first_pts=0 \
    //   -f alsa -acodec pcm_s16le "pulse:virtual_mic"
    //
    // We feed this ffmpeg from a live WebSocket (bursty, not clock-locked),
    // and it writes to a realtime pulse sink. Without async resampling, any
    // gap between bursts underruns the sink — ffmpeg falls behind realtime
    // (observed speed 0.76–0.87x) and the injected mic audio comes out
    // garbled/"overloaded". `aresample=async=1` keeps a continuous output
    // timeline: it stretches/compresses and pads short gaps with silence
    // instead of underrunning, so the virtual mic always gets steady,
    // correctly-clocked samples. first_pts=0 anchors the timeline at start.
    const args: string[] = []
    args.push(
      "-f",
      "f32le",
      "-ar",
      `${this.sampleRate}`,
      "-ac",
      "1",
      "-i",
      "-",
      "-af",
      "aresample=async=1:min_hard_comp=0.100:first_pts=0",
      "-f",
      "alsa",
      "-acodec",
      "pcm_s16le",
      MICRO_DEVICE
    )
    const stdin = super.execute(args, () => {
      console.warn("[play_stdin] Sequence ended")
    }).stdin
    // Same EPIPE guard as the video feeder: audio writes (streaming.ts) can flush
    // into ffmpeg's stdin after SIGTERM closes it, emitting EPIPE. Handle it here
    // so it never escalates to an uncaughtException that kills finalization.
    stdin.on("error", (err) => {
      console.warn(`[play_stdin] ffmpeg stdin error (ignored during teardown): ${err}`)
    })
    return stdin
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

  /** Current file being fed to ffmpeg stdin (persistent mode) */
  private currentFile: string | null = null
  /** Abort controller for the feeder loop */
  private feederAbort: AbortController | null = null
  /** ffmpeg stdin stream (persistent mode) */
  private ffmpegStdin: internal.Writable | null = null

  constructor() {
    super()
    VideoContext.instance = this
  }

  public default() {
    VideoContext.instance.play("../branding_0.mjpeg", true)
  }

  /**
   * Seamlessly switch to a new branding file without restarting ffmpeg.
   * In persistent mode, this just updates the file the feeder reads from —
   * no v4l2 gap, no camera dropout.
   */
  public async switchTo(pathname: string) {
    if (!fs.existsSync(pathname)) {
      console.log(`Video file not found: ${pathname}`)
      return
    }

    if (this.ffmpegStdin && !this.ffmpegStdin.destroyed && this.currentFile) {
      // Persistent mode: swap the source file, feeder picks it up next iteration
      console.log(`Seamless branding switch: ${this.currentFile} -> ${pathname}`)
      this.currentFile = pathname
      return
    }

    // Fallback: full restart (e.g. first play or non-persistent mode)
    await this.stop()
    this.play(pathname, true)
  }

  public play(pathname: string, loop: boolean) {
    // Check if file exists before attempting to play
    if (!fs.existsSync(pathname)) {
      console.log(`Video file not found: ${pathname}`)
      return
    }

    if (loop) {
      this.playPersistent(pathname)
    } else {
      // Non-looping: original behavior (one-shot playback)
      const args: string[] = [
        "-re",
        "-i",
        pathname,
        "-f",
        "v4l2",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "5",
        "-threads",
        "0",
        CAMERA_DEVICE
      ]
      super.execute(args, this.default)
    }
  }

  /**
   * Start a single persistent ffmpeg process that reads MJPEG data from stdin.
   * A feeder loop continuously writes the current file's data to stdin.
   * Switching files just changes what the feeder reads — ffmpeg never restarts,
   * v4l2 always has frames, Google Meet never sees a dead camera.
   */
  private playPersistent(pathname: string) {
    this.currentFile = pathname

    // ffmpeg reads raw MJPEG from stdin at 30fps, outputs to v4l2
    const args: string[] = [
      "-re",
      "-f",
      "mjpeg",
      "-r",
      "30",
      "-i",
      "pipe:0",
      "-f",
      "v4l2",
      "-vcodec",
      "mjpeg",
      "-q:v",
      "5",
      "-threads",
      "0",
      CAMERA_DEVICE
    ]

    const proc = super.execute(args, this.default)
    if (!proc) {
      console.error("Failed to start persistent ffmpeg for video")
      return
    }

    this.ffmpegStdin = proc.stdin
    // EPIPE guard: on teardown, ffmpeg is SIGTERM'd and closes its stdin read-end
    // while buffered frames are still flushing. Without an "error" listener that
    // EPIPE becomes an uncaughtException, which aborts finalization (the
    // end-meeting trampoline that reports artifacts + duration) and orphans the
    // bot record at recording_succeeded. Log and swallow it.
    this.ffmpegStdin.on("error", (err) => {
      console.warn(`[video feeder] ffmpeg stdin error (ignored during teardown): ${err}`)
    })
    this.startFeeder()
  }

  /**
   * Feeder loop: continuously reads the current MJPEG file and writes its
   * contents to ffmpeg's stdin. ffmpeg's -re flag paces consumption at 30fps,
   * creating natural backpressure through the pipe buffer.
   *
   * When switchTo() updates this.currentFile, the feeder picks up the new file
   * on its next iteration — typically within 1 second (one MJPEG file duration).
   */
  private startFeeder() {
    if (this.feederAbort) {
      this.feederAbort.abort()
    }
    this.feederAbort = new AbortController()
    const { signal } = this.feederAbort

    const feed = async () => {
      while (!signal.aborted && this.ffmpegStdin && !this.ffmpegStdin.destroyed) {
        try {
          const data = fs.readFileSync(this.currentFile!)
          const canWrite = this.ffmpegStdin.write(data)
          if (!canWrite && !signal.aborted) {
            await new Promise<void>((resolve) => {
              const onDrain = () => {
                signal.removeEventListener("abort", onAbort)
                resolve()
              }
              const onAbort = () => {
                this.ffmpegStdin?.removeListener("drain", onDrain)
                resolve()
              }
              this.ffmpegStdin!.once("drain", onDrain)
              signal.addEventListener("abort", onAbort, { once: true })
            })
          }
        } catch (e) {
          if (!signal.aborted) {
            console.error("Video feeder error:", e)
          }
          break
        }
      }
    }

    feed().catch((e) => {
      if (!signal.aborted) {
        console.error("Video feeder crashed:", e)
      }
    })
  }

  public async stop() {
    // Stop feeder first so it doesn't write to a closing stdin
    if (this.feederAbort) {
      this.feederAbort.abort()
      this.feederAbort = null
    }
    this.ffmpegStdin = null
    this.currentFile = null
    await super.stop_process()
  }
}
