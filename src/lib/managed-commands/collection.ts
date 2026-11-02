import type { Context } from "grammy"
import type {
  AccessControl,
  AnyCommand,
  Command,
  CommandArgs,
  CommandReplyTo,
  CommandScope,
  DefaultAccessControl,
} from "./command"

export class CommandsCollection<TAccess extends AccessControl = DefaultAccessControl> {
  private flushed = false
  private commands: AnyCommand<Context, TAccess>[] = []

  constructor(public name?: string) {}

  /**
   * Creates a new command and adds it to the list of commands
   * @param cmd The options for the command to create, see {@link Command}
   * @returns `this` instance for chaining
   */
  createCommand<const A extends CommandArgs, const R extends CommandReplyTo, const S extends CommandScope>(
    cmd: Command<A, R, S, Context, TAccess>
  ): CommandsCollection<TAccess> {
    if (this.flushed) {
      throw new Error("Cannot add commands after the collection has been flushed")
    }
    this.commands.push(cmd)
    return this
  }

  withCollection(...collections: CommandsCollection<TAccess>[]): CommandsCollection<TAccess> {
    if (this.flushed) {
      throw new Error("Cannot add commands after the collection has been flushed")
    }
    this.commands.push(...collections.flatMap((c) => c.flush()))
    return this
  }

  flush(): AnyCommand<Context, TAccess>[] {
    if (this.flushed) {
      throw new Error("The collection has already been flushed")
    }
    this.flushed = true
    return this.commands
  }
}
