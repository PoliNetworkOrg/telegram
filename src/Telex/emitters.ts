type EmitParams<P, T> = T extends void ? [P] : [P, T]

export type TypedEmitter<T extends Record<string, unknown>> = {
  once<K extends keyof T>(event: K, listener: (arg: T[K]) => void): void
  on<K extends keyof T>(event: K, listener: (arg: T[K]) => void): void
  off<K extends keyof T>(event: K, listener: (arg: T[K]) => void): void
  emit<K extends keyof T>(...params: EmitParams<K, T[K]>): void
}
