import * as fs from 'fs/promises'
import * as path from 'path'
import { GLOBAL } from '../singleton'

const EFS_MOUNT_POINT = process.env.EFS_MOUNT_POINT || '/mnt/efs'

export class PathManager {
    private static instance: PathManager
    private environment: string
    private botUuid: string
    private isServerless: boolean

    private constructor() {
        let global = GLOBAL.get()
        this.environment = global.environ
        this.isServerless = GLOBAL.isServerless()
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
            this.getHtmlSnapshotsPath(),
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
        return path.join('./recordings', this.botUuid)
    }

    public getOutputPath(): string {
        return path.join(this.getBasePath(), 'output')
    }

    public getAudioTmpPath(): string {
        return path.join(this.getBasePath(), 'audio_tmp')
    }

    public getSpeakerLogPath(): string {
        return path.join(this.getBasePath(), 'speaker_separation.log')
    }

    public getSoundLogPath(): string {
        return path.join(this.getBasePath(), 'sound_levels.log')
    }

    public getTempPath(): string {
        return path.join(this.getBasePath(), 'temp')
    }

    public getScreenshotsPath(): string {
        return path.join(this.getBasePath(), 'screenshots')
    }

    public getHtmlSnapshotsPath(): string {
        return path.join(this.getBasePath(), 'html_snapshots')
    }

    public getS3Paths(): { bucketName: string; s3Path: string } {
        const identifier = this.getIdentifier()
        return {
            bucketName: process.env.AWS_S3_VIDEO_BUCKET || '',
            s3Path: `${identifier}`,
        }
    }
}
