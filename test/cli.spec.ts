import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sharedFilePaths } from "@circlesac/credentials"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runCommand } from "citty"

const testHome = join(tmpdir(), `crcl-test-${process.pid}`)

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
  }
}

let logs: string[] = []
let errs: string[] = []
let savedFetch: typeof fetch
let savedProcessEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedProcessEnv = { ...process.env }
  mkdirSync(join(testHome, ".crcl"), { recursive: true })
  mkdirSync(join(testHome, ".config", "crcl"), { recursive: true })
  for (const name of [
    "CIRCLES_AUTH_TOKEN",
    "CIRCLES_PROFILE",
    "CRCL_AUTH_TOKEN",
    "CRCL_PROFILE",
  ]) delete process.env[name]
  process.env.XDG_CONFIG_HOME = join(testHome, ".config")
  process.env.CIRCLES_CONFIG_FILE = configPath()
  process.env.CIRCLES_SHARED_CREDENTIALS_FILE = credentialsPath()

  const paths = sharedFilePaths()
  if (paths.configFile !== configPath() || paths.credentialsFile !== credentialsPath()) {
    throw new Error("Tests must use isolated Circles credential files.")
  }

  logs = []
  errs = []
  savedFetch = globalThis.fetch
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.join(" "))
  })
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errs.push(args.join(" "))
  })
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitError(typeof code === "number" ? code : 1)
  })
})

afterEach(() => {
  globalThis.fetch = savedFetch
  vi.restoreAllMocks()
  if (existsSync(testHome)) {
    rmSync(testHome, { recursive: true, force: true })
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in savedProcessEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedProcessEnv)
})

// ── Test Helpers ──────────────────────────────────────────────────────────

async function crcl(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const savedArgv = process.argv
  const savedEnv = { ...process.env }

  process.argv = ["bun", "crcl", ...args]
  Object.assign(process.env, env)

  try {
    const mod = await import("../src/index")
    await runCommand(mod.main, { rawArgs: args })
    return { stdout: logs.join("\n"), stderr: errs.join("\n"), exitCode: 0 }
  } catch (e) {
    if (e instanceof ExitError) {
      return { stdout: logs.join("\n"), stderr: errs.join("\n"), exitCode: e.code }
    }
    if (e instanceof Error && e.constructor.name === "CLIError") {
      return { stdout: logs.join("\n"), stderr: errs.join("\n"), exitCode: 1 }
    }
    throw e
  } finally {
    process.argv = savedArgv
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key]
    }
    Object.assign(process.env, savedEnv)
  }
}

function configPath() { return join(testHome, ".crcl", "config") }
function credentialsPath() { return join(testHome, ".crcl", "credentials") }

function writeConfig(ini: string) {
  writeFileSync(configPath(), ini)
}

function writeCredentials(ini: string) {
  writeFileSync(credentialsPath(), ini)
}

function readConfig(): string {
  return existsSync(configPath()) ? readFileSync(configPath(), "utf-8") : ""
}

function readCredentials(): string {
  return existsSync(credentialsPath()) ? readFileSync(credentialsPath(), "utf-8") : ""
}

function setupProfile(profile: string, opts: { org?: string; api_url?: string; auth_url?: string; token?: string; refresh?: string } = {}) {
  const token = opts.token || fakeJwt(`test-${profile}@circles.ac`)

  // Config
  const confLines: string[] = []
  if (opts.org) confLines.push(`org = ${opts.org}`)
  if (opts.api_url) confLines.push(`api_url = ${opts.api_url}`)
  if (opts.auth_url) confLines.push(`auth_url = ${opts.auth_url}`)

  const existingConfig = readConfig()
  const configSection = confLines.length > 0 ? `[${profile}]\n${confLines.join("\n")}\n` : ""
  writeConfig(existingConfig + configSection)

  // Credentials
  const existingCreds = readCredentials()
  writeCredentials(existingCreds + `[${profile}]\naccess_token = ${token}\n${opts.refresh ? `refresh_token = ${opts.refresh}\n` : ""}\n`)
}

type RouteHandler = { status: number; body?: unknown }
type RouteEntry = RouteHandler | RouteHandler[]

function mockFetch(routes: Record<string, RouteEntry>, calls?: string[]) {
  const callCounts: Record<string, number> = {}

  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method || "GET"
    calls?.push(`${method} ${new URL(url).pathname}`)

    for (const [pattern, handler] of Object.entries(routes)) {
      const [routeMethod, routePath] = pattern.includes(" ") ? pattern.split(" ", 2) : ["GET", pattern]
      if (method === routeMethod && url.includes(routePath!)) {
        let response: RouteHandler
        if (Array.isArray(handler)) {
          const count = callCounts[pattern] || 0
          response = handler[Math.min(count, handler.length - 1)]
          callCounts[pattern] = count + 1
        } else {
          response = handler
        }
        return new Response(
          response.body !== undefined ? JSON.stringify(response.body) : null,
          { status: response.status, headers: { "Content-Type": "application/json" } }
        )
      }
    }

    return new Response("Not Found", { status: 404 })
  }) as unknown as typeof fetch
}

