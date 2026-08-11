import { CommandsCollection } from "@/lib/managed-commands"
import type { Role } from "@/utils/types"
import { ban } from "./ban"
import { banAll } from "./banall"
import { del } from "./del"
import { kick } from "./kick"
import { mute } from "./mute"

export const moderation = new CommandsCollection<Role>("Moderation").withCollection(ban, banAll, del, kick, mute)
