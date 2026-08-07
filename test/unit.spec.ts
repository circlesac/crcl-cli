import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import {
  circlesOAuthEnvironment,
  createPKCE,
  getDefaultOrg,
  normalizeBaseURL,
  profileFromVerifiedEmail,
  startCallbackServer,
} from "../src/index"

describe("createPKCE", () => {
  it("creates an RFC 7636 S256 verifier and challenge", () => {
    const pkce = createPKCE()

    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"))
  })
})

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
  it("combines the OAuth environment with the normalized verified email", () => {
    expect(profileFromVerifiedEmail(" Alice+CLI@Example.com ", "prod")).toBe("prod:alice+cli@example.com")
    expect(profileFromVerifiedEmail(" Alice+CLI@Example.com ", "dev")).toBe("dev:alice+cli@example.com")
  })
})

describe("circlesOAuthEnvironment", () => {
  it("recognizes only matching official production and development endpoint pairs", () => {
    expect(circlesOAuthEnvironment("https://api.circles.ac", "https://auth.circles.ac")).toBe("prod")
    expect(circlesOAuthEnvironment("https://api-dev.circles.ac/", "https://auth-dev.circles.ac/")).toBe("dev")
    expect(circlesOAuthEnvironment("https://api.circles.ac", "https://auth-dev.circles.ac")).toBeUndefined()
    expect(circlesOAuthEnvironment("https://api.example.com", "https://auth.example.com")).toBeUndefined()
  })
})

describe("normalizeBaseURL", () => {
  it("removes trailing slashes before endpoint paths are appended or stored", () => {
    expect(normalizeBaseURL("https://auth.circles.ac/")).toBe("https://auth.circles.ac")
    expect(normalizeBaseURL("https://auth.example.com/base///")).toBe("https://auth.example.com/base")
  })
})
