const chains = new WeakMap<object, Promise<unknown>>()

/** Runs tasks for the same key one after another: actions, undos and backups never overlap. */
export function oneAtATime<T>(key: object, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  chains.set(
    key,
    next.catch(() => undefined)
  )
  return next
}
