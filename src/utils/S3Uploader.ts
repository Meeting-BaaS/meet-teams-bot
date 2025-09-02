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

    private async checkFileExists(filePath: string): Promise<void> {
        try {
            await fs.promises.access(filePath, fs.constants.F_OK)
        } catch (error) {
            throw new Error(`File does not exist: ${filePath}`)
        }
    }

    public async uploadFile(
        filePath: string,
        bucketName: string,
        s3Path: string,
        metadata?: Record<string, string>,
    ): Promise<string> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 upload - serverless mode')
            return Promise.resolve('')
        }

        try {
            await this.checkFileExists(filePath)

            console.log(
                `🔍 S3 upload: ${filePath} -> s3://${bucketName}/${s3Path}`,
            )

            // Use Upload class for automatic multipart handling
            const upload = new Upload({
                client: this.s3Client,
                params: {
                    Bucket: bucketName,
                    Key: s3Path,
                    Body: fs.createReadStream(filePath),
                    ...(metadata && { Metadata: metadata }), // Add metadata if provided
                },
            })

            await upload.done()

            // Return public URL (assuming public access)
            const endpoint = process.env.AWS_ENDPOINT || 's3.amazonaws.com'
            const publicUrl = `https://${bucketName}.${endpoint}/${s3Path}`

            console.log(`✅ S3 upload completed: ${publicUrl}`)
            return publicUrl
        } catch (error: any) {
            console.error(`S3 upload error for ${filePath}:`, error)
            throw error
        }
    }

    public async uploadToDefaultBucket(
        filePath: string,
        s3Path: string,
    ): Promise<string> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 upload - serverless mode')
            return Promise.resolve('')
        }

        try {
            return await this.uploadFile(
                filePath,
                GLOBAL.getS3LogsBucket(),
                s3Path,
            )
        } catch (error: any) {
            console.error('Failed to upload to default bucket:', error.message)
            throw error
        }
    }

    public async uploadDirectory(
        localDir: string,
        bucketName: string,
        s3Path: string,
    ): Promise<string> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping S3 upload - serverless mode')
            return Promise.resolve('')
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
                return ''
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

            // Return base URL
            const endpoint = process.env.AWS_ENDPOINT || 's3.amazonaws.com'
            return `https://${bucketName}.${endpoint}/${s3Path}`
        } catch (error: any) {
            console.error('S3 sync error:', error)
            throw error
        }
    }
}

// Export utility functions that use the singleton instance
export const s3cp = (local: string, s3path: string): Promise<string> =>
    S3Uploader.getInstance().uploadToDefaultBucket(local, s3path)
