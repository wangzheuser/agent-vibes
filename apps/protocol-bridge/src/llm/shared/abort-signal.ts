export class UpstreamRequestAbortedError extends Error {
  constructor(message: string = "Upstream request aborted") {
    super(message)
    this.name = "UpstreamRequestAbortedError"
  }
}

function resolveAbortMessage(
  abortSignal: AbortSignal | undefined,
  defaultMessage: string
): string {
  const reason: unknown = abortSignal?.reason
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim()
  }
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message.trim()
  }
  return defaultMessage
}

export function isAbortLikeError(error: unknown): boolean {
  if (error instanceof UpstreamRequestAbortedError) {
    return true
  }
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
      ? error.name
      : undefined
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  )
}

export function toUpstreamRequestAbortedError(
  error: unknown,
  abortSignal: AbortSignal | undefined,
  defaultMessage: string = "Upstream request aborted"
): UpstreamRequestAbortedError | null {
  if (error instanceof UpstreamRequestAbortedError) {
    return error
  }
  if (!abortSignal?.aborted || !isAbortLikeError(error)) {
    return null
  }
  return new UpstreamRequestAbortedError(
    resolveAbortMessage(abortSignal, defaultMessage)
  )
}

export function combineAbortSignals(
  signals: readonly AbortSignal[]
): AbortSignal {
  if (signals.length === 1) return signals[0]!

  const nativeAny = (
    AbortSignal as typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal
    }
  ).any
  if (nativeAny) return nativeAny([...signals])

  const controller = new AbortController()
  const onAbort = (event: Event) => {
    const signal = event.target as AbortSignal | null
    controller.abort(signal?.reason)
    for (const current of signals) {
      current.removeEventListener("abort", onAbort)
    }
  }

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener("abort", onAbort, { once: true })
  }

  return controller.signal
}

export function createAbortSignalWithTimeout(
  timeoutMs: number,
  abortSignal?: AbortSignal
): {
  signal: AbortSignal
  cleanup: () => void
  didTimeout: () => boolean
} {
  const timeoutController = new AbortController()
  const timeout = setTimeout(
    () =>
      timeoutController.abort(
        new Error(`Timed out waiting for upstream after ${timeoutMs}ms`)
      ),
    timeoutMs
  )

  return {
    signal: abortSignal
      ? combineAbortSignals([timeoutController.signal, abortSignal])
      : timeoutController.signal,
    cleanup: () => clearTimeout(timeout),
    didTimeout: () => timeoutController.signal.aborted,
  }
}

export function createAbortPromise(
  abortSignal: AbortSignal | undefined,
  defaultMessage: string = "Upstream request aborted"
): {
  promise: Promise<never> | null
  cleanup: () => void
} {
  if (!abortSignal) {
    return {
      promise: null,
      cleanup: () => undefined,
    }
  }

  if (abortSignal.aborted) {
    return {
      promise: Promise.reject(
        new UpstreamRequestAbortedError(
          resolveAbortMessage(abortSignal, defaultMessage)
        )
      ),
      cleanup: () => undefined,
    }
  }

  let settled = false
  let abortHandler: (() => void) | undefined
  const promise = new Promise<never>((_, reject) => {
    abortHandler = () => {
      settled = true
      reject(
        new UpstreamRequestAbortedError(
          resolveAbortMessage(abortSignal, defaultMessage)
        )
      )
    }
    abortSignal.addEventListener("abort", abortHandler, { once: true })
  })

  return {
    promise,
    cleanup: () => {
      if (!settled && abortHandler) {
        abortSignal.removeEventListener("abort", abortHandler)
      }
    },
  }
}
