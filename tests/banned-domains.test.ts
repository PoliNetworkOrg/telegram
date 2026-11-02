import { describe, expect, it } from "vitest"
import { BANNED_DOMAINS } from "@/middlewares/auto-moderation-stack/constants"
import { containsBannedDomain, extractHostnames } from "@/middlewares/auto-moderation-stack/hostnames"

const banned = (s: string) => containsBannedDomain(s, BANNED_DOMAINS)

describe("banned domains", () => {
  it("extracts hostnames from entity URLs and raw text", () => {
    expect(extractHostnames("https://WWW.MateApp.it/path?x=1")).toContain("mateapp.it")
    expect(extractHostnames("check out bit.ly/abc and https://foo.example.com:8080/x")).toEqual(
      expect.arrayContaining(["bit.ly", "foo.example.com"])
    )
  })

  it.each([
    "https://mateapp.it",
    "https://www.mateapp.it/invite",
    "https://sub.mateapp.it",
    "HTTPS://MATEAPP.IT",
    "mateapp.it",
    "scarica mateapp.it/ref?abc oggi",
    "https://mateapp.it.",
    "https://mateapp.it:443/x",
    "https://evil.com@mateapp.it",
    "https://amazon.it/gp/student/x",
  ])("bans %s", (text) => {
    expect(banned(text)).toBe(true)
  })

  it.each([
    "https://climateapp.it",
    "https://mateapp.it.evil.com",
    "https://notmateapp.it",
    "https://orbit.ly",
    "https://example.com/mateapp.it-review",
    "hello world",
  ])("does not ban %s", (text) => {
    expect(banned(text)).toBe(false)
  })
})