function fakeJwt(email: string, expiresAt = Date.now() + 60 * 60 * 1000): string {
  // Signed-shape with an expiry: the credential provider rejects unsigned or
  // never-expiring JWTs, exactly so fixtures like this cannot pass as real
  // logins if they ever leak into a live store again.
  const header = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Math.floor(expiresAt / 1000),
  })).toString("base64url")
  return `${header}.${payload}.sig`
}

const TEST_TOKEN = fakeJwt("test@circles.ac")

function authedConfig(opts: { org?: string; refresh_token?: string } = {}) {
  setupProfile("default", { org: opts.org || "acme", token: TEST_TOKEN, refresh: opts.refresh_token })
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const ME_RESPONSE = {
  id: 1,
  email: "test@circles.ac",
  name: "Test User",
  orgs: [
    { id: 10, slug: "acme", name: "Acme Corp", role: "owner" },
    { id: 20, slug: "beta", name: "Beta Inc", role: "member" },
  ],
}

const API_KEYS_RESPONSE = [
  { id: "k1", name: "dev-key", masked_key: "sk_...abc", created_at: "2025-01-01T00:00:00Z" },
]

const MEMBERS_RESPONSE = [
  { user_id: 1, email: "alice@circles.ac", name: "Alice", role: "owner", created_at: "2025-01-01T00:00:00Z" },
  { user_id: 2, email: "bob@circles.ac", name: "Bob", role: "member", created_at: "2025-02-01T00:00:00Z" },
]

const GROUPS_RESPONSE = [
  { id: 10, org_id: 1, name: "Engineering", alias: "eng", description: "Engineers", created_at: "2025-01-01T00:00:00Z" },
  { id: 11, org_id: 1, name: "Design", alias: "design", description: null, created_at: "2025-02-01T00:00:00Z" },
]

const GROUP_MEMBERS_RESPONSE = [
  { user_id: 1, email: "alice@circles.ac", name: "Alice", role: "admin", created_at: "2025-01-01T00:00:00Z" },
]

// ── Help & Version ────────────────────────────────────────────────────────

describe("help & version (meta)", () => {
  it("main command has correct metadata", async () => {
    const mod = await import("../src/index")
    expect(mod.main.meta?.name).toBe("crcl")
    expect(mod.main.meta?.version).toBe("0.0.0")
    expect(mod.main.subCommands).toHaveProperty("login")
    expect(mod.main.subCommands).toHaveProperty("orgs")
    expect(mod.main.subCommands).toHaveProperty("members")
    expect(mod.main.subCommands).toHaveProperty("groups")
    expect(mod.main.subCommands).toHaveProperty("apikeys")
  })
})

// ── Auth ──────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("login sends an S256 PKCE challenge and exchanges the matching verifier", async () => {
    let exchangeBody: URLSearchParams | undefined
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://auth.circles.ac/token") {
        exchangeBody = new URLSearchParams(String(init?.body))
        return Response.json({ access_token: TEST_TOKEN, refresh_token: "login-refresh" })
      }
      if (url === "https://api.circles.ac/users/me") return Response.json(ME_RESPONSE)
      return new Response("Not Found", { status: 404 })
    }) as unknown as typeof fetch
    vi.spyOn(Bun, "spawn").mockReturnValue({} as ReturnType<typeof Bun.spawn>)

    const login = crcl(["login"])
    for (let attempt = 0; attempt < 100 && !logs.some((line) => line.startsWith("If it doesn't open, visit: ")); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const authorizationURL = new URL(logs.find((line) => line.startsWith("If it doesn't open, visit: "))!.split("visit: ")[1]!)
    expect(authorizationURL.searchParams.get("response_type")).toBe("code")
    expect(authorizationURL.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorizationURL.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const callbackURL = new URL(authorizationURL.searchParams.get("redirect_uri")!)
    callbackURL.hostname = "127.0.0.1"
    callbackURL.searchParams.set("code", "authorization-code")
    callbackURL.searchParams.set("state", authorizationURL.searchParams.get("state")!)
    expect((await savedFetch(callbackURL)).status).toBe(200)

    const result = await login
    expect(result.exitCode).toBe(0)
    expect(exchangeBody?.get("code")).toBe("authorization-code")
    expect(exchangeBody?.get("redirect_uri")).toBe(authorizationURL.searchParams.get("redirect_uri"))
    expect(exchangeBody?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createHash("sha256").update(exchangeBody!.get("code_verifier")!).digest("base64url")).toBe(
      authorizationURL.searchParams.get("code_challenge"),
    )
  })

  it("auth status verifies every profile and marks the selected profile", async () => {
    const defaultToken = fakeJwt("default@circles.ac")
    const devToken = fakeJwt("alice@example.com")
    setupProfile("default", { token: defaultToken })
    setupProfile("dev:alice@example.com", {
      api_url: "https://api-dev.circles.ac",
      auth_url: "https://auth-dev.circles.ac",
      token: devToken,
    })
    writeConfig(`[__circles__]\ncurrent_profile = dev:alice@example.com\n\n${readConfig()}`)
    mockFetch({
      "GET https://api.circles.ac/users/me": { status: 200, body: { ...ME_RESPONSE, email: "default@circles.ac" } },
      "GET https://api-dev.circles.ac/users/me": { status: 200, body: { ...ME_RESPONSE, email: "alice@example.com" } },
    })

    const { stdout, exitCode } = await crcl(["auth", "status"])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("PROFILE")
    expect(stdout).toMatch(/dev:alice@example\.com\s+\*\s+ok\s+alice@example\.com\s+https:\/\/auth-dev\.circles\.ac/)
    expect(stdout).toMatch(/default\s+ok\s+default@circles\.ac\s+https:\/\/auth\.circles\.ac/)
    expect(stdout).not.toContain(defaultToken)
    expect(stdout).not.toContain(devToken)
  })

  it("auth status shows unusable profiles without hiding healthy profiles", async () => {
    const ambiguousToken = fakeJwt("bad@circles.ac")
    setupProfile("default", { token: fakeJwt("default@circles.ac") })
    writeConfig(`${readConfig()}[custom]\nauth_url = https://login.example.com\n`)
    writeCredentials(`${readCredentials()}[ambiguous]\naccess_token = ${ambiguousToken}\napi_key = opaque-key\n`)
    mockFetch({
      "GET https://api.circles.ac/users/me": { status: 200, body: { ...ME_RESPONSE, email: "default@circles.ac" } },
    })

    const { stdout, exitCode } = await crcl(["auth", "status"])

    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/default\s+\*\s+ok\s+default@circles\.ac/)
    expect(stdout).toMatch(/ambiguous\s+ambiguous\s+-\s+https:\/\/auth\.circles\.ac/)
    expect(stdout).toMatch(/custom\s+missing\s+-\s+https:\/\/login\.example\.com/)
    expect(stdout).not.toContain(ambiguousToken)
    expect(stdout).not.toContain("opaque-key")
  })

  it("auth status treats default as current when no current profile is configured", async () => {
    setupProfile("default", { token: fakeJwt("default@circles.ac") })
    mockFetch({
      "GET /users/me": { status: 401, body: { message: "Unauthorized" } },
    })

    const { stdout, exitCode } = await crcl(["auth", "status"])

    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/default\s+\*\s+unauthorized\s+-\s+https:\/\/auth\.circles\.ac/)
  })

  it("whoami fails without auth", async () => {
    const { stderr, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Not authenticated")
  })

  it("logout removes profile", async () => {
    authedConfig()
    const { stdout, exitCode } = await crcl(["logout"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Logged out of profile 'default'")
    expect(readCredentials()).not.toContain("[default]")
  })

  it("logout --profile dev removes only dev", async () => {
    authedConfig()
    setupProfile("dev", { org: "acme", api_url: "https://api-dev.circles.ac" })

    const { stdout, exitCode } = await crcl(["logout", "--profile", "dev"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Logged out of profile 'dev'")

    // default still exists
    expect(readCredentials()).toContain("[default]")
    expect(readCredentials()).not.toContain("[dev]")
  })

  it("logout --all removes all profiles", async () => {
    authedConfig()
    setupProfile("dev", { org: "acme" })

    const { stdout, exitCode } = await crcl(["logout", "--all"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Logged out of all profiles")
  })

  it("logout removes the current email profile and clears its selection", async () => {
    setupProfile("default", { org: "acme" })
    setupProfile("alice@example.com", { org: "beta", token: fakeJwt("alice@example.com") })
    writeConfig(`[__circles__]\ncurrent_profile = alice@example.com\n\n${readConfig()}`)

    const { stdout, exitCode } = await crcl(["logout"])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Logged out of profile 'alice@example.com'")
    expect(readConfig()).not.toContain("current_profile")
    expect(readCredentials()).not.toContain("[alice@example.com]")
    expect(readCredentials()).toContain("[default]")
  })

  it("respects CRCL_AUTH_TOKEN env", async () => {
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"], { CRCL_AUTH_TOKEN: "env-token" })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
  })

  it("prefers CIRCLES_AUTH_TOKEN over the compatibility alias", async () => {
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"], {
      CIRCLES_AUTH_TOKEN: "canonical-token",
      CRCL_AUTH_TOKEN: "compatibility-token",
    })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
    expect(readCredentials()).not.toContain("canonical-token")
    expect(readCredentials()).not.toContain("compatibility-token")
  })

  it("auth token refreshes an expired shared profile before printing it", async () => {
    const expired = fakeJwt("expired@circles.ac", Date.now() - 60_000)
    const rotated = fakeJwt("rotated@circles.ac", Date.now() + 60_000)
    setupProfile("default", {
      auth_url: "https://issuer.example.test",
      token: expired,
      refresh: "old-refresh",
    })
    mockFetch({
      "POST /token": {
        status: 200,
        body: { access_token: rotated, refresh_token: "new-refresh" },
      },
    })
    let tokenOutput = ""
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      tokenOutput += String(chunk)
      return true
    }) as typeof process.stdout.write)

    const { exitCode } = await crcl(["auth", "token"])

    expect(exitCode).toBe(0)
    expect(tokenOutput).toBe(rotated)
    expect(readCredentials()).toContain(`access_token = ${rotated}`)
    expect(readCredentials()).toContain("refresh_token = new-refresh")
    expect(readCredentials()).not.toContain("old-refresh")
  })
})

