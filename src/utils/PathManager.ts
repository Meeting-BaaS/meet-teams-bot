import * as fs from 'fs/promises'
import * as path from 'path'
import { GLOBAL } from '../singleton'

const EFS_MOUNT_POINT = process.env.EFS_MOUNT_POINT || '/mnt/efs'

export class PathManager {
    private static instance: PathManager
    private environment: string
    private botUuid: string | null
    private isServerless: boolean

    private constructor() {
        let global = GLOBAL.get()
        this.environment = process.env.NODE_ENV || 'local' // Use NODE_ENV instead of global.environ
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
            this.getOutputPath(),
            this.getAudioPath(),
            this.getLogsPath(),
            this.getLocalPath(),
            this.getScreenshotsPath(),
            this.getHtmlSnapshotsPath(),
        ]

        for (const p of paths) {
            try {
                await fs.mkdir(p, { recursive: true, mode: 0o777 })
                console.log(`Created directory: ${p}`)
            } catch (error) {
                console.error(`Failed to create directory ${p}:`, error)
                throw error
            }
        }
    }

    public getBasePath(): string {
        if (this.isServerless) {
            // In Docker container, use /app/data (mounted volume)
            // In local development, use ./data
            const dataPath =
                process.env.NODE_ENV === 'production' ? '/app/data' : './data'
            return path.join(dataPath, this.botUuid)
        }
        switch (this.environment) {
            case 'prod':
                return path.join(EFS_MOUNT_POINT, 'prod', this.botUuid)
            case 'preprod':
                return path.join(EFS_MOUNT_POINT, 'preprod', this.botUuid)
            default:
                return path.join('./data', this.botUuid)
        }
    }

    public getOutputPath(): string {
        return path.join(this.getBasePath(), 'deliverables')
    }

    public getAudioPath(): string {
        return path.join(this.getBasePath(), 'audio')
    }

    public getLogsPath(): string {
        return path.join(this.getBasePath(), 'logs')
    }

    public getSpeakerLogPath(): string {
        return path.join(this.getLogsPath(), 'speaker_separation.log')
    }

    public getSoundLogPath(): string {
        return path.join(this.getLogsPath(), 'sound_levels.log')
    }

    public getLocalPath(): string {
        return path.join(this.getBasePath(), 'local')
    }

    public getScreenshotsPath(): string {
        return path.join(this.getLogsPath(), 'screenshots')
    }

    public getHtmlSnapshotsPath(): string {
        return path.join(this.getLogsPath(), 'html_snapshots')
    }

    public getS3Paths(): { bucketName: string; s3Path: string } {
        return {
            bucketName: process.env.AWS_S3_DELIVERABLES_BUCKET || '',
            s3Path: `${this.botUuid}`,
        }
    }
}
