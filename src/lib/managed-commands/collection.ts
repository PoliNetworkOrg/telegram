import type { AnyCommand, Command, CommandArgs, CommandReplyTo, CommandScope } from "./command"

export class CommandsCollection<TRole extends string> {
  private flushed = false
  private commands: AnyCommand<TRole>[] = []

  constructor(public name?: string) {}

  /**
   * Creates a new command and adds it to the list of commands
   * @param cmd The options for the command to create, see {@link Command}
   * @returns `this` instance for chaining
   */
  createCommand<const A extends CommandArgs, const R extends CommandReplyTo, const S extends CommandScope>(
    cmd: Command<A, R, S, TRole>
  ): CommandsCollection<TRole> {
    if (this.flushed) {
      throw new Error("Cannot add commands after the collection has been flushed")
    }
    this.commands.push(cmd)
    return this
  }

  withCollection(...collections: CommandsCollection<TRole>[]): CommandsCollection<TRole> {
    if (this.flushed) {
      throw new Error("Cannot add commands after the collection has been flushed")
    }
    this.commands.push(...collections.flatMap((c) => c.flush()))
    return this
  }

  flush(): AnyCommand<TRole>[] {
    if (this.flushed) {
      throw new Error("The collection has already been flushed")
    }
    this.flushed = true
    return this.commands
  }
}
