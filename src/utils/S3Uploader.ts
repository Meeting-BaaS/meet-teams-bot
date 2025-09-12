import { S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import * as fs from 'fs'
import * as path from 'path'
import { GLOBAL } from '../singleton'

// Singleton instance
let instance: S3Uploader | null = null

// Controlled concurrency: process files in batches to avoid overwhelming the system
const MAX_CONCURRENT_UPLOADS = 100 // Limit concurrent uploads

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
    ): Promise<void> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 upload - serverless mode')
            return
        }

        try {
            // Use Upload class for automatic multipart handling
            const upload = new Upload({
                client: this.s3Client,
                params: {
                    Bucket: bucketName,
                    Key: s3Path,
                    Body: fs.createReadStream(filePath),
                },
            })

            await upload.done()
        } catch (error) {
            console.error(
                `S3 upload error for ${filePath} bucket ${bucketName} s3Path ${s3Path}`,
                error,
            )
            throw error
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
                        await this.uploadFile(file, bucketName, s3Key)
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
}

// Export utility functions that use the singleton instance
export const s3cp = (local: string, s3path: string): Promise<void> =>
    S3Uploader.getInstance().uploadToDefaultBucket(local, s3path)
