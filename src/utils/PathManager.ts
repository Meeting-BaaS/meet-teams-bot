import * as fs from "node:fs/promises"
import * as path from "node:path"
import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"

const EFS_MOUNT_POINT = envVars.EFS_MOUNT_POINT

export class PathManager {
  private static instance: PathManager
  private environment: string
  private botUuid: string
  private isServerless: boolean

  private constructor() {
    const global = GLOBAL.get()
    this.environment = envVars.ENVIRON
    this.isServerless = envVars.SERVERLESS
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

  public getBasePath(): string {
    if (this.isServerless) {
      return path.join("./data", this.botUuid)
    }
    switch (this.environment) {
      case "prod":
        return path.join(EFS_MOUNT_POINT, "prod", this.botUuid)
      case "preprod":
        return path.join(EFS_MOUNT_POINT, "preprod", this.botUuid)
      default:
        return path.join("./data", this.botUuid)
    }
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

  public getS3Paths(): { bucketName: string; s3Path: string } {
    const identifier = this.getIdentifier()
    return {
      bucketName: envVars.AWS_S3_ARTIFACTS_BUCKET,
      s3Path: `${identifier}`
    }
  }
}
