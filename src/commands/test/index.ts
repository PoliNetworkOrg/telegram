import { CommandsCollection } from "@/lib/managed-commands"
import type { Role } from "@/utils/types"
import { testargs } from "./args"
import { testconvo } from "./conversation"
import { testdb } from "./db"
import { testformat } from "./format"
import { testmenu } from "./menu"

export const test = new CommandsCollection<Role>("Test").withCollection(
  testargs,
  testdb,
  testformat,
  testmenu,
  testconvo
)
