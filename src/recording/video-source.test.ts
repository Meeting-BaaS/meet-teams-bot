import {
  AUDIO_ONLY_VIDEO_FPS,
  AUDIO_ONLY_VIDEO_HEIGHT,
  AUDIO_ONLY_VIDEO_WIDTH,
  buildVideoInputArgs,
  buildVideoOutputArgs
} from "./video-source"

const RES = { width: 1280, height: 720, captureHeight: 860 }

describe("recording video-source args", () => {
  describe("video mode", () => {
    it("captures the X display", () => {
      const args = buildVideoInputArgs(false, RES, ":99")
      expect(args).toContain("x11grab")
      expect(args).toContain(":99")
      expect(args).toContain("1280x860")
      expect(args).not.toContain("lavfi")
    })

    it("encodes the cropped screen", () => {
      const args = buildVideoOutputArgs(false, RES, "/tmp/raw.mp4")
      expect(args).toContain("crop=1280:720:0:140")
      expect(args).toContain("veryfast")
      expect(args).not.toContain("ultrafast")
    })
  })

  describe("audio_only mode", () => {
    it("does not capture the screen", () => {
      const args = buildVideoInputArgs(true, RES, ":99")
      expect(args).not.toContain("x11grab")
      expect(args).not.toContain(":99")
      expect(args).toContain("-re")
      expect(args).toContain("lavfi")
      expect(args).toContain(
        `color=c=black:s=${AUDIO_ONLY_VIDEO_WIDTH}x${AUDIO_ONLY_VIDEO_HEIGHT}:r=${AUDIO_ONLY_VIDEO_FPS}`
      )
    })

    it("encodes a cheap all-keyframe synthetic frame", () => {
      const args = buildVideoOutputArgs(true, RES, "/tmp/raw.mp4")
      expect(args).not.toContain("crop=1280:720:0:140")
      expect(args).toContain("ultrafast")
      // Every frame a keyframe keeps copy-mode trims exact.
      expect(args[args.indexOf("-g") + 1]).toBe("1")
      expect(args[args.indexOf("-keyint_min") + 1]).toBe("1")
    })
  })
})
