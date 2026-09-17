import * as fs from "node:fs"

const INTERVAL_MS = Number(process.env.PROFILER_INTERVAL_MS ?? 10000)
const CLK_TCK = 100
const PAGE_KB = 4

type Sample = {
  pid: number
  name: string
  jiffies: number
  rssMb: number
  threads: number
}

function note(message: unknown): void {
  try {
    const text = message instanceof Error ? message.message : String(message)
    console.error(`[profiler] ${text}`)
  } catch {}
}

function label(pid: number, comm: string): string {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ")
    const type = cmd.match(/--type=(\w+)/)
    if (type) return `${comm} ${type[1]}`
    if (cmd.includes("-contentproc")) return `${comm} child`
    if (cmd.includes("x11grab")) return `${comm} recorder`
  } catch {}
  return comm
}

function read(pid: number): Sample | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const open = stat.indexOf("(")
    const close = stat.lastIndexOf(")")
    if (open < 0 || close <= open) return null
    const comm = stat.slice(open + 1, close)
    const f = stat.slice(close + 2).split(" ")
    const jiffies = Number(f[11]) + Number(f[12])
    const rssPages = Number(f[21])
    const threads = Number(f[17])
    if (!Number.isFinite(jiffies) || !Number.isFinite(rssPages)) return null
    return {
      pid,
      name: label(pid, comm),
      jiffies,
      rssMb: (rssPages * PAGE_KB) / 1024,
      threads: Number.isFinite(threads) ? threads : 0
    }
  } catch {
    return null
  }
}

function scan(): Sample[] {
  try {
    return fs
      .readdirSync("/proc")
      .filter((e) => /^\d+$/.test(e))
      .map((e) => read(Number(e)))
      .filter((s): s is Sample => s !== null)
  } catch (error) {
    note(error)
    return []
  }
}

let prev = new Map<number, number>()
let prevMs = Date.now()

function tick(): void {
  const now = Date.now()
  const dt = (now - prevMs) / 1000
  const next = new Map<number, number>()
  const rows: string[] = []
  let totalCpu = 0
  let totalMem = 0

  for (const s of scan()) {
    next.set(s.pid, s.jiffies)
    const before = prev.get(s.pid)
    let cpu = 0
    if (before !== undefined && dt > 0) {
      const delta = ((s.jiffies - before) / CLK_TCK / dt) * 100
      cpu = Number.isFinite(delta) && delta > 0 ? delta : 0
    }
    totalCpu += cpu
    totalMem += Number.isFinite(s.rssMb) ? s.rssMb : 0
    if (cpu < 0.5 && s.rssMb < 20) continue
    rows.push(
      `${String(s.pid).padStart(7)} ${(cpu / 100).toFixed(2).padStart(6)} ${cpu
        .toFixed(1)
        .padStart(7)} ${s.rssMb.toFixed(0).padStart(7)} ${String(s.threads).padStart(4)}  ${s.name}`
    )
  }

  console.log(
    `\n[${new Date(now).toISOString()}] cores=${(totalCpu / 100).toFixed(1)} cpu=${totalCpu.toFixed(
      0
    )}% mem=${totalMem.toFixed(0)}MB`
  )
  console.log("    PID  CORES    CPU%   RSS_MB  THR  NAME")
  console.log(rows.join("\n"))

  prev = next
  prevMs = now
}

process.stdout.on("error", () => {})
process.stderr.on("error", () => {})
process.on("uncaughtException", note)
process.on("unhandledRejection", note)

const every = Number.isFinite(INTERVAL_MS) && INTERVAL_MS >= 100 ? INTERVAL_MS : 10000
setInterval(() => {
  try {
    tick()
  } catch (error) {
    note(error)
  }
}, every)
