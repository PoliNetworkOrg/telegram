import type { CommandAccess } from "@/commands/access"
import { CommandsCollection } from "@/lib/managed-commands"
import { testargs } from "./args"
import { testconvo } from "./conversation"
import { testformat } from "./format"
import { testmenu } from "./menu"

export const test = new CommandsCollection<string, CommandAccess>("Test").withCollection(
  testargs,
  testformat,
  testmenu,
  testconvo
)
