import { describe, expect, it } from "vitest"
import { getDefaultOrg, profileFromVerifiedEmail, startCallbackServer } from "../src/index"

describe("getDefaultOrg", () => {
  const baseConfig = {
    orgs: {},
  }

  it("returns null when no orgs", () => {
    expect(getDefaultOrg(baseConfig)).toBeNull()
  })

  it("returns null when no default org", () => {
    const config = {
      ...baseConfig,
      orgs: {
        "1": { slug: "org-a" },
        "2": { slug: "org-b" },
      },
    }
    expect(getDefaultOrg(config)).toBeNull()
  })

  it("returns default org", () => {
    const config = {
      ...baseConfig,
      orgs: {
        "1": { slug: "org-a" },
        "2": { slug: "org-b", default: true },
      },
    }
    const result = getDefaultOrg(config)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("2")
    expect(result!.entry.slug).toBe("org-b")
  })

  it("returns first default when multiple (edge case)", () => {
    const config = {
      ...baseConfig,
      orgs: {
        "1": { slug: "org-a", default: true },
        "2": { slug: "org-b", default: true },
      },
    }
    const result = getDefaultOrg(config)
    expect(result!.id).toBe("1")
  })

  it("handles default: false", () => {
    const config = {
      ...baseConfig,
      orgs: {
        "1": { slug: "org-a", default: false },
      },
    }
    expect(getDefaultOrg(config)).toBeNull()
  })
})

describe("startCallbackServer", () => {
  it("ignores callbacks with mismatched OAuth state and waits for the valid callback", async () => {
    const { port, waitForCode } = await startCallbackServer("expected-state")

    const invalid = await fetch(`http://127.0.0.1:${port}/callback?code=old-code&state=stale-state`)
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toBe("Invalid state parameter")

    const valid = await fetch(`http://127.0.0.1:${port}/callback?code=fresh-code&state=expected-state`)
    expect(valid.status).toBe(200)
    await expect(waitForCode).resolves.toBe("fresh-code")
  })
})

describe("profileFromVerifiedEmail", () => {
  it("trims and ASCII-lowercases the server-verified email", () => {
    expect(profileFromVerifiedEmail(" YG+CLI@Melten.AI ")).toBe("yg+cli@melten.ai")
  })
})
