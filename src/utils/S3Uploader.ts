import * as fs from "node:fs"
import * as path from "node:path"
import type { Tag } from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { envVars } from "../config/env-vars"
import { storageBuckets, storageS3Client, transientSpillAllowed } from "../config/storage"
import { GLOBAL } from "../singleton"
import type { ArtifactType } from "../types"
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
  // No cached client field on purpose. This singleton can be constructed before the
  // meeting params are parsed (an early log upload does exactly that), and a client
  // captured at that point would be the platform one — every later upload for a
  // customer-storage bot would then land in OUR bucket. storageS3Client() resolves
  // per call and rebuilds once the customer's config is known. See config/storage.ts.
  private constructor() {}

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
        client: storageS3Client(),
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
      } else if (!transientSpillAllowed()) {
        // The team's own storage with transient spill off: this artifact is not
        // allowed to rest on our volume, so the failure is final. Say so plainly —
        // the recording is gone, and a log line that reads like the EFS path ran
        // would send whoever investigates looking for a file that was never written.
        console.error(
          `❌ S3 upload failed and transient spill is disabled for this team — artifact abandoned: ${s3Path} — ${error}`
        )
      } else {
        console.warn(`❌ S3 upload failed, falling back to EFS: ${error}`)
        // Best-effort EFS mirror so a later reconciliation job can push to S3.
        await this.copyToEFS(filePath, bucketName, s3Path)
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

    const bucket = storageBuckets().logs
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
   * Fallback when a single S3 upload fails. Copies the file under the
   * bucket-segmented EFS prefix
   * (/mnt/efs/<env>/s3_upload_fails/<bucket>/<uuid>/<key>) preserving the
   * intended bucket + s3 key so the reconciliation job can push it back to the
   * exact destination with no DB lookup.
   *
   * No-op in local/dev and serverless modes. Errors are logged but swallowed
   * so the caller can keep draining other uploads.
   */
  private async copyToEFS(filePath: string, bucketName: string, s3Path: string): Promise<void> {
    try {
      if (GLOBAL.isServerless()) return
      // Second gate, in case a future caller reaches this without the check above.
      if (!transientSpillAllowed()) return
      const env = envVars.ENVIRON
      if (env === "local") {
        console.warn(`⚠️ EFS not available in ${env} environment - file will remain on local disk`)
        return
      }
      const efsBase = PathManager.getInstance().getEfsPathForBucket(bucketName)
      // efsBase scopes to <bucket>/<uuid> (/mnt/efs/<env>/s3_upload_fails/<bucket>/<uuid>).
      // Callers' s3Path usually starts with `<uuid>/` (keys are built as
      // `${identifier}/<subpath>`), which would produce `<uuid>/<uuid>/…` on join.
      // Strip the redundant prefix so the on-disk layout is <bucket>/<uuid>/<key>;
      // the reconciliation job reconstructs the s3 key as <uuid>/<key>.
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
   * Last-resort safety net when cleanup-state's outer timeout fires: the
   * pipeline may have finished building output.mp4 / output.flac but uploads
   * hung past the timeout, so the per-file copyToEFS never ran. Mirror the known
   * final outputs to the same bucket-segmented EFS layout copyToEFS uses
   * (s3_upload_fails/<bucket>/<uuid>/<key>) so the reconciliation job drains them
   * with no filename guessing. Only known artifacts are mirrored — intermediate
   * / temp files are intentionally left behind.
   *
   * Each mirrored output is also recorded in GLOBAL as a recoverable upload
   * failure, so the end-meeting trampoline defers the bot to
   * `awaiting_reconciliation` — the only status the reconciliation job scans.
   * Without that the files would sit on EFS while the bot completes, and nothing
   * would ever drain them.
   *
   * No-op in local and serverless modes. Errors are logged but swallowed so
   * cleanup can continue into Terminated without blocking.
   */
  public async copyDirToEFS(localDir: string): Promise<void> {
    try {
      if (GLOBAL.isServerless()) return
      // Same residency gate as copyToEFS. Without it the cleanup-timeout safety net
      // would quietly undo the guarantee the per-file path just honoured, mirroring
      // output.mp4 / output.flac / diarization / chunks onto our volume.
      if (!transientSpillAllowed()) {
        console.warn(
          "⚠️ Cleanup timeout with un-uploaded outputs, but transient spill is disabled for this team — not mirroring to EFS"
        )
        return
      }
      const env = envVars.ENVIRON
      if (env === "local") {
        console.warn(`⚠️ EFS not available in ${env} environment - skipping dir copy`)
        return
      }
      if (!fs.existsSync(localDir)) {
        console.warn(`⚠️ Local dir does not exist, skipping EFS copy: ${localDir}`)
        return
      }

      const pm = PathManager.getInstance()
      const outputBase = pm.getOutputPath()
      const artifactsBucket = storageBuckets().artifacts

      // Named final outputs → artifacts bucket (key <uuid>/<name>, matching the
      // bot's real S3 keys).
      const namedOutputs: Array<{
        src: string
        name: string
        type: ArtifactType
        extension: string
      }> = [
        { src: `${outputBase}.mp4`, name: "output.mp4", type: "video", extension: "mp4" },
        { src: `${outputBase}.flac`, name: "output.flac", type: "audio", extension: "flac" },
        {
          src: path.join(pm.getTempPath(), "diarization.jsonl"),
          name: "diarization.jsonl",
          type: "diarization",
          extension: "jsonl"
        },
        {
          src: path.join(pm.getBasePath(), "chat_messages.json"),
          name: "chat_messages.json",
          type: "chat_messages",
          extension: "json"
        }
      ]
      for (const { src, name, type, extension } of namedOutputs) {
        if (await this.mirrorFileToEFS(src, artifactsBucket, name)) {
          this.recordPendingArtifact(src, extension, type)
        }
      }

      // Audio chunks → audio chunks bucket (key <uuid>/<filename>).
      const chunksDir = pm.getAudioTmpPath()
      if (fs.existsSync(chunksDir)) {
        for (const filename of fs.readdirSync(chunksDir)) {
          const src = path.join(chunksDir, filename)
          if (await this.mirrorFileToEFS(src, storageBuckets().audioChunks, filename)) {
            this.recordPendingChunk(src, filename)
          }
        }
      }
    } catch (error) {
      console.error(`❌ Failed to mirror outputs to EFS: ${error}`)
    }
  }

  /**
   * Copy a single known output to its bucket-segmented EFS path
   * (s3_upload_fails/<bucket>/<uuid>/<key>). Returns true once the file is
   * mirrored, false if the source is missing or the copy failed. Errors are
   * logged but swallowed so the caller can keep mirroring.
   */
  private async mirrorFileToEFS(src: string, bucket: string, key: string): Promise<boolean> {
    try {
      if (!fs.existsSync(src)) return false
      const dst = path.join(PathManager.getInstance().getEfsPathForBucket(bucket), key)
      await fs.promises.mkdir(path.dirname(dst), { recursive: true })
      await fs.promises.copyFile(src, dst)
      console.log(`📁 Mirrored to EFS (cleanup-timeout safety net): ${dst}`)
      return true
    } catch (error) {
      console.error(`❌ Failed to mirror ${src} to EFS: ${error}`)
      return false
    }
  }

  /**
   * Record a timed-out output as a recoverable upload failure so the end-meeting
   * trampoline defers the bot to `awaiting_reconciliation`. A file still on disk
   * at cleanup-timeout means its S3 upload never succeeded (the success paths
   * unlink). Skips if GLOBAL already has an entry for this artifact type (the
   * per-file upload path already recorded it, or it uploaded successfully).
   */
  private recordPendingArtifact(filePath: string, extension: string, type: ArtifactType): void {
    if (GLOBAL.getArtifactKeys().some((a) => a.type === type)) return
    GLOBAL.addArtifactKey({
      s3Key: null,
      filePath,
      extension,
      uploaded: false,
      uploadedAt: null,
      type,
      errorCode: "UPLOAD_FAILED",
      errorMessage: "Output mirrored to EFS after cleanup timeout; pending reconciliation"
    })
  }

  /**
   * recordPendingArtifact for an audio chunk. Dedups against chunks already
   * uploaded or already recorded (match by canonical key or local path), since
   * chunks are not unlinked on successful upload.
   */
  private recordPendingChunk(filePath: string, filename: string): void {
    const s3Key = `${PathManager.getInstance().getIdentifier()}/${filename}`
    if (GLOBAL.getAudioChunks().some((c) => c.s3Key === s3Key || c.filePath === filePath)) {
      return
    }
    GLOBAL.addAudioChunk({
      s3Key: null,
      filePath,
      extension: "flac",
      uploaded: false,
      uploadedAt: null,
      type: "audio",
      errorCode: "UPLOAD_FAILED",
      errorMessage: "Chunk mirrored to EFS after cleanup timeout; pending reconciliation"
    })
  }
}

// Export utility functions that use the singleton instance
export const s3cp = (local: string, s3path: string): Promise<void> =>
  S3Uploader.getInstance().uploadToDefaultBucket(local, s3path)