// ── Config & Flags ────────────────────────────────────────────────────────

describe("config and flags", () => {
  it("--org flag overrides default org", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami", "--org", "beta"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Org:     beta")
  })

  it("CRCL_ORG env overrides default org", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"], { CRCL_ORG: "beta" })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Org:     beta")
  })

  it("--profile selects a different profile", async () => {
    authedConfig()
    setupProfile("dev", { org: "acme", api_url: "https://api-dev.circles.ac" })
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })

    const { stdout, exitCode } = await crcl(["whoami", "--profile", "dev"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("API:     https://api-dev.circles.ac")
    expect(stdout).toContain("Profile: dev")
  })

  it("--profile rejects unknown profile", async () => {
    authedConfig()
    const { stderr, exitCode } = await crcl(["whoami", "--profile", "nope"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("not found")
  })

  it("imports a legacy profile from XDG_CONFIG_HOME into the canonical shared files", async () => {
    const xdgHome = join(testHome, "xdg-config")
    mkdirSync(join(xdgHome, "crcl"), { recursive: true })
    writeFileSync(join(xdgHome, "crcl", "credentials"), `[default]\naccess_token = ${TEST_TOKEN}\n`)
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"], { XDG_CONFIG_HOME: xdgHome })
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
    expect(readCredentials()).toContain(TEST_TOKEN)
    expect(existsSync(join(xdgHome, "crcl", "credentials"))).toBe(true)
  })
})

