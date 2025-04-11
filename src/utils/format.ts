/**
 * Internal marker string used to prefix formatted segments.
 * This prevents the main `format` function from re-escaping
 * the markdown characters (*, _, `, etc.) that were intentionally
 * added by the formatter functions (b, i, code, etc.).
 * It is removed in the final step of the `format` function.
 * Ensure this value does not contain any MarkdownV2 reserved characters.
 */
const BYPASS_ESCAPE = "$$$"

/**
 * Escapes characters that have special meaning in Telegram's MarkdownV2.
 * Characters: _ * ` [ ] ( ) ~ > # + - = | { } . !
 * Note: Backtick ` needs careful handling in regex.
 * @param text The text to escape.
 * @returns The escaped text.
 */
export function escapeMarkdownV2(text: string): string {
  // Match any character that needs escaping in MarkdownV2
  // The characters are: _ * ` [ ] ( ) ~ > # + - = | { } . !
  // We need to escape the backslash itself in the regex string,
  // and some characters within the character set [] like ] -
  if (text.startsWith(BYPASS_ESCAPE)) return text
  const escapeCharsRegex = /[_*[\]()~>#+\-=|{}.!``]/g
  return text.replace(escapeCharsRegex, "\\$&")
}

const parseTemplateString = (parser: (s: string) => string, strings: TemplateStringsArray, ...values: unknown[]) => {
  let result = ""
  for (let i = 0; i < values.length; i++) {
    result += parser(strings[i])
    result += parser(String(values[i])) // Convert value to string
  }
  result += parser(strings[strings.length - 1]) // Add the last static part
  return result
}

type Formatter = (strings: TemplateStringsArray, ...values: unknown[]) => string
type Formatters = {
  n: Formatter
  b: Formatter
  i: Formatter
  u: Formatter
  code: Formatter
  codeblock: Formatter
  spoiler: Formatter
  strikethrough: Formatter
  skip: Formatter
  link: (text: string, link: string) => string
}

function makeFormatter(formatChar: string, end?: string): Formatter {
  return (string, ...values) => {
    const escaped = parseTemplateString(escapeMarkdownV2, string, ...values)
    return escaped ? `${BYPASS_ESCAPE}${formatChar}${escaped}${formatChar}${end ?? ""}` : ""
  }
}

const formatters: Formatters = {
  n: makeFormatter(""),
  b: makeFormatter("*"),
  i: makeFormatter("_", "**"),
  u: makeFormatter("__"),
  strikethrough: makeFormatter("~"),
  spoiler: makeFormatter("||"),
  code: makeFormatter("`"),
  codeblock: makeFormatter("```\n"),
  skip: (str, ...val) => {
    const msg = `${BYPASS_ESCAPE}${parseTemplateString(s => s, str, ...val)}`
    return msg
  },
  link: (text, link) => {
    if (!text || !link) return ""
    return `${BYPASS_ESCAPE}[${escapeMarkdownV2(text)}](${escapeMarkdownV2(link)})`
  },
}

type FormatOptions = {
  sep?: string
  end?: string
}

/**
 * Main function to generate a formatted string for Telegram using MarkdownV2.
 * It takes a callback function that receives formatting utilities and should return
 * an array of strings (plain or formatted using the utilities).
 * These strings are then joined, escaped appropriately, and finalized.
 *
 * @param cb A callback function that receives the `Formatters` object and must return a string or an array of strings.
 * Use the formatters (e.g., `b`tag``, `i`tag``, `link(text, url)`) inside this callback to create formatted segments.
 * Plain strings returned in the array will be automatically escaped.
 * @param opts Optional configuration for the separator and end string.
 * @returns A single string formatted with Telegram MarkdownV2, ready to be sent.
 *
 * `NOTE`: if you split your message into multiple formats, you must use the `skip` formatter to join them
 * ```typescript
 * const part1 = format({ b } => [b`hello`, `world`])
 * const part2 = format({ i } => [i`everything`, `is`])
 * const response = format(({ skip, u }) => [skip`${part1}`, skip`${part2}`, u`fine`])
 * ```
 *
 * `NOTE`: You should put parts without formatting in their own strings.
 * If you want to compose formatted and not formatted in a single string,
 * please use the `n` formatter for the non-formatted parts
 * ```typescript
 * const response = format(({ n, b }) => n`(normal with ${b`bold`})`)
 * ```
 *
 * @example
 * const message = format(({ b, i, link, code }) => [
 *   "User:",
 *   b`John Doe`,
 *   i`(ID: 12345)`,
 *   "Action:",
 *   code`login`,
 *   "Info:",
 *   link("User Profile", "http://example.com/user/12345")
 * ], { sep: "\n", end: "\n--- End of Report ---" });
 * // Produces a multi-line message with bold, italic, code, and link formatting.
 */
export function format(cb: (formatters: Formatters) => string | string[], opts: FormatOptions = {}): string {
  const res = typeof cb === "function" ? cb(formatters) : cb
  const end = opts.end ?? ""
  const sep = opts.sep ?? " "

  if (typeof res === "string") {
    const str = !res.startsWith(BYPASS_ESCAPE) ? escapeMarkdownV2(res) : res
    return str.replaceAll(BYPASS_ESCAPE, "") + end
  }
  return (
    res
      .map((s) => (!s.startsWith(BYPASS_ESCAPE) ? escapeMarkdownV2(s) : s))
      .join(sep)
      .replaceAll(BYPASS_ESCAPE, "") + end
  )
}
