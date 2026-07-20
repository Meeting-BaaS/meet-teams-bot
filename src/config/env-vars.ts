import dotenv from "dotenv"
import { bool, cleanEnv, num, port, str } from "envalid"

dotenv.config()

export const envVars = cleanEnv(process.env, {
  PORT: port({ default: 8080 }),
  HOST: str({ default: "0.0.0.0" }),
  NODE_ENV: str({
    choices: ["development", "production", "test"],
    default: "development"
  }),
  // Custom key for Environment
  ENVIRON: str({ choices: ["local", "preprod", "prod"], default: "local" }),
  LOG_LEVEL: str({
    choices: ["error", "warn", "info", "debug"],
    default: "info"
  }),
  API_SERVER_BASEURL: str({ default: "http://localhost:3001" }),
  SERVERLESS: bool({ default: false }),
  CHROME_PATH: str({ default: "/usr/bin/google-chrome" }),
  AWS_S3_LOGS_BUCKET: str({ default: "meeting-baas-logs" }),
  AWS_S3_ARTIFACTS_BUCKET: str({ default: "meeting-baas-artifacts" }),
  AWS_S3_AUDIO_CHUNKS_BUCKET: str({ default: "meeting-baas-audio-chunks" }),
  DISPLAY: str({ default: ":99" }),
  VIRTUAL_SPEAKER_MONITOR: str({ default: "virtual_speaker.monitor" }),
  VIRTUAL_MIC: str({ default: "virtual_mic" }),
  VIRTUAL_SPEAKER: str({ default: "virtual_speaker" }),
  VIDEO_DEVICE: str({ default: "/dev/video10" }),
  EFS_MOUNT_POINT: str({ default: "/mnt/efs" }),
  RESOLUTION: str({ choices: ["720", "1080"], default: "720" }),
  UPLOAD_AUDIO_CHUNKS: bool({ default: false }),
  UPLOAD_RAW_VIDEO: bool({ default: false }),
  // Override output directory for serverless mode (e.g., when using run_bot.sh)
  OUTPUT_BASE_DIR: str({ default: "" }),
  // Skip object tagging on S3 uploads. @aws-sdk/lib-storage's Upload class
  // fires a separate PutObjectTagging API call after the body completes
  // (for both single-shot PutObject and multipart paths). GCS's S3-compat
  // XML API doesn't implement that endpoint, so every upload's body lands
  // correctly in the bucket but Upload.done() rejects — the catch block
  // then logs a failure and falls back to EFS even though the data is
  // already in S3. Flip this to true on GCS/R2/other tagless S3-compat
  // providers so lib-storage skips the post-upload tagging call.
  //
  // This is a lib-storage-specific quirk. Other services in the stack
  // (api-server, zoom-bot) aren't affected because they pass tags as
  // `x-amz-tagging` header on PutObject/CreateMultipartUpload (via
  // `PutObjectCommand({ Tagging: "k=v" })` in JS and `.tagging("k=v")`
  // on the Rust aws-sdk-s3-transfer-manager), which GCS accepts.
  DISABLE_S3_OBJECT_TAGGING: bool({ default: false }),
  // Decodo (and similar) backconnect-style residential proxy template. The
  // {SESSION} placeholder is substituted at runtime with the bot's UUID
  // (hyphens stripped) so each bot pod gets a sticky residential IP while
  // different bots naturally land on different IPs from the pool.
  // Format example:
  //   http://user-<USER>-continent-eu-session-{SESSION}:<PASS>@gate.decodo.com:7000
  // Leave empty to disable residential proxy.
  RESIDENTIAL_PROXY_TEMPLATE: str({ default: "" }),
  // Read-only diagnostic gate. When true, the fingerprint probe dumps the
  // runtime navigator / WebGL / font-list / geometry the page's JS actually
  // sees (into html_snapshots/, uploaded to the log bucket) so we can measure
  // what a detector saw at a block instead of inferring it from config. Off in
  // prod by default; flip on a single bot to reproduce a wall.
  BROWSER_DEBUG_CAPTURE: bool({ default: false }),
  // Use Firefox instead of Chromium/CloakBrowser. When true, launches Firefox
  // via Playwright to test if Zoom's ISP blocking also affects Firefox browsers.
  USE_FIREFOX: bool({ default: false }),
  // FORCE the stealthfox patched Firefox for ALL platforms (A/B override).
  // Normally leave false and let STEALTHFOX_PLATFORMS scope it per platform.
  // Either way needs STEALTHFOX_BINARY_PATH. Takes precedence over USE_FIREFOX.
  USE_STEALTHFOX: bool({ default: false }),
  // Which platforms launch stealthfox by default — comma-separated
  // (e.g. "zoom", "zoom,meet", or "all"). Zoom-only by default; expanding to
  // meet/teams later is a one-value change. Only takes effect when
  // STEALTHFOX_BINARY_PATH is set, so local/dev without the binary is unaffected.
  STEALTHFOX_PLATFORMS: str({ default: "zoom" }),
  // Absolute path to the stealthfox Firefox binary. Baked into the Docker image
  // at /opt/stealthfox/<tag>/firefox by scripts/fetch-stealthfox.sh. Empty =
  // stealthfox disabled (falls back to CloakBrowser).
  STEALTHFOX_BINARY_PATH: str({ default: "" }),
  // Zoom web only: how many times to relaunch the browser on a FRESH proxy exit
  // IP inside the SAME warm pod before falling back to the SQS requeue (fresh
  // pod). The anti-bot wall keys on the exit IP, so an in-pod relaunch on a new
  // residential IP clears it in ~5-10s vs the ~20-40s of a pod cold-start. 0
  // disables in-process retry entirely (pure requeue behavior). Envalid-validated
  // here; consumed/re-exported via config/retry-config.ts, the single retry-count
  // source (total-budget math lives there).
  IN_PROCESS_RETRY_MAX: num({ default: 2 })
})

export type EnvVars = typeof envVars
