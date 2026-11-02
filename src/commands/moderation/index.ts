import type { CommandAccess } from "@/commands/access"
import { CommandsCollection } from "@/lib/managed-commands"
import { ban } from "./ban"
import { banAll } from "./banall"
import { del } from "./del"
import { kick } from "./kick"
import { mute } from "./mute"

export const moderation = new CommandsCollection<CommandAccess>("Moderation").withCollection(
  ban,
  banAll,
  del,
  kick,
  mute
)
