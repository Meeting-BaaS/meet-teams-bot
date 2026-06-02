// Replays recorded human mouse-motion ("mocap") during the Google Meet join so
// cursor movement looks human to reCAPTCHA-style behavioural scoring. Each
// recording is a real human join session: a flat list of mouse_move events
// (with per-event dt/dx/dy) punctuated by mouse_click down/up pairs. We split
// it into "primitives" — one run of moves leading up to a click, i.e. a single
// navigate-to-a-target-and-click gesture — and pick one whose summed
// displacement lands the cursor inside the target element's screen rect.
//
// Only 720p recordings are shipped (the only resolution in use). If the active
// resolution has no recordings, the manager loads empty and callers fall back
// to non-mocap input.

import * as fs from "fs"
import * as path from "path"

export interface MocapMovement {
  dt: number
  dx: number
  dy: number
  [key: string]: unknown
}

export interface PrimitiveMocapSequence {
  movements: MocapMovement[]
  totalDx: number
  totalDy: number
  clickDownDt: number
  clickUpDt: number
}

interface RawEvent {
  type: string
  dt?: number
  dx?: number
  dy?: number
  state?: string
  global_x?: number
  global_y?: number
}

// Rotational fan applied to every recorded primitive: 40 rotated copies in
// roughly [-5°, +5°]. This multiplies the pool of candidate endpoints so a
// low-distortion (near-natural) sequence is far more likely to land inside any
// given target rect, before we ever resort to stretching.
const PERTURBATION_COUNT = 40
const PERTURBATION_SPAN_DEGREES = 10
const PERTURBATION_MIN_DEGREES = -5

export class MocapManager {
  private sequences: PrimitiveMocapSequence[] = []
  private initialMousePosition: [number, number] | null = null

  constructor(private readonly frameHeight: number) {
    this.loadAllFiles()
    this.generatePerturbedSequences()
  }

  get sequenceCount(): number {
    return this.sequences.length
  }

  // First recorded cursor position (recording start), used to seed the mouse to
  // a realistic spot before the first humanised interaction.
  getInitialMousePosition(): [number, number] | null {
    return this.initialMousePosition
  }

  private loadAllFiles(): void {
    const dir = path.join(__dirname, "mocap")
    let files: string[]
    try {
      const re = new RegExp(`^join_mocap_${this.frameHeight}p_.*\\.json$`)
      files = fs
        .readdirSync(dir)
        .filter((f) => re.test(f))
        .sort()
    } catch (e) {
      console.error(`[mocap] cannot read mocap dir ${dir}:`, e)
      return
    }

    for (const file of files) {
      try {
        const events = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as RawEvent[]
        if (this.initialMousePosition === null && events.length > 0) {
          const first = events[0]
          this.initialMousePosition = [
            (first.global_x ?? 0) - (first.dx ?? 0),
            (first.global_y ?? 0) - (first.dy ?? 0)
          ]
        }
        const primitives = this.parsePrimitives(events)
        console.log(`[mocap] parsed ${primitives.length} primitives from ${file}`)
        this.sequences.push(...primitives)
      } catch (e) {
        console.error(`[mocap] failed to load ${file}:`, e)
      }
    }
  }

  private parsePrimitives(events: RawEvent[]): PrimitiveMocapSequence[] {
    const primitives: PrimitiveMocapSequence[] = []
    let current: MocapMovement[] = []
    let dxAcc = 0
    let dyAcc = 0
    let clickDownDt = 0

    for (const event of events) {
      if (event.type === "mouse_move") {
        current.push({ dt: event.dt ?? 0, dx: event.dx ?? 0, dy: event.dy ?? 0 })
        dxAcc += event.dx ?? 0
        dyAcc += event.dy ?? 0
      } else if (event.type === "mouse_click" && event.state === "down") {
        clickDownDt = event.dt ?? 0
      } else if (event.type === "mouse_click" && event.state === "up") {
        primitives.push({
          movements: current,
          totalDx: dxAcc,
          totalDy: dyAcc,
          clickDownDt,
          clickUpDt: event.dt ?? 0
        })
        current = []
        dxAcc = 0
        dyAcc = 0
        clickDownDt = 0
      }
    }

    return primitives
  }

