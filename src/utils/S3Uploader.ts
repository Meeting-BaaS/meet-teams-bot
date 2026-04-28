import { S3Client, Tag } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import * as fs from 'fs'
import * as path from 'path'
import { GLOBAL } from '../singleton'

const EFS_MOUNT_POINT = process.env.EFS_MOUNT_POINT || '/mnt/efs'

// Singleton instance
let instance: S3Uploader | null = null

// Controlled concurrency: process files in batches to avoid overwhelming the system
const MAX_CONCURRENT_UPLOADS = 100 // Limit concurrent uploads

// Wall-clock cap on a single S3 upload. AWS SDK v3's Upload class has no
// total-time option; per-chunk request timeouts aren't enough because a hung
// peer (e.g. Scaleway's 2026-04-22 incident) will keep retrying parts
// indefinitely. Hitting this threshold aborts the in-flight multipart upload
// and throws, which lets the catch-block EFS fallback fire.
const UPLOAD_TIMEOUT_MS = 25 * 60 * 1000 // 25 minutes

export class S3Uploader {
    private s3Client: S3Client

    private constructor() {
        // AWS SDK v3 automatically detects:
        // - Credentials from environment variables, IAM roles, AWS config files, etc.
        // - Endpoints from AWS_ENDPOINT_URL, AWS_ENDPOINT_URL_S3, etc.
        // - Regions from AWS_REGION, AWS_DEFAULT_REGION, etc.
        this.s3Client = new S3Client()
    }

    public static getInstance(): S3Uploader {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 uploader - serverless mode')
            return null
        }

