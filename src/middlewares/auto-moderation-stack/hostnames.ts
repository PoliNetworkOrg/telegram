// scheme (optional) followed by a dotted hostname; also matches scheme-less links like `bit.ly/abc`
const HOSTNAME_REGEX = /(?:[a-z][a-z0-9+.-]*:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]*[a-z0-9])/gi

function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/^www\./, "")
}

/**
 * Extracts normalized (lowercase) hostnames from a string that is either a URL
 * (e.g. a Telegram `text_link` entity) or free text containing URLs.
 */
export function extractHostnames(input: string): string[] {
  const hosts = new Set<string>()

  // well-formed absolute URL, e.g. from entities
  try {
    const parsed = new URL(input)
    if (parsed.hostname) hosts.add(normalizeHostname(parsed.hostname.replace(/\.$/, "")))
  } catch {
    // not a standalone URL, fall through to text scanning
  }

  for (const match of input.matchAll(HOSTNAME_REGEX)) hosts.add(normalizeHostname(match[1]))
  return [...hosts]
}

/**
 * A hostname matches a banned domain if it is the domain itself or a subdomain of it
 * (dot-delimited suffix), so `mateapp.it` and `www.mateapp.it` match but `climateapp.it` does not.
 */
export function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/**
 * Whether `input` contains a link to one of the banned entries.
 * Entries without a path are matched against hostnames; entries with a path
 * (e.g. `amazon.it/gp/student`) are matched against the lowercased input.
 */
export function containsBannedDomain(input: string, banned: readonly string[]): boolean {
  const lowered = input.toLowerCase()
  const hosts = extractHostnames(input)
  return banned.some((entry) => {
    const domain = entry.toLowerCase()
    if (domain.includes("/")) return lowered.includes(domain)
    return hosts.some((host) => hostMatchesDomain(host, domain))
  })
}
