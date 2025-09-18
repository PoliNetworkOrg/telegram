import { BANNED_DOMAINS, POLINETWORK_DISCORD_GUILD_ID } from "./constants"

/**
 * checks an array of strings for domains which are not allowed in our groups
 *
 * @param links array of strings that may contain a link
 * @returns false if the link is NOT allowed, true otherwise
 */
export async function checkForAllowedLinks(links: string[]): Promise<boolean> {
  for (const url of links) {
    // these websites are simply not allowed
    if (BANNED_DOMAINS.some((domain) => url.includes(domain))) return false

    // specific discord invites handling
    const discordMatches = url.matchAll(/discord\.gg\/([^/?#]+)/g)
    for (const match of discordMatches) {
      const code = match[1]
      const isPolinetworkDiscord = await fetch(`https://discordapp.com/api/invites/${code}`)
        .then((res) => res.json())
        .then((v) => v?.guild?.id === POLINETWORK_DISCORD_GUILD_ID)
        .catch(() => false)
      if (!isPolinetworkDiscord) return false
    }

    // specific whatsapp invites handling
    const whatsappMatches = url.matchAll(/whatsapp\.com\/([^/?#]+)/g)
    for (const match of whatsappMatches) {
      const _code = match[1]
      // TODO: somehow manage to understand if the link is one of our groups???
      return false
    }

    // specific telegram invites handling
    const telegramMatches = url.matchAll(/t\.me\/([^/?#]+)/g)
    for (const match of telegramMatches) {
      const code = match[1]
      // if this is the channel link, we allow it
      if (code !== "c") {
        // TODO: fetch invite links from backend
        return false
      }
    }
  }

  return true
}
