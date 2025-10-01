/**
 * Clamps a number between a minimum and maximum value.
 * @param num The number to clamp.
 * @param min The minimum value.
 * @param max The maximum value.
 * @returns The clamped value.
 */
export function clamp(num: number, min: number, max: number) {
  return Math.min(Math.max(num, min), max)
}

/**
 * Generates a unicode progress bar string.
 * @param progress A number between 0 and 1 representing the progress.
 * @param size The length of the progress bar (default is 10).
 * @returns A string representing the progress bar.
 *
 * @example
 * ```ts
 * console.log(unicodeProgressBar(0.1)) // "█░░░░░░░░░"
 * console.log(unicodeProgressBar(0.25)) // "███░░░░░░"
 * console.log(unicodeProgressBar(0.5)) // "█████░░░░░"
 * console.log(unicodeProgressBar(0.75)) // "███████▒░░"
 * console.log(unicodeProgressBar(0.9)) // "█████████▓"
 * console.log(unicodeProgressBar(1)) // "██████████"
 * ```
 */
export function unicodeProgressBar(progress: number, size = 10) {
  const shades = ["░", "▒", "▓", "█"] // 0, 1/3, 2/3, 1
  const clamped = clamp(progress, 0, 1)
  const filledBars = Math.floor(clamped * size)
  const partialBarIndex = Math.floor((clamped * size - filledBars) * shades.length)
  if (filledBars < size && partialBarIndex > 0) {
    return "█".repeat(filledBars) + shades[partialBarIndex] + "░".repeat(size - filledBars - 1)
  } else {
    return "█".repeat(filledBars) + "░".repeat(size - filledBars)
  }
}
