import { describe, it, expect } from "vitest"
import { fmt } from "@/utils/format"

// chars to escape:   _*[\]()~>#+\-=|{}.!`
describe("fmt: message format utility", () => {
  it("markdown escaping", () => {
    expect(fmt(() => "all_telegram-chars*to(escape){even}the~>strange[ones].#also+=\\specials|!`")).toBe(
      "all\\_telegram\\-chars\\*to\\(escape\\)\\{even\\}the\\~\\>strange\\[ones\\]\\.\\#also\\+\\=\\specials\\|\\!\\`"
    )
  })

  it("basic formatting", () => {
    expect(
      fmt(({ n, b, u, i, strikethrough, spoiler, code, codeblock }) => [
        n`hello`,
        b`hello`,
        u`hello`,
        i`hello`,
        strikethrough`hello`,
        spoiler`hello`,
        code`hello`,
        codeblock`hello`,
      ])
    ).toBe("hello *hello* __hello__ _hello_** ~hello~ ||hello|| `hello` ```\nhello```\n")
  })

  it("composite formatting", () => {
    expect(
      fmt(({ n, u, i }) => [
        u`${i`hello`} world`,
        i`${u`hello`} world`,
        u`${u`hello`} world`,
        i`${i`hello`} world`,
        n`${u`hello`} world`,
        u`${n`hello`} world`,
      ])
    ).toBe(
      [
        "___hello_** world__",
        "___hello__ world_**",
        "____hello__ world__",
        "__hello_** world_**",
        "__hello__ world",
        "__hello world__",
      ].join(" ")
    )

    expect(
      fmt(({ b, u, i, code }) => [
        u`${i`hello`} ${b`world`}`,
        u`${b`hello`} ${b`world`}`,
        b`${u`hello`} ${i`world`}`,
        b`${code`hello`} ${code`world`}`,
        b`${b`hello`} world`,
      ])
    ).toBe(
      [
        "___hello_** *world*__",
        "__*hello* *world*__",
        "*__hello__ _world_***",
        "*`hello` `world`*",
        "**hello* world*",
      ].join(" ")
    )
  })

  it("message merge", () => {
    const r1 = fmt(({ b }) => b`bold thing`)
    const r2 = fmt(({ i }) => i`italic thing`)
    const r3 = fmt(({ u }) => u`underline thing`)

    const msg = fmt(({ skip }) => [skip`${r1}`, skip`${r2}`, skip`${r3}`])
    expect(msg).toBe("*bold thing* _italic thing_** __underline thing__")
  })

  it("composite message merge", () => {
    const r1 = fmt(({ b }) => b`bold thing`)
    const r1_2 = fmt(({ i, skip }) => i`i need some italic for the ${skip`${r1}`}`)

    const msg = fmt(
      ({ u, skip, code }) => [u`everything underlined and ${skip`${r1_2}`}`, code`some code is never wrong`],
      { sep: "\n", end: "great end" }
    )
    expect(msg).toBe(
      "__everything underlined and _i need some italic for the *bold thing*_**__\n`some code is never wrong`great end"
    )
  })
})
