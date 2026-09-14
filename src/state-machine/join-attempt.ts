import { AsyncLocalStorage } from "node:async_hooks"

// Tags provider code with its join attempt, so GLOBAL can drop superseded writes.
const joinAttemptContext = new AsyncLocalStorage<{ attempt: number }>()

export function runInJoinAttempt<T>(attempt: number, fn: () => Promise<T>): Promise<T> {
  return joinAttemptContext.run({ attempt }, fn)
}

export function currentJoinAttemptId(): number | undefined {
  return joinAttemptContext.getStore()?.attempt
}

export type JoinPhaseInterruption = "deadline" | "stopped"

export class JoinPhaseInterrupted extends Error {
  constructor(
    readonly interruption: JoinPhaseInterruption,
    label: string
  ) {
    super(`${label}: ${interruption === "deadline" ? "deadline reached" : "stop requested"}`)
    this.name = "JoinPhaseInterrupted"
  }
}

export interface JoinPhaseOptions<T> {
  label: string
  deadlineMs: number
  isStopRequested: () => boolean
  /** Called if the phase settles after we stopped waiting for it. */
  onLateSettle: (result: PromiseSettledResult<T>) => void
  pollMs?: number
}

/** Stop waiting at the deadline or a stop request; the phase keeps running (not cancelled). */
export async function awaitJoinPhase<T>(
  phase: Promise<T>,
  options: JoinPhaseOptions<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let interrupted = false

  const guard = new Promise<never>((_, reject) => {
    const stop = (interruption: JoinPhaseInterruption) => {
      interrupted = true
      reject(new JoinPhaseInterrupted(interruption, options.label))
    }
    timer = setTimeout(() => stop("deadline"), options.deadlineMs)
    poll = setInterval(() => {
      if (options.isStopRequested()) stop("stopped")
    }, options.pollMs ?? 1_000)
  })

  phase.then(
    (value) => {
      if (interrupted) options.onLateSettle({ status: "fulfilled", value })
    },
    (reason: unknown) => {
      if (interrupted) options.onLateSettle({ status: "rejected", reason })
    }
  )

  try {
    return await Promise.race([phase, guard])
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
  }
}
