// SPDX-License-Identifier: AGPL-3.0-only
/** Request failures and worker failures are different: an ordinary error
 * rejects one job; a dead worker must release every waiter and stay dead until
 * its owner has recreated the worker and restored any required state. */
export class WorkerRpc {
  private worker: Worker | null = null
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  dead = false
  onFailure: ((message: string) => void) | null = null

  constructor(private create: () => Worker, private name: string, private event?: (message: unknown) => boolean) {
    this.restart()
  }

  restart(): void {
    if (this.worker) this.fail(`${this.name} was restarted.`)
    const worker = this.create()
    this.worker = worker
    this.dead = false
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker || this.dead) return
      if (this.event?.(data)) return
      const entry = this.pending.get(data.requestId)
      if (!entry) return
      this.pending.delete(data.requestId)
      if (data.type === 'error') entry.reject(new Error(data.message))
      else entry.resolve(data)
    }
    worker.onerror = (error) => {
      error.preventDefault?.()
      this.fail(`${this.name} failed${error.message ? `: ${error.message}` : '.'}`)
    }
    worker.onmessageerror = () => this.fail(`${this.name} returned an unreadable response.`)
  }

  fail(message: string): void {
    this.dead = true
    const worker = this.worker
    this.worker = null
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null
      worker.terminate()
    }
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) entry.reject(new Error(message))
    this.onFailure?.(message)
  }

  request<T>(message: { requestId: number }, transfer: Transferable[] = []): Promise<T> {
    if (this.dead || !this.worker) return Promise.reject(new Error(`${this.name} is unavailable. Retry the operation.`))
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.requestId, { resolve: (value) => resolve(value as T), reject })
      try { this.worker!.postMessage(message, transfer) }
      catch (error) {
        this.pending.delete(message.requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  post(message: unknown): void { this.worker?.postMessage(message) }
  dispose(): void {
    this.onFailure = null
    this.fail(`${this.name} was shut down.`)
  }
}
