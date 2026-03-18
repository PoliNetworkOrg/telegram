import { CommandsCollection } from "@/lib/managed-commands"
import { testargs } from "./args"
import { testdb } from "./db"
import { testformat } from "./format"
import { testmenu } from "./menu"

export const test = new CommandsCollection("Test").withCollection(testargs, testdb, testformat, testmenu)