// ── Whoami ────────────────────────────────────────────────────────────────

describe("whoami", () => {
  it("shows user info", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")
    expect(stdout).toContain("test@circles.ac")
    expect(stdout).toContain("Profile: default")
    expect(stdout).toContain("Org:     acme")
  })

  it("uses the shared current email profile without --profile", async () => {
    setupProfile("default", { org: "acme" })
    setupProfile("alice@example.com", { org: "beta", token: fakeJwt("alice@example.com") })
    writeConfig(`[__circles__]\ncurrent_profile = alice@example.com\n\n${readConfig()}`)
    mockFetch({ "GET /users/me": { status: 200, body: { ...ME_RESPONSE, email: "alice@example.com" } } })

    const { stdout, exitCode } = await crcl(["whoami"])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Email:   alice@example.com")
    expect(stdout).toContain("Profile: alice@example.com")
    expect(stdout).toContain("Org:     beta")
  })
})

// ── Orgs (mocked) ────────────────────────────────────────────────────────

describe("orgs (mocked)", () => {
  it("orgs list shows orgs with current marker", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["orgs", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("acme")
    expect(stdout).toContain("beta")
    expect(stdout).toContain("*")
  })

  it("orgs list shows empty message", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: { ...ME_RESPONSE, orgs: [] } } })
    const { stdout, exitCode } = await crcl(["orgs", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("No organizations found")
  })

  it("orgs create creates and sets default", async () => {
    authedConfig()
    mockFetch({ "POST /orgs/new": { status: 200, body: { id: 30, slug: "new-org", name: "New Org" } } })
    const { stdout, exitCode } = await crcl(["orgs", "create", "new-org", "New Org"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Organization created: new-org")
    expect(stdout).toContain("Set as current org: new-org")
    expect(readConfig()).toContain("org = new-org")
  })

  it("orgs switch verifies on server", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["orgs", "switch", "beta"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Switched to org: beta")
    expect(readConfig()).toContain("org = beta")
  })

  it("orgs switch updates the shared current email profile", async () => {
    setupProfile("default", { org: "acme" })
    setupProfile("alice@example.com", { org: "acme", token: fakeJwt("alice@example.com") })
    writeConfig(`[__circles__]\ncurrent_profile = alice@example.com\n\n${readConfig()}`)
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })

    const { exitCode } = await crcl(["orgs", "switch", "beta"])

    expect(exitCode).toBe(0)
    expect(readConfig()).toContain("[alice@example.com]\norg = beta")
    expect(readConfig()).toContain("[default]\norg = acme")
  })

  it("orgs switch rejects unknown slug", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stderr, exitCode } = await crcl(["orgs", "switch", "nonexistent"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("not found")
  })

  it("orgs update changes name", async () => {
    authedConfig()
    mockFetch({
      "PUT /orgs/acme": { status: 200, body: { id: 1, slug: "acme", name: "New Name" } },
    })
    const { stdout, exitCode } = await crcl(["orgs", "update", "--name", "New Name"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Organization updated")
  })

  it("orgs update changes slug and updates config", async () => {
    authedConfig()
    mockFetch({
      "PUT /orgs/acme": { status: 200, body: { id: 1, slug: "new-slug", name: "Acme" } },
    })
    const { stdout, exitCode } = await crcl(["orgs", "update", "--slug", "new-slug"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Local config updated")
    expect(readConfig()).toContain("org = new-slug")
  })

  it("orgs update requires --name or --slug", async () => {
    authedConfig()
    const { stderr, exitCode } = await crcl(["orgs", "update"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Nothing to update")
  })
})

// ── API Keys (mocked) ────────────────────────────────────────────────────

describe("apikeys (mocked)", () => {
  it("apikeys requires --user or --org", async () => {
    authedConfig()
    const { stderr, exitCode } = await crcl(["apikeys", "list"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("--user or --org")
  })

  it("apikeys list --org shows keys", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/api_keys": { status: 200, body: API_KEYS_RESPONSE } })
    const { stdout, exitCode } = await crcl(["apikeys", "list", "--org", "acme"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("k1")
    expect(stdout).toContain("dev-key")
  })

  it("apikeys create --org creates key", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/api_keys": { status: 200, body: [] },
      "POST /orgs/acme/api_keys": { status: 200, body: { id: "k2", key: "sk_full_key", name: "my-key", created_at: "2025-01-01T00:00:00Z" } },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "create", "--org", "acme", "my-key"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("API key created")
    expect(stdout).toContain("sk_full_key")
  })

  it("apikeys create --org adds a differently named key without --force", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/api_keys": { status: 200, body: API_KEYS_RESPONSE },
      "POST /orgs/acme/api_keys": { status: 200, body: { id: "k2", key: "sk_second", name: "ci-key", created_at: "2025-06-01T00:00:00Z" } },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "create", "--org", "acme", "ci-key"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("sk_second")
  })

  it("apikeys create --org blocks only a same-named key", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/api_keys": { status: 200, body: API_KEYS_RESPONSE } })
    const { stderr, exitCode } = await crcl(["apikeys", "create", "--org", "acme", "dev-key"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain('named "dev-key" already exists')
    expect(stderr).toContain("--force")
  })

  it("apikeys create --org --force replaces only the same-named key", async () => {
    authedConfig()
    const calls: string[] = []
    mockFetch({
      "GET /orgs/acme/api_keys": { status: 200, body: [
        ...API_KEYS_RESPONSE,
        { id: "k9", name: "prod-service", masked_key: "sk_...svc", created_at: "2025-01-01T00:00:00Z" },
      ] },
      "DELETE /orgs/acme/api_keys/k1": { status: 204 },
      "POST /orgs/acme/api_keys": { status: 200, body: { id: "k3", key: "sk_new", name: "dev-key", created_at: "2025-06-01T00:00:00Z" } },
    }, calls)
    const { stdout, exitCode } = await crcl(["apikeys", "create", "--org", "acme", "dev-key", "--force"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("sk_new")
    expect(stdout).toContain('Replaced 1 key(s) named "dev-key"')
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /orgs/acme/api_keys/k1"])
  })

  it("apikeys delete --org removes key", async () => {
    authedConfig()
    mockFetch({
      "DELETE /orgs/acme/api_keys/k1": { status: 204 },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "delete", "--org", "acme", "k1"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("API key k1 deleted")
  })

  it("apikeys list --user lists user-level keys", async () => {
    authedConfig()
    mockFetch({ "GET /users/me/api_keys": { status: 200, body: [{ id: "uk1", name: "my-user-key", masked_key: "sk_...usr", created_at: "2025-01-01T00:00:00Z" }] } })
    const { stdout, exitCode } = await crcl(["apikeys", "list", "--user"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("uk1")
  })

  it("apikeys create --user creates user-level key", async () => {
    authedConfig()
    mockFetch({
      "GET /users/me/api_keys": { status: 200, body: [] },
      "POST /users/me/api_keys": { status: 200, body: { id: "uk2", key: "sk_user_full", name: "user-key", created_at: "2025-01-01T00:00:00Z" } },
    })
    const { stdout, exitCode } = await crcl(["apikeys", "create", "--user", "user-key"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("User API key created")
    expect(stdout).toContain("sk_user_full")
  })

  it("apikeys create --user adds alongside existing keys and never deletes them", async () => {
    authedConfig()
    const calls: string[] = []
    mockFetch({
      "GET /users/me/api_keys": { status: 200, body: [
        { id: "uk1", name: "prism-proxy", masked_key: "sk_...pp", created_at: "2025-01-01T00:00:00Z" },
        { id: "uk2", name: "entropy-prod", masked_key: "sk_...en", created_at: "2025-01-01T00:00:00Z" },
      ] },
      "POST /users/me/api_keys": { status: 200, body: { id: "uk3", key: "sk_ci", name: "ci-key", created_at: "2025-06-01T00:00:00Z" } },
    }, calls)
    const { stdout, exitCode } = await crcl(["apikeys", "create", "--user", "ci-key"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("sk_ci")
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false)
  })

  it("apikeys create --user --force replaces only the same-named key", async () => {
    authedConfig()
    const calls: string[] = []
    mockFetch({
      "GET /users/me/api_keys": { status: 200, body: [
        { id: "uk1", name: "prism-proxy", masked_key: "sk_...pp", created_at: "2025-01-01T00:00:00Z" },
        { id: "uk2", name: "ci-key", masked_key: "sk_...ci", created_at: "2025-01-01T00:00:00Z" },
      ] },
      "DELETE /users/me/api_keys/uk2": { status: 204 },
      "POST /users/me/api_keys": { status: 200, body: { id: "uk3", key: "sk_ci_new", name: "ci-key", created_at: "2025-06-01T00:00:00Z" } },
    }, calls)
    const { stdout, exitCode } = await crcl(["apikeys", "create", "--user", "ci-key", "--force"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("sk_ci_new")
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /users/me/api_keys/uk2"])
  })

  it("apikeys delete --user deletes user-level key", async () => {
    authedConfig()
    mockFetch({ "DELETE /users/me/api_keys/uk1": { status: 204 } })
    const { stdout, exitCode } = await crcl(["apikeys", "delete", "--user", "uk1"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("User API key uk1 deleted")
  })
})

// ── Members (mocked) ──────────────────────────────────────────────────────

describe("members (mocked)", () => {
  it("members list shows members", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/members": { status: 200, body: MEMBERS_RESPONSE } })
    const { stdout, exitCode } = await crcl(["members", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("alice@circles.ac")
    expect(stdout).toContain("bob@circles.ac")
  })

  it("members list shows empty message", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/members": { status: 200, body: [] } })
    const { stdout, exitCode } = await crcl(["members", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("No members found")
  })

  it("members add adds a member", async () => {
    authedConfig()
    mockFetch({
      "POST /orgs/acme/members": { status: 200, body: { user_id: 3, email: "carol@circles.ac", name: "Carol", role: "member", created_at: "2025-03-01T00:00:00Z" } },
    })
    const { stdout, exitCode } = await crcl(["members", "add", "carol@circles.ac"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Added carol@circles.ac as member")
  })

  it("members role changes role", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/members": { status: 200, body: MEMBERS_RESPONSE },
      "PUT /orgs/acme/members/2": { status: 200, body: { ...MEMBERS_RESPONSE[1], role: "owner" } },
    })
    const { stdout, exitCode } = await crcl(["members", "role", "bob@circles.ac", "--role", "owner"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Updated bob@circles.ac to owner")
  })

  it("members remove removes a member", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/members": { status: 200, body: MEMBERS_RESPONSE },
      "DELETE /orgs/acme/members/2": { status: 204 },
    })
    const { stdout, exitCode } = await crcl(["members", "remove", "bob@circles.ac"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Removed bob@circles.ac")
  })

  it("members role rejects unknown email", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/members": { status: 200, body: MEMBERS_RESPONSE } })
    const { stderr, exitCode } = await crcl(["members", "role", "nope@circles.ac", "--role", "owner"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("not found")
  })
})

// ── Groups (mocked) ───────────────────────────────────────────────────────

describe("groups (mocked)", () => {
  it("groups list shows groups", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/groups": { status: 200, body: GROUPS_RESPONSE } })
    const { stdout, exitCode } = await crcl(["groups", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("eng")
    expect(stdout).toContain("design")
  })

  it("groups list shows empty message", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/groups": { status: 200, body: [] } })
    const { stdout, exitCode } = await crcl(["groups", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("No groups found")
  })

  it("groups create posts and prints alias", async () => {
    authedConfig()
    mockFetch({
      "POST /orgs/acme/groups": { status: 200, body: GROUPS_RESPONSE[0] },
    })
    const { stdout, exitCode } = await crcl(["groups", "create", "Engineering", "--alias", "eng"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Group created: eng (Engineering)")
  })

  it("groups update resolves by alias and PUTs by id", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/groups": { status: 200, body: GROUPS_RESPONSE },
      "PUT /orgs/acme/groups/10": { status: 200, body: { ...GROUPS_RESPONSE[0], name: "Eng Team" } },
    })
    const { stdout, exitCode } = await crcl(["groups", "update", "eng", "--name", "Eng Team"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Group updated: eng (Eng Team)")
  })

  it("groups update requires a field", async () => {
    authedConfig()
    const { stderr, exitCode } = await crcl(["groups", "update", "eng"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Nothing to update")
  })

  it("groups delete resolves alias and DELETEs", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/groups": { status: 200, body: GROUPS_RESPONSE },
      "DELETE /orgs/acme/groups/10": { status: 204 },
    })
    const { stdout, exitCode } = await crcl(["groups", "delete", "eng"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Deleted group eng")
  })

  it("groups delete by numeric id fetches single group", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/groups/10": { status: 200, body: GROUPS_RESPONSE[0] },
      "DELETE /orgs/acme/groups/10": { status: 204 },
    })
    const { stdout, exitCode } = await crcl(["groups", "delete", "10"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Deleted group eng")
  })

  it("groups delete rejects unknown alias", async () => {
    authedConfig()
    mockFetch({ "GET /orgs/acme/groups": { status: 200, body: GROUPS_RESPONSE } })
    const { stderr, exitCode } = await crcl(["groups", "delete", "nope"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("not found")
  })

  it("groups members list shows members", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/groups/10/members": { status: 200, body: GROUP_MEMBERS_RESPONSE },
      "GET /orgs/acme/groups": { status: 200, body: GROUPS_RESPONSE },
    })
    const { stdout, exitCode } = await crcl(["groups", "members", "list", "eng"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("alice@circles.ac")
  })

  it("groups members add resolves user by email", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/groups": { status: 200, body: GROUPS_RESPONSE },
      "GET /orgs/acme/members": { status: 200, body: MEMBERS_RESPONSE },
      "POST /orgs/acme/groups/10/members": { status: 200, body: GROUP_MEMBERS_RESPONSE[0] },
    })
    const { stdout, exitCode } = await crcl(["groups", "members", "add", "eng", "alice@circles.ac", "--role", "admin"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Added alice@circles.ac to eng as admin")
  })

  it("groups members add accepts numeric user id without lookup", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/groups": { status: 200, body: GROUPS_RESPONSE },
      "POST /orgs/acme/groups/10/members": { status: 200, body: GROUP_MEMBERS_RESPONSE[0] },
    })
    const { stdout, exitCode } = await crcl(["groups", "members", "add", "eng", "1"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Added alice@circles.ac to eng as admin")
  })

  it("groups members remove resolves user by email", async () => {
    authedConfig()
    mockFetch({
      "GET /orgs/acme/groups": { status: 200, body: GROUPS_RESPONSE },
      "GET /orgs/acme/members": { status: 200, body: MEMBERS_RESPONSE },
      "DELETE /orgs/acme/groups/10/members/1": { status: 204 },
    })
    const { stdout, exitCode } = await crcl(["groups", "members", "remove", "eng", "alice@circles.ac"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Removed alice@circles.ac from eng")
  })
})

// ── Token Refresh ─────────────────────────────────────────────────────────

describe("token refresh", () => {
  it("auto-refreshes on 401", async () => {
    authedConfig({ refresh_token: "old-refresh" })
    const newToken = fakeJwt("refreshed@circles.ac")
    mockFetch({
      "POST /token": { status: 200, body: { access_token: newToken, refresh_token: "new-refresh" } },
      "GET /users/me": [
        { status: 401, body: { message: "Unauthorized" } },
        { status: 200, body: ME_RESPONSE },
      ],
    })

    const { stdout, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")

    const creds = readCredentials()
    expect(creds).toContain(newToken)
    expect(creds).toContain("new-refresh")
  })
})

// ── Profiles ──────────────────────────────────────────────────────────────

describe("profiles", () => {
  it("stores a plain production login under its server and verified email", async () => {
    const mod = await import("../src/index")
    const target = await mod.saveLoginProfile(
      undefined,
      " Alice+CLI@Example.com ",
      { apiUrl: "https://api.circles.ac", authUrl: "https://auth.circles.ac", org: "acme" },
      { accessToken: TEST_TOKEN, refreshToken: "login-refresh" },
    )

    expect(target).toEqual({ profile: "prod:alice+cli@example.com", becameCurrent: true, currentProfile: "prod:alice+cli@example.com" })
    // First login: no current profile existed, so this one becomes current.
    expect(readConfig()).toContain("[__circles__]\ncurrent_profile = prod:alice+cli@example.com")
    expect(readConfig()).toContain("[prod:alice+cli@example.com]")
    expect(readConfig()).toContain("api_url = https://api.circles.ac")
    expect(readConfig()).toContain("auth_url = https://auth.circles.ac")
    expect(readCredentials()).toContain("[prod:alice+cli@example.com]")
    expect(readCredentials()).not.toContain("[default]")
    expect(readCredentials().match(new RegExp(TEST_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1)
  })

  it("keeps the same email in a separate development profile", async () => {
    const mod = await import("../src/index")
    const target = await mod.saveLoginProfile(
      undefined,
      "alice@example.com",
      { apiUrl: "https://api-dev.circles.ac", authUrl: "https://auth-dev.circles.ac" },
      { accessToken: TEST_TOKEN, refreshToken: "dev-refresh" },
    )

    expect(target.profile).toBe("dev:alice@example.com")
    expect(readConfig()).toContain("api_url = https://api-dev.circles.ac")
    expect(readConfig()).toContain("auth_url = https://auth-dev.circles.ac")
    expect(readCredentials()).toContain("[dev:alice@example.com]")
  })

  it("a later login adds its profile without stealing the current one", async () => {
    const mod = await import("../src/index")
    const first = await mod.saveLoginProfile(
      undefined,
      "first@circles.ac",
      { apiUrl: "https://api.circles.ac", authUrl: "https://auth.circles.ac" },
      { accessToken: TEST_TOKEN, refreshToken: "first-refresh" },
    )
    const second = await mod.saveLoginProfile(
      undefined,
      "second@circles.ac",
      { apiUrl: "https://api.circles.ac", authUrl: "https://auth.circles.ac" },
      { accessToken: TEST_TOKEN, refreshToken: "second-refresh" },
    )

    expect(first.becameCurrent).toBe(true)
    expect(second).toEqual({ profile: "prod:second@circles.ac", becameCurrent: false, currentProfile: "prod:first@circles.ac" })
    expect(readConfig()).toContain("current_profile = prod:first@circles.ac")
    expect(readCredentials()).toContain("[prod:second@circles.ac]")
  })

  it("crcl use switches the current profile and rejects unknown names", async () => {
    setupProfile("prod:first@circles.ac", { token: fakeJwt("first@circles.ac") })
    setupProfile("prod:second@circles.ac", { token: fakeJwt("second@circles.ac") })

    const switched = await crcl(["use", "prod:second@circles.ac"])
    expect(switched.exitCode).toBe(0)
    expect(switched.stdout).toContain("Current profile: prod:second@circles.ac")
    expect(readConfig()).toContain("current_profile = prod:second@circles.ac")

    const unknown = await crcl(["use", "prod:missing@circles.ac"])
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stderr).toContain("Profile 'prod:missing@circles.ac' not found.")
    expect(unknown.stderr).toContain("prod:first@circles.ac")
    expect(readConfig()).toContain("current_profile = prod:second@circles.ac")
  })

  it("multiple profiles with different URLs", async () => {
    authedConfig()
    setupProfile("dev", { org: "acme", api_url: "https://api-dev.circles.ac" })

    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout: devOut } = await crcl(["whoami", "--profile", "dev"])
    expect(devOut).toContain("API:     https://api-dev.circles.ac")
    expect(devOut).toContain("Profile: dev")
  })

  it("CRCL_PROFILE env selects profile", async () => {
    authedConfig()
    setupProfile("dev", { org: "acme", api_url: "https://api-dev.circles.ac" })

    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout } = await crcl(["whoami"], { CRCL_PROFILE: "dev" })
    expect(stdout).toContain("Profile: dev")
  })

  it("CIRCLES_PROFILE takes precedence over CRCL_PROFILE", async () => {
    setupProfile("canonical", { org: "acme" })
    setupProfile("compatibility", { org: "acme" })
    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })

    const { stdout } = await crcl(["whoami"], {
      CIRCLES_PROFILE: "canonical",
      CRCL_PROFILE: "compatibility",
    })
    expect(stdout).toContain("Profile: canonical")
  })
})

// ── INI format ───────────────────────────────────────────────────────────

describe("INI format", () => {
  it("config and credentials are separate files", async () => {
    authedConfig()
    expect(existsSync(configPath())).toBe(true)
    expect(existsSync(credentialsPath())).toBe(true)

    const config = readConfig()
    const creds = readCredentials()

    // Config should have org, not tokens
    expect(config).toContain("org = acme")
    expect(config).not.toContain("access_token")

    // Credentials should have tokens, not org
    expect(creds).toContain("access_token")
    expect(creds).not.toContain("org")
  })
})

// ── Config Migration ──────────────────────────────────────────────────────

describe("config migration", () => {
  it("migrates legacy config.json to INI files", async () => {
    // Write old-style config.json
    const dir = join(testHome, ".config", "crcl")
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      accounts: {
        "test@circles.ac [default]": {
          access_token: TEST_TOKEN,
          refresh_token: "old-refresh",
          api_url: "https://api-dev.circles.ac",
          orgs: { "1": { slug: "acme", default: true } },
        },
      },
    }))

    mockFetch({ "GET /users/me": { status: 200, body: ME_RESPONSE } })
    const { stdout, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Test User")

    // The rollback source is retained.
    expect(existsSync(join(dir, "config.json"))).toBe(true)

    // New files should exist
    const config = readConfig()
    const creds = readCredentials()
    expect(config).toContain("api_url = https://api-dev.circles.ac")
    expect(config).toContain("org = acme")
    expect(creds).toContain("access_token")
  })
})

// ── emailFromJwt ──────────────────────────────────────────────────────────

describe("emailFromJwt", () => {
  it("extracts email from JWT", async () => {
    const mod = await import("../src/index")
    expect(mod.emailFromJwt(TEST_TOKEN)).toBe("test@circles.ac")
  })

  it("returns null for invalid JWT", async () => {
    const mod = await import("../src/index")
    expect(mod.emailFromJwt("not-a-jwt")).toBeNull()
  })
})

// ── Error Handling ────────────────────────────────────────────────────────

describe("error handling", () => {
  it("api shows error message from server", async () => {
    authedConfig()
    mockFetch({ "GET /users/me": { status: 403, body: { message: "Forbidden" } } })
    const { stderr, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Error 403: Forbidden")
  })
})