        if (!instance) {
            instance = new S3Uploader()
        }
        return instance
    }

    public async uploadFile(
        filePath: string,
        bucketName: string,
        s3Path: string,
        tags?: Record<string, string>,
        options?: { skipEfsFallback?: boolean },
    ): Promise<void> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 upload - serverless mode')
            return
        }

        try {
            // Convert tags object to S3 Tag[] format if provided
            const s3Tags: Tag[] | undefined = tags
                ? Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))
                : undefined

            // Use Upload class for automatic multipart handling
            const upload = new Upload({
                client: this.s3Client,
                params: {
                    Bucket: bucketName,
                    Key: s3Path,
                    Body: fs.createReadStream(filePath),
                },
                ...(s3Tags && { tags: s3Tags }),
            })

            let timeoutHandle: NodeJS.Timeout | null = null
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    upload.abort().catch((abortErr) => {
                        // Best-effort — the reject below is what actually
                        // signals the timeout. If abort itself fails, there
                        // may be a lingering multipart upload on the bucket
                        // (Scaleway's 7-day incomplete-multipart cleanup will
                        // eventually reap it) so log for investigation rather
                        // than swallow.
                        console.warn(
                            `⚠️ upload.abort() failed for ${s3Path}: ${abortErr}`,
                        )
                    })
                    reject(
                        new Error(
                            `S3 upload exceeded ${UPLOAD_TIMEOUT_MS}ms for ${s3Path}`,
                        ),
                    )
                }, UPLOAD_TIMEOUT_MS)
            })

            try {
                await Promise.race([upload.done(), timeoutPromise])
            } finally {
                if (timeoutHandle) clearTimeout(timeoutHandle)
            }
            console.log(
                `✅ S3 upload successful: ${s3Path}${tags ? ` (with tags: ${JSON.stringify(tags)})` : ''}`,
            )
        } catch (error) {
            if (options?.skipEfsFallback) {
                // Caller (e.g. screenshots) opted out of EFS preservation. These
                // artifacts are debug-grade and not worth the EFS storage / log noise.
                console.warn(
                    `❌ S3 upload failed (no EFS fallback): ${s3Path} — ${error}`,
                )
            } else {
                console.warn(`❌ S3 upload failed, falling back to EFS: ${error}`)

                // Fallback to EFS with the same structure
                await this.copyToEFS(filePath, s3Path)
            }
        }
    }

    public async uploadToDefaultBucket(
        filePath: string,
        s3Path: string,
    ): Promise<void> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 upload - serverless mode')
            return
        }

        const bucket = GLOBAL.get().remote?.aws_s3_log_bucket
        if (!bucket) {
            console.warn(
                'Skipping S3 upload - aws_s3_log_bucket not configured',
            )
            return
        }
        await this.uploadFile(filePath, bucket, s3Path)
    }

    public async uploadDirectory(
        localDir: string,
        bucketName: string,
        s3Path: string,
        options?: { skipEfsFallback?: boolean },
    ): Promise<void> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 upload - serverless mode')
            return
        }

        try {
            // Get list of files in local directory (flat structure, no recursion needed)
            const items = await fs.promises.readdir(localDir, {
                withFileTypes: true,
            })
            const files = items
                .filter((item) => item.isFile())
                .map((item) => path.join(localDir, item.name))

            if (files.length === 0) {
                console.log('No files found in directory:', localDir)
                return
            }

            console.log(`Starting bulk upload of ${files.length} files...`)

            const results: Array<{
                success: boolean
                file: string
                error?: string
            }> = []

            // Process files in batches
            for (let i = 0; i < files.length; i += MAX_CONCURRENT_UPLOADS) {
                const batch = files.slice(i, i + MAX_CONCURRENT_UPLOADS)
                const batchNumber = Math.floor(i / MAX_CONCURRENT_UPLOADS) + 1
                const totalBatches = Math.ceil(
                    files.length / MAX_CONCURRENT_UPLOADS,
                )

                console.log(
                    `Processing batch ${batchNumber}/${totalBatches} (${batch.length} files)...`,
                )

                // Upload batch concurrently using our existing uploadFile function
                const batchPromises = batch.map(async (file) => {
                    const filename = path.basename(file)
                    const s3Key = `${s3Path}/${filename}`

                    try {
                        await this.uploadFile(file, bucketName, s3Key, undefined, options)
                        return { success: true, file: filename }
                    } catch (error: any) {
                        // Error is already logged in uploadFile
                        return {
                            success: false,
                            file: filename,
                            error: error.message,
                        }
                    }
                })

                // Wait for batch to complete before starting next batch
                const batchResults = await Promise.all(batchPromises)
                const batchSuccesses = batchResults.filter(
                    (r) => r.success,
                ).length
                const batchFailures = batchResults.length - batchSuccesses

                console.log(
                    `Batch ${batchNumber} complete: ${batchSuccesses} successful, ${batchFailures} failed`,
                )

                // Collect results
                results.push(...batchResults)
            }

            // Count total successes and failures
            const successful = results.filter((r) => r.success).length
            const failed = results.filter((r) => !r.success).length

            console.log(
                `Total upload summary: ${successful} successful, ${failed} failed`,
            )

            if (failed > 0) {
                throw new Error(`Bulk upload completed with ${failed} failures`)
            }
        } catch (error) {
            console.error('S3 sync error:', error)
            throw error
        }
    }

    private async copyToEFS(filePath: string, s3Path: string): Promise<void> {
        try {
            const global = GLOBAL.get()

            // Only use EFS for prod and preprod environments
            if (global.environ === 'dev' || global.environ === 'local') {
                console.warn(
                    `⚠️ EFS not available in ${global.environ} environment - file will remain on local disk`,
                )
                return
            }

            // Determine EFS environment path
            let efsEnvPath: string
            switch (global.environ) {
                case 'prod':
                    efsEnvPath = 'prod'
                    break
                case 'preprod':
                    efsEnvPath = 'preprod'
                    break
                default:
                    console.warn(
                        `⚠️ Unknown environment ${global.environ} - skipping EFS fallback`,
                    )
                    return
            }

            const efsBasePath = path.join(
                EFS_MOUNT_POINT,
                efsEnvPath,
                global.bot_uuid,
            )
            // efsBasePath already scopes to the bot UUID
            // (/mnt/efs/<env>/<uuid>). Callers' s3Path usually starts with
            // `<uuid>/` (keys are built as `${identifier}/<subpath>`), which
            // would produce `<uuid>/<uuid>/…` on join. Strip the redundant
            // prefix so the on-disk layout has a single UUID nesting.
            const relativeKey = s3Path.startsWith(`${global.bot_uuid}/`)
                ? s3Path.slice(global.bot_uuid.length + 1)
                : s3Path
            const efsFilePath = path.join(efsBasePath, relativeKey)
            const efsDir = path.dirname(efsFilePath)

            // Create EFS directory structure
            await fs.promises.mkdir(efsDir, { recursive: true })

            // Copy file to EFS
            await fs.promises.copyFile(filePath, efsFilePath)

            console.log(`📁 File copied to EFS: ${efsFilePath}`)
        } catch (error) {
            console.error(`❌ Failed to copy to EFS: ${error}`)
            throw error
        }
    }

    /**
     * Recursively copy an entire directory (typically the bot's `recordings/{uuid}/`
     * working dir) to EFS under `s3_upload_fails/{bot_uuid}/`. Used as a
     * last-resort safety net when cleanup hits its overall timeout and we need
     * to preserve whatever artifacts were built locally before the pod
     * terminates. Same prefix as per-file copyToEFS above, so a downstream
     * reconciliation job that scans s3_upload_fails/ handles both uniformly.
     *
     * No-op in local/dev environments. Errors are logged but swallowed so the
     * caller can continue into Terminated without blocking.
     */
    public async copyDirToEFS(localDir: string): Promise<void> {
        try {
            const global = GLOBAL.get()
            if (global.environ === 'dev' || global.environ === 'local') {
                console.warn(
                    `⚠️ EFS not available in ${global.environ} environment - skipping dir copy`,
                )
                return
            }

            let efsEnvPath: string
            switch (global.environ) {
                case 'prod':
                    efsEnvPath = 'prod'
                    break
                case 'preprod':
                    efsEnvPath = 'preprod'
                    break
                default:
                    console.warn(
                        `⚠️ Unknown environment ${global.environ} - skipping EFS dir copy`,
                    )
                    return
            }

            if (!fs.existsSync(localDir)) {
                console.warn(`⚠️ Local dir does not exist, skipping EFS copy: ${localDir}`)
                return
            }

            const efsBasePath = path.join(
                EFS_MOUNT_POINT,
                efsEnvPath,
                's3_upload_fails',
                global.bot_uuid,
            )
            console.log(
                `📁 Copying ${localDir} → ${efsBasePath} (cleanup-timeout safety net)`,
            )
            await fs.promises.mkdir(efsBasePath, { recursive: true })
            const copied = await copyDirRecursive(localDir, efsBasePath)
            console.log(
                `📁 Directory copied to EFS: ${efsBasePath} (${copied} files)`,
            )
        } catch (error) {
            // Best-effort — don't let an EFS failure block termination
            console.error(`❌ Failed to copy dir to EFS: ${error}`)
        }
    }
}

/**
 * Recursively copy `src` into `dst`, creating sub-directories as needed.
 * Manual walk because the project's pinned @types/node (14.x) predates
 * `fs.promises.cp`. Returns the number of files copied.
 */
async function copyDirRecursive(src: string, dst: string): Promise<number> {
    let count = 0
    const entries = await fs.promises.readdir(src, { withFileTypes: true })
    await fs.promises.mkdir(dst, { recursive: true })
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name)
        const dstPath = path.join(dst, entry.name)
        if (entry.isDirectory()) {
            count += await copyDirRecursive(srcPath, dstPath)
        } else if (entry.isFile()) {
            try {
                await fs.promises.copyFile(srcPath, dstPath)
                count++
            } catch (error) {
                // Log and continue — best-effort
                console.warn(`  skipped ${srcPath}: ${error}`)
            }
        }
        // Symlinks, sockets, etc. are skipped.
    }
    return count
}

// Export utility functions that use the singleton instance
export const s3cp = (local: string, s3path: string): Promise<void> =>
    S3Uploader.getInstance().uploadToDefaultBucket(local, s3path)
