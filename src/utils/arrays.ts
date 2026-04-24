export function asyncFilter<T>(arr: T[], predicate: (item: T) => Promise<boolean>): Promise<T[]> {
  return Promise.all(arr.map(async (item) => ({ item, keep: await predicate(item) }))).then((results) =>
    results.filter((result) => result.keep).map((result) => result.item)
  )
}

export function asyncMap<T, U>(arr: T[], mapper: (item: T) => Promise<U>): Promise<U[]> {
  return Promise.all(arr.map(mapper))
}
