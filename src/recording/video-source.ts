/**
 * Video input/output arguments for the recording FFmpeg.
 *
 * Capturing and encoding the virtual display is the single largest steady CPU
 * draw of a bot. For `audio_only` recordings the frames are never delivered to
 * the customer, so paying that cost is pure waste, and on the heavier meeting
 * clients the contention can starve the browser's audio threads.
 *
 * For audio_only we feed a realtime synthetic static frame instead of x11grab.
 * This keeps the existing sync/merge/trim/duration pipeline intact (the "video"
 * is discarded before upload) while removing screen capture and making the
 * encode negligible.
 */

export interface RecordingResolution {
  width: number
  height: number
  captureHeight: number
}

/** Synthetic source for audio_only: small and slow on purpose. */
export const AUDIO_ONLY_VIDEO_FPS = 2
export const AUDIO_ONLY_VIDEO_WIDTH = 320
export const AUDIO_ONLY_VIDEO_HEIGHT = 180

/**
 * Input #0 (the video stream). x11grab for normal recordings; a realtime
 * synthetic frame for audio_only. `-re` paces the lavfi source at its native
 * rate so its timeline matches wall-clock time like x11grab does.
 */
export function buildVideoInputArgs(
  audioOnly: boolean,
  res: RecordingResolution,
  display: string
): string[] {
  if (audioOnly) {
    return [
      "-re",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${AUDIO_ONLY_VIDEO_WIDTH}x${AUDIO_ONLY_VIDEO_HEIGHT}:r=${AUDIO_ONLY_VIDEO_FPS}`
    ]
  }
  return [
    "-f",
    "x11grab",
    "-video_size",
    `${res.width}x${res.captureHeight}`,
    "-thread_queue_size",
    "1024", // 1024 packets, ~34 s at 30 fps, generous without memory bloat
    "-framerate",
    "30",
    "-i",
    display
  ]
}

/**
 * Output #0 (raw video). Normal recordings encode the cropped screen; audio_only
 * encodes the synthetic frame with the cheapest possible settings. `-g 1` keeps
 * every frame a keyframe so the later copy-mode trims stay exact.
 */
export function buildVideoOutputArgs(
  audioOnly: boolean,
  res: RecordingResolution,
  rawVideoPath: string
): string[] {
  if (audioOnly) {
    return [
      "-map",
      "0:v:0",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "35",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "1",
      "-keyint_min",
      "1",
      "-bf",
      "0",
      "-refs",
      "1",
      "-avoid_negative_ts",
      "make_zero",
      "-f",
      "mp4",
      "-y",
      rawVideoPath
    ]
  }
  return [
    "-map",
    "0:v:0",
    "-c:v",
    "libx264",
    "-preset",
    // veryfast: ~40% less encoder CPU than "fast" at the same crf, with
    // near-identical visual quality on meeting content (mostly static
    // talking heads / shared screens). Output is ~10-15% larger, which is
    // cheap S3 vs compute: the encoder is the biggest steady CPU draw of
    // the bot, and lower per-bot CPU lets more bots share a node.
    "veryfast",
    "-crf",
    "23",
    "-profile:v",
    "main",
    "-level",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "20", // Keyframe every 20 frames (1 sec at 20fps) for precise trimming
    "-keyint_min",
    "20", // Force minimum keyframe interval
    "-bf",
    "0",
    "-refs",
    "1",
    "-vf",
    `crop=${res.width}:${res.height}:0:140`,
    "-avoid_negative_ts",
    "make_zero",
    "-f",
    "mp4",
    "-y",
    rawVideoPath
  ]
}
