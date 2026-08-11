import { describe, expect, it, vi } from "vitest"
import { Module, ModuleCoordinator } from "@/lib/modules"

type SharedState = {
  value: number
}

class ProbeModule extends Module<SharedState> {
  public readonly onStart = vi.fn<() => void | Promise<void>>()
  public readonly onStop = vi.fn<() => void | Promise<void>>()

  public readShared(): Readonly<SharedState> {
    return this.shared
  }

  override async start(): Promise<void> {
    await this.onStart()
  }

  override async stop(): Promise<void> {
    await this.onStop()
  }
}

type LinkedModuleMap = {
  source: SourceModule
  target: TargetModule
}

class SourceModule extends Module<SharedState, LinkedModuleMap> {
  public getTarget(): TargetModule {
    return this.getModule("target")
  }

  public getMissing(): unknown {
    return this.getModule("missing" as keyof LinkedModuleMap)
  }
}

class TargetModule extends Module<SharedState, LinkedModuleMap> {}

describe("ModuleCoordinator", () => {
  it("throws when a module accesses shared state before being bound", () => {
    const module = new ProbeModule()

    expect(() => module.readShared()).toThrow(/Module not bound to a ModuleCoordinator/)
  })

  it("waits for async shared init before exposing values and starting modules", async () => {
    const a = new ProbeModule()
    const b = new ProbeModule()

    let resolveShared!: (value: SharedState) => void
    const sharedPromise = new Promise<SharedState>((resolve) => {
      resolveShared = resolve
    })

    const sharedFactory = vi.fn(() => sharedPromise)
    const coordinator = new ModuleCoordinator({ a, b }, sharedFactory)

    expect(() => coordinator.shared).toThrow(/hasn't been initialized yet/)
    expect(() => a.readShared()).toThrow(/Module not bound to a ModuleCoordinator/)
    expect(a.onStart).not.toHaveBeenCalled()
    expect(b.onStart).not.toHaveBeenCalled()

    const readyPromise = coordinator.ready()

    resolveShared({ value: 42 })
    await readyPromise

    expect(sharedFactory).toHaveBeenCalledTimes(1)
    expect(a.onStart).toHaveBeenCalledTimes(1)
    expect(b.onStart).toHaveBeenCalledTimes(1)
    expect(coordinator.shared.value).toBe(42)
    expect(a.readShared()).toBe(coordinator.shared)
    expect(b.readShared()).toBe(coordinator.shared)
  })

  it("freezes the shared object so modules cannot mutate it", async () => {
    const module = new ProbeModule()
    const coordinator = new ModuleCoordinator({ module }, async () => ({ value: 1 }))

    await coordinator.ready()

    expect(Object.isFrozen(coordinator.shared)).toBe(true)
    expect(() => {
      ;(coordinator.shared as { value: number }).value = 2
    }).toThrow(TypeError)
    expect(module.readShared().value).toBe(1)
  })

  it("returns modules by key with get", async () => {
    const first = new ProbeModule()
    const second = new ProbeModule()
    const coordinator = new ModuleCoordinator({ first, second }, () => ({ value: 5 }))

    await coordinator.ready()

    expect(coordinator.get("first")).toBe(first)
    expect(coordinator.get("second")).toBe(second)
  })

  it("allows modules to resolve peers through getModule after binding", async () => {
    const source = new SourceModule()
    const target = new TargetModule()
    const coordinator = new ModuleCoordinator({ source, target }, () => ({ value: 7 }))

    await coordinator.ready()

    expect(source.getTarget()).toBe(target)
  })

  it("throws when getModule is accessed before being bound", () => {
    const source = new SourceModule()

    expect(() => source.getTarget()).toThrow(/Module not bound to a ModuleCoordinator/)
  })

  it("throws when getModule references a module key not in the coordinator", async () => {
    const source = new SourceModule()
    const target = new TargetModule()
    const coordinator = new ModuleCoordinator({ source, target }, () => ({ value: 3 }))

    await coordinator.ready()

    expect(() => source.getMissing()).toThrow(/Module missing not found in coordinator\./)
  })

  it("stops modules exactly once and ignores repeated stop calls", async () => {
    const first = new ProbeModule()
    const second = new ProbeModule()
    const coordinator = new ModuleCoordinator({ first, second }, () => ({ value: 9 }))

    await coordinator.ready()

    await coordinator.stop()
    await coordinator.stop()

    expect(first.onStart).toHaveBeenCalledTimes(1)
    expect(second.onStart).toHaveBeenCalledTimes(1)
    expect(first.onStop).toHaveBeenCalledTimes(1)
    expect(second.onStop).toHaveBeenCalledTimes(1)
  })

  it("waits for async start hooks before resolving ready", async () => {
    const step: string[] = []
    const module = new ProbeModule()

    module.onStart.mockImplementation(async () => {
      step.push("start-begin")
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10)
      })
      step.push("start-end")
    })

    const coordinator = new ModuleCoordinator({ module }, () => ({ value: 10 }))

    await coordinator.ready()

    expect(step).toEqual(["start-begin", "start-end"])
    expect(module.readShared().value).toBe(10)
  })
})
