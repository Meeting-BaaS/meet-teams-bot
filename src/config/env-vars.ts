import dotenv from "dotenv"
import { bool, cleanEnv, makeValidator, port, str } from "envalid"

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
  EFS_MOUNT_POINT: str({ default: "/mnt/efs" })
})

export type EnvVars = typeof envVars
