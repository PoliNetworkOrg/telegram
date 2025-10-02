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
 */
export function unicodeProgressBar(progress: number, size = 10) {
  const clamped = clamp(progress, 0, 1)
  const filledBars = Math.round(clamped * size)
  const emptyBars = size - filledBars
  return `｢${"▰".repeat(filledBars)}${"▱".repeat(emptyBars)}｣`
}
