import type { MaybePromise } from "@/utils/types"
import { Awaiter } from "@/utils/wait"

const SHARED_GETTER = Symbol("__internal_shared_getter")

type WithGetter<T> = {
  [SHARED_GETTER]?: () => Readonly<T>
}

/**
 * @deprecated ## VERY PRIVATE FUNCTION, IF EXPORTED I'LL LITERALLY START CRYING SO DON'T
 *
 * Get the shared value getter for a module instance.
 *
 * _comments as visibility modifiers: ✅_
 * @param self The module instance
 * @returns A function that returns the shared value, or null if not available
 */
function magicGetter<TShared>(self: Module<TShared>): WithGetter<TShared> {
  return self as unknown as WithGetter<TShared> // dont tell typescript!
}

/**
 * Base class for modules that can share immutable data via a ModuleCoordinator.
 * The shared data is accessible via the `shared` getter.
 *
 * This abstract class provides overridable lifecycle methods `start` and `stop`
 * for initialization and cleanup when used with a `ModuleCoordinator`.
 */
export abstract class Module<TShared> {
  /**
   * The concrete getter is stored under a symbol property that is NOT exposed.
   * It's `private` so subclasses cannot directly touch it. We still access it
   * via a symbol to allow ModuleCoordinator (in same module/file) to bind it.
   * biome-ignore lint/correctness/noUnusedPrivateClassMembers: it's a kind of magic
   */
  private [SHARED_GETTER]?: () => Readonly<TShared>

  /**
   * Protected accessor for the shared, immutable data. If a module tries to use
   * it before the coordinator has bound it, we throw an error.
   */
  protected get shared(): Readonly<TShared> {
    const getter = magicGetter(this)[SHARED_GETTER]
    if (!getter) {
      throw new Error("Module not bound to a ModuleCoordinator or coordinator hasn't started yet.")
    }
    return getter()
  }

  /**
   * Called upon initialization, here the shared value is guaranteed to be bound.
   */
  public start?(): void | Promise<void>
  /**
   * Called when the coordinator is stopped, for cleanup.
   */
  public stop?(): void | Promise<void>
}

/**
 * Coordinator which owns a Readonly<TShared> and binds it to all modules.
 * The data is frozen (immutable) and isolated per-coordinator instance.
 */
export class ModuleCoordinator<TShared, ModuleMap extends Record<string, Module<TShared>>> {
  private sharedValue?: Readonly<TShared>
  private started = false
  private starting = new Awaiter<void>()

  constructor(
    private readonly modules: ModuleMap,
    sharedValue: MaybePromise<TShared>
  ) {
    void this.init(sharedValue)
  }

  private async init(sharedValue: MaybePromise<TShared>) {
    const resolved = await sharedValue
    this.sharedValue = Object.freeze(resolved) // make it immutable

    // Bind the internal getter to each module. Because SHARED_GETTER is a symbol
    // private to this file, external code won't know how to access it.
    for (const m of Object.values(this.modules)) {
      // `as any` is required because symbols on classes are not part of the
      // public Module<TShared> shape. This is internal wiring only.
      magicGetter(m)[SHARED_GETTER] = () => resolved
    }
    await this.start()
    this.starting.resolve()
  }

  public async ready(): Promise<void> {
    await this.starting
  }

  /** Returns the shared value owned by the coordinator. */
  public get shared(): Readonly<TShared> {
    if (!this.sharedValue) {
      throw new Error("ModuleCoordinator hasn't been initialized yet.")
    }
    return this.sharedValue
  }

  public get<K extends keyof ModuleMap>(module: K): ModuleMap[K] {
    return this.modules[module]
  }

  private async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await Promise.all(
      Object.values(this.modules)
        .map((m) => m.start?.())
        .filter(Boolean)
    )
  }

  /**
   * Stops all modules for a graceful shutdown.
   * @returns A promise that resolves when all modules have been stopped.
   */
  public async stop(): Promise<void> {
    if (!this.started) return
    await Promise.all(
      Object.values(this.modules)
        .map((m) => m.stop?.())
        .filter(Boolean)
    )
    this.started = false
  }
}
