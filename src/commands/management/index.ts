import type { CommandAccess } from "@/commands/access"
import { CommandsCollection } from "@/lib/managed-commands"
import { audit } from "./audit"
import { groups } from "./groups"
import { role } from "./role"
import { userid } from "./userid"

export const management = new CommandsCollection<CommandAccess>("Management").withCollection(
  audit,
  groups,
  role,
  userid
)
