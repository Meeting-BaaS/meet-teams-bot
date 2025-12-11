import * as fs from "node:fs/promises"
import * as path from "node:path"
import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"

const EFS_MOUNT_POINT = envVars.EFS_MOUNT_POINT

// Get the monorepo root directory
// When serverless: we're in a different directory structure, so use relative paths
// When not serverless: we're in the monorepo, so calculate the root
const ROOT = envVars.SERVERLESS
  ? path.resolve(__dirname)
  : path.resolve(__dirname, "../../../../..")

export class PathManager {
  private static instance: PathManager
  private botUuid: string

  private constructor() {
    const global = GLOBAL.get()
    this.botUuid = global.bot_uuid
  }

  public static getInstance(): PathManager {
    if (!PathManager.instance) {
      PathManager.instance = new PathManager()
    }
    return PathManager.instance
  }

  public async initializePaths(): Promise<void> {
    const paths = [
      this.getBasePath(),
      path.dirname(this.getOutputPath()),
      this.getTempPath(),
      this.getAudioTmpPath(),
      this.getScreenshotsPath(),
      this.getHtmlSnapshotsPath()
    ]

    for (const p of paths) {
      try {
        await fs.mkdir(p, { recursive: true })
        console.log(`Created directory: ${p}`)
      } catch (error) {
        console.error(`Failed to create directory ${p}:`, error)
        throw error
      }
    }
  }

  public getIdentifier(): string {
    return this.botUuid
  }

  // Write to /tmp during runtime
  public getBasePath(): string {
    switch (envVars.ENVIRON) {
      case "prod":
        return path.join("/tmp", this.botUuid)
      case "preprod":
        return path.join("/tmp", this.botUuid)
      case "local":
        return path.join(ROOT, "artifacts", this.botUuid)
      default:
        throw new Error(`Invalid environment: ${envVars.ENVIRON}`)
    }
  }

  // Write to EFS if upload to S3 fails
  public getEfsPath(): string {
    return path.join(EFS_MOUNT_POINT, envVars.ENVIRON, "s3_upload_fails", this.botUuid)
  }

  public getOutputPath(): string {
    return path.join(this.getBasePath(), "output")
  }

  public getAudioTmpPath(): string {
    return path.join(this.getBasePath(), "audio_tmp")
  }

  public getSpeakerLogPath(): string {
    return path.join(this.getBasePath(), "speaker_separation.log")
  }

  public getSoundLogPath(): string {
    return path.join(this.getBasePath(), "sound_levels.log")
  }

  public getTempPath(): string {
    return path.join(this.getBasePath(), "temp")
  }

  public getScreenshotsPath(): string {
    return path.join(this.getBasePath(), "screenshots")
  }

  public getHtmlSnapshotsPath(): string {
    return path.join(this.getBasePath(), "html_snapshots")
  }

  public getDebugStreamedAudioPath(): string {
    return path.join(this.getBasePath(), "debug_streamed_audio.wav")
  }

  public getS3Paths(): { bucketName: string; s3Path: string } {
    const identifier = this.getIdentifier()
    return {
      bucketName: envVars.AWS_S3_ARTIFACTS_BUCKET,
      s3Path: `${identifier}`
    }
  }
}
