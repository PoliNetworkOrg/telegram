import { CommandsCollection } from "@/lib/managed-commands"
import type { Role } from "@/utils/types"
import { audit } from "./audit"
import { groups } from "./groups"
import { role } from "./role"
import { userid } from "./userid"

export const management = new CommandsCollection<Role>("Management").withCollection(audit, groups, role, userid)
