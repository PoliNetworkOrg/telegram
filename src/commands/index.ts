import { registerCommand } from "../index.ts";
import del from "./del.ts"

export function registerAll() {
  registerCommand(del)
}
