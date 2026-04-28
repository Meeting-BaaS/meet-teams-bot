import * as fs from "node:fs"
import * as path from "node:path"
import { S3Client, type Tag } from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"
import { PathManager } from "./PathManager"

// Singleton instance
let instance: S3Uploader | null = null

// Controlled concurrency: process files in batches to avoid overwhelming the system
const MAX_CONCURRENT_UPLOADS = 100 // Limit concurrent uploads

// Wall-clock cap on a single S3 upload. The AWS SDK v3 Upload class has no
// total-time option; per-chunk request timeouts aren't enough because a hung
// peer (e.g. Scaleway's 2026-04-22 incident) will keep retrying parts
// indefinitely. Hitting this threshold aborts the in-flight multipart upload
// and throws, which lets the catch-block EFS fallback run.
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
      console.log("Skipping S3 uploader - serverless mode")
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
    options?: { skipEfsFallback?: boolean }
  ): Promise<void> {
    if (GLOBAL.isServerless()) {
      console.log("Skipping S3 upload - serverless mode")
      return
    }
    const dataRetentionDays = GLOBAL.get().data_retention_days

    try {
      // Convert tags object to S3 Tag[] format if provided
      const s3Tags: Tag[] = [
        {
          Key: "data_retention_days",
          Value: dataRetentionDays.toString()
        }
      ]

      if (tags) {
        Object.entries(tags).forEach(([Key, Value]) => {
          s3Tags.push({
            Key,
            Value
          })
        })
      }

      // Use Upload class for automatic multipart handling.
      // lib-storage fires a separate PutObjectTagging call after the body when
      // `tags` is set. Some S3-compat providers (GCS XML API) reject that with
      // NotImplemented even though the object body uploads fine — every upload
      // then reports failure despite the data being in the bucket. Skip tags on
      // those providers via DISABLE_S3_OBJECT_TAGGING.
      // api-server and zoom-bot aren't affected because they pass tags inline
      // on PutObject/CreateMultipartUpload (x-amz-tagging header), which GCS
      // does accept — only lib-storage's Upload takes the separate-API-call
      // route. See env-vars.ts for the fuller rationale.
      //
      // Note: when DISABLE_S3_OBJECT_TAGGING is true the `data_retention_days`
      // tag is no longer attached, so retention on that provider must be
      // enforced out-of-band (e.g. GCS-native Object Lifecycle Management on
      // the bucket, configured at deploy time to match the product's policy).
      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: bucketName,
          Key: s3Path,
          Body: fs.createReadStream(filePath)
        },
        ...(envVars.DISABLE_S3_OBJECT_TAGGING ? {} : { tags: s3Tags })
      })

      let timeoutHandle: NodeJS.Timeout | null = null
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          upload.abort().catch((abortErr) => {
            // Best-effort — the reject below is what actually signals the
            // timeout to the caller. If abort itself fails, there may be a
            // lingering multipart upload on the bucket (7-day cleanup policy
            // on Scaleway) so log it for investigation rather than swallow.
            console.warn(`⚠️ upload.abort() failed for ${s3Path}: ${abortErr}`)
          })
          reject(new Error(`S3 upload exceeded ${UPLOAD_TIMEOUT_MS}ms for ${s3Path}`))
        }, UPLOAD_TIMEOUT_MS)
      })

      try {
        await Promise.race([upload.done(), timeoutPromise])
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }
    } catch (error) {
      if (options?.skipEfsFallback) {
        // Caller (e.g. screenshots) opted out of EFS preservation. These
        // artifacts are debug-grade and not worth the EFS storage / log noise.
        console.warn(`❌ S3 upload failed (no EFS fallback): ${s3Path} — ${error}`)
      } else {
        console.warn(`❌ S3 upload failed, falling back to EFS: ${error}`)
        // Best-effort EFS mirror so a later reconciliation job can push to S3.
        await this.copyToEFS(filePath, s3Path)
      }
      // Rethrow so callers (ScreenRecorder, cleanup-state, uploadDirectory)
      // can record the artifact as uploaded:false with UPLOAD_FAILED. Without
      // this rethrow they'd see a successful return and mark metadata as
      // uploaded:true with a valid s3Key even though the object is only on
      // EFS — consumers fetching via s3Key would 404 until reconciliation.
      throw error
    }
  }

  public async uploadToDefaultBucket(filePath: string, s3Path: string): Promise<void> {
    if (GLOBAL.isServerless()) {
      console.log("Skipping S3 upload - serverless mode")
      return
    }

    const bucket = envVars.AWS_S3_LOGS_BUCKET
    if (!bucket) {
      console.warn("Skipping S3 upload - aws_s3_log_bucket not configured")
      return
    }
    await this.uploadFile(filePath, bucket, s3Path)
  }

  public async uploadDirectory(
    localDir: string,
    bucketName: string,
    s3Path: string,
    options?: { skipEfsFallback?: boolean }
  ): Promise<void> {
    if (GLOBAL.isServerless()) {
      console.log("Skipping S3 upload - serverless mode")
      return
    }

    try {
      // Get list of files in local directory (flat structure, no recursion needed)
      const items = await fs.promises.readdir(localDir, {
        withFileTypes: true
      })
      const files = items
        .filter((item) => item.isFile())
        .map((item) => path.join(localDir, item.name))

      if (files.length === 0) {
        console.log("No files found in directory:", localDir)
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
        const totalBatches = Math.ceil(files.length / MAX_CONCURRENT_UPLOADS)

        console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} files)...`)

        // Upload batch concurrently using our existing uploadFile function
        const batchPromises = batch.map(async (file) => {
          const filename = path.basename(file)
          const s3Key = `${s3Path}/${filename}`

          try {
            await this.uploadFile(file, bucketName, s3Key, undefined, options)
            return { success: true, file: filename }
          } catch (error) {
            // Error is already logged in uploadFile
            return {
              success: false,
              file: filename,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        })

        // Wait for batch to complete before starting next batch
        const batchResults = await Promise.all(batchPromises)
        const batchSuccesses = batchResults.filter((r) => r.success).length
        const batchFailures = batchResults.length - batchSuccesses

        console.log(
          `Batch ${batchNumber} complete: ${batchSuccesses} successful, ${batchFailures} failed`
        )

        // Collect results
        results.push(...batchResults)
      }

      // Count total successes and failures
      const successful = results.filter((r) => r.success).length
      const failed = results.filter((r) => !r.success).length

      console.log(`Total upload summary: ${successful} successful, ${failed} failed`)

      if (failed > 0) {
        throw new Error(`Bulk upload completed with ${failed} failures`)
      }
    } catch (error) {
      console.error("S3 sync error:", error)
      throw error
    }
  }

  /**
   * Fallback when a single S3 upload fails. Copies the file under the EFS
   * s3_upload_fails prefix (see PathManager.getEfsPath) preserving the
   * intended s3 key so a later reconciliation job can push it to S3.
   *
   * No-op in local/dev and serverless modes. Errors are logged but swallowed
   * so the caller can keep draining other uploads.
   */
  private async copyToEFS(filePath: string, s3Path: string): Promise<void> {
    try {
      if (GLOBAL.isServerless()) return
      const env = envVars.ENVIRON
      if (env === "local") {
        console.warn(`⚠️ EFS not available in ${env} environment - file will remain on local disk`)
        return
      }
      const efsBase = PathManager.getInstance().getEfsPath()
      // efsBase already scopes to the bot UUID (/mnt/efs/<env>/s3_upload_fails/<uuid>).
      // Callers' s3Path usually starts with `<uuid>/` (keys are built as
      // `${identifier}/<subpath>`), which would produce `<uuid>/<uuid>/…` on join.
      // Strip the redundant prefix so the on-disk layout matches sqs-consumer's
      // fallbackToEfs and this module's copyDirToEFS (single-UUID nesting).
      const botUuid = PathManager.getInstance().getIdentifier()
      const relativeKey = s3Path.startsWith(`${botUuid}/`)
        ? s3Path.slice(botUuid.length + 1)
        : s3Path
      const efsFilePath = path.join(efsBase, relativeKey)
      const efsDir = path.dirname(efsFilePath)
      await fs.promises.mkdir(efsDir, { recursive: true })
      await fs.promises.copyFile(filePath, efsFilePath)
      console.log(`📁 File copied to EFS: ${efsFilePath}`)
    } catch (error) {
      console.error(`❌ Failed to copy file to EFS: ${error}`)
    }
  }

  /**
   * Recursively copy the bot's entire working directory (typically
   * PathManager.getBasePath()) to EFS under the same `s3_upload_fails/{uuid}/`
   * prefix sqs-consumer already uses. Intended as a last-resort safety net
   * when cleanup-state's outer timeout fires: the pipeline may have finished
   * building output.mp4 / output.flac but uploads hung past the outer
   * timeout, which means the per-file copyToEFS in this module never ran for
   * those files. This dump captures whatever's on disk so a reconciliation
   * job that already scans s3_upload_fails/ picks it up uniformly.
   *
   * No-op in local and serverless modes. Errors are logged but swallowed so
   * cleanup can continue into Terminated without blocking.
   */
  public async copyDirToEFS(localDir: string): Promise<void> {
    try {
      if (GLOBAL.isServerless()) return
      const env = envVars.ENVIRON
      if (env === "local") {
        console.warn(`⚠️ EFS not available in ${env} environment - skipping dir copy`)
        return
      }
      if (!fs.existsSync(localDir)) {
        console.warn(`⚠️ Local dir does not exist, skipping EFS copy: ${localDir}`)
        return
      }
      const efsDst = PathManager.getInstance().getEfsPath()
      console.log(`📁 Copying ${localDir} → ${efsDst} (cleanup-timeout safety net)`)
      await fs.promises.mkdir(efsDst, { recursive: true })
      await fs.promises.cp(localDir, efsDst, { recursive: true, force: true, errorOnExist: false })
      console.log(`📁 Directory copied to EFS: ${efsDst}`)
    } catch (error) {
      console.error(`❌ Failed to copy dir to EFS: ${error}`)
    }
  }
}

// Export utility functions that use the singleton instance
export const s3cp = (local: string, s3path: string): Promise<void> =>
  S3Uploader.getInstance().uploadToDefaultBucket(local, s3path)
