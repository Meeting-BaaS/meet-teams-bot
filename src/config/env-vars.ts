import dotenv from "dotenv"
import { bool, cleanEnv, port, str } from "envalid"

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
  // Use the stealthfox (invisible_playwright) patched Firefox build. It IS a
  // Firefox binary launched through Playwright's firefox channel, so it reuses
  // the Firefox launch config; it adds a Juggler patch that humanizes mouse
  // paths (gated on the `stealthfox.humanize` pref) and honors STEALTHFOX_WEBRTC_*
  // env for srflx spoofing. Takes precedence over USE_FIREFOX.
  USE_STEALTHFOX: bool({ default: false }),
  // Absolute path to the stealthfox Firefox binary. Obtain with:
  //   python -m invisible_playwright fetch   # downloads ~100MB, SHA256-verified, cached
  //   python -m invisible_playwright path     # prints this path
  // Required when USE_STEALTHFOX=true.
  STEALTHFOX_BINARY_PATH: str({ default: "" })
})

export type EnvVars = typeof envVars
