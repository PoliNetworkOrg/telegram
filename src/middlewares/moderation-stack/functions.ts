import type { Category, FlaggedCategory, ModerationResult } from "./types"

import { BANNED_DOMAINS, DELETION_THRESHOLDS, POLINETWORK_DISCORD_GUILD_ID } from "./constants"

/**
 * Takes each category, and for the flagged ones takes the score (highest among related results) and
 * confronts it with predefined thresholds
 *
 * @param results The array of results as provided by OpenAI's API
 * @returns An array of {@link FlaggedCategory} containing each category that was flagged by OpenAI
 */
export function parseFlaggedCategories(results: ModerationResult[]): FlaggedCategory[] {
  const categories = new Set(
    results
      .map((result) => result.categories)
      .reduce<Category[]>((acc, curr) => {
        Object.keys(curr).forEach((key) => {
          const k = key as Category
          if (curr[k]) acc.push(k)
        })
        return acc
      }, [])
  )
  const scores = results
    .map((result) => result.category_scores)
    .reduce<Record<Category, number>>((acc, curr) => {
      Object.keys(curr).forEach((key) => {
        const k = key as Category
        acc[k] = Math.max(acc[k], curr[k])
      })
      return acc
    }, results[0].category_scores)
  return Array.from(categories).map((category) => ({
    category,
    score: scores[category],
    aboveThreshold: DELETION_THRESHOLDS[category] ? scores[category] >= DELETION_THRESHOLDS[category] : false,
  }))
}

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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        .then((v) => v?.guild?.id === POLINETWORK_DISCORD_GUILD_ID) // opt chaining, wont crash, and even if it did there's a catch clause
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