  private generatePerturbedSequences(): void {
    const original = [...this.sequences]
    for (const seq of original) {
      for (let i = 0; i < PERTURBATION_COUNT; i++) {
        const angle =
          PERTURBATION_MIN_DEGREES + (PERTURBATION_SPAN_DEGREES / (PERTURBATION_COUNT + 1)) * (i + 1)
        if (angle === 0) continue
        this.sequences.push(this.transformSequence(seq, 1, angle))
      }
    }
    console.log(
      `[mocap] ${this.sequences.length} total sequences (incl. perturbations) at ${this.frameHeight}p`
    )
  }

  private transformSequence(
    seq: PrimitiveMocapSequence,
    scale: number,
    rotationDegrees: number
  ): PrimitiveMocapSequence {
    const rad = (rotationDegrees * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)

    let totalDx = 0
    let totalDy = 0
    const movements = seq.movements.map((mov) => {
      const sdx = mov.dx * scale
      const sdy = mov.dy * scale
      const ndx = Math.round(sdx * cos - sdy * sin)
      const ndy = Math.round(sdx * sin + sdy * cos)
      totalDx += ndx
      totalDy += ndy
      return { ...mov, dx: ndx, dy: ndy }
    })

    return {
      movements,
      totalDx,
      totalDy,
      clickDownDt: seq.clickDownDt,
      clickUpDt: seq.clickUpDt
    }
  }

  // Preferred path: pick a real (or lightly rotated) recorded sequence whose
  // natural endpoint already lands inside the target rect — zero or minimal
  // distortion, so the motion stays human.
  findRandomSequenceLandingInRect(
    currentX: number,
    currentY: number,
    rectLeft: number,
    rectTop: number,
    rectRight: number,
    rectBottom: number
  ): PrimitiveMocapSequence | null {
    const matching = this.sequences.filter((s) => {
      const fx = currentX + s.totalDx
      const fy = currentY + s.totalDy
      return rectLeft <= fx && fx <= rectRight && rectTop <= fy && fy <= rectBottom
    })
    if (matching.length === 0) return null
    return matching[Math.floor(Math.random() * matching.length)]
  }

  // Last-resort fallback (rare): no recorded endpoint lands in the rect, so take
  // the sequence whose natural displacement magnitude is closest to what's
  // needed and rotate+scale it (bounded) to aim at the rect centre. A
  // simplification of the ray-rect minimal-distortion search; bounded distortion
  // keeps the motion plausible.
  findClosestSequenceWithStretch(
    currentX: number,
    currentY: number,
    rectLeft: number,
    rectTop: number,
    rectRight: number,
    rectBottom: number
  ): PrimitiveMocapSequence | null {
    if (this.sequences.length === 0) return null

    const targetX = (rectLeft + rectRight) / 2
    const targetY = (rectTop + rectBottom) / 2
    const targetVx = targetX - currentX
    const targetVy = targetY - currentY
    const targetDist = Math.hypot(targetVx, targetVy)
    if (targetDist < 1) return null
    const targetAngle = Math.atan2(targetVy, targetVx)

    let best: PrimitiveMocapSequence | null = null
    let bestErr = Number.POSITIVE_INFINITY
    for (const s of this.sequences) {
      const d = Math.hypot(s.totalDx, s.totalDy)
      if (d < 1) continue
      const err = Math.abs(d - targetDist)
      if (err < bestErr) {
        bestErr = err
        best = s
      }
    }
    if (!best) return null

    const natDist = Math.hypot(best.totalDx, best.totalDy)
    const natAngle = Math.atan2(best.totalDy, best.totalDx)
    const scale = clamp(targetDist / natDist, 0.5, 2.0)
    const rotDeg = clamp(normalizeAngleDegrees(((targetAngle - natAngle) * 180) / Math.PI), -45, 45)
    return this.transformSequence(best, scale, rotDeg)
  }
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value))
}

function normalizeAngleDegrees(angle: number): number {
  return ((((angle + 180) % 360) + 360) % 360) - 180
}
