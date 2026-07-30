#!/usr/bin/env bun

import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname } from "node:path"
import {
  createCredentialProvider,
  CredentialErrorCode,
  isCredentialError,
  type CredentialKind,
  type CredentialSource,
  type ProfileConfig,
  type SharedCredentialProvider,
} from "@circlesac/credentials"
import { defineCommand, runMain } from "citty"
import pkg from "../package.json"
import { checkForUpdate } from "./lib/update-check"

const VERSION = pkg.version || "0.0.0"

const DEFAULT_API_URL = "https://api.circles.ac"
const DEFAULT_AUTH_URL = "https://auth.circles.ac"
const DEV_API_URL = "https://api-dev.circles.ac"
const DEV_AUTH_URL = "https://auth-dev.circles.ac"
const CLIENT_ID = "circles-api"

// ── Config types ─────────────────────────────────────────────────────────

export type Config = {
  profile: string
  api_url: string
  auth_url: string
  access_token: string | null
  credential_kind: CredentialKind | null
  credential_source: CredentialSource | null
  credential_provider: SharedCredentialProvider
  org: string | null
  email: string | null
}

export function getDefaultOrg(config: { orgs?: Record<string, { slug: string; default?: boolean }> }) {
  for (const [id, entry] of Object.entries(config.orgs ?? {})) {
    if (entry.default) return { id, entry }
  }
  return null
}

type UserMe = {
  id: number
  email: string
  name: string
  orgs: Array<{ id: number; slug: string; name: string; role: string }>
}

type ApiKey = {
  id: string
  name: string
  masked_key: string
  created_at: string
}

type Member = {
  user_id: number
  email: string | null
  name: string | null
  role: string
  created_at: string
}

type Group = {
  id: number
  org_id: number
  name: string
  alias: string
  description: string | null
  created_at: string
}

type GroupMember = {
  user_id: number
  email: string | null
  name: string | null
  role: string
  created_at: string
}

export function emailFromJwt(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
    return payload.email || null
  } catch {
    return null
  }
}

export function normalizeBaseURL(value: string): string {
  return value.replace(/\/+$/, "")
}

// ── Load / Save ──────────────────────────────────────────────────────────

type LoadConfigOpts = {
  org?: string
  profile?: string
  apiUrl?: string
  authUrl?: string
}

async function loadConfig(opts: LoadConfigOpts = {}, allowNewProfile = false): Promise<Config> {
  const credentialProvider = createCredentialProvider({ profile: opts.profile })
  const profile = await credentialProvider.getSelectedProfileName()
  const storedProfile = await credentialProvider.getProfile()
  let credential: Awaited<ReturnType<SharedCredentialProvider["resolve"]>> | undefined

  try {
    credential = await credentialProvider.resolve()
  } catch (error) {
    if (!isCredentialError(error, CredentialErrorCode.NotFound)) {
      if (isCredentialError(error)) {
        console.error(`Authentication failed (${error.code}): ${error.message}`)
        process.exit(1)
      }
      throw error
    }
    if (!allowNewProfile && (opts.profile || process.env.CIRCLES_PROFILE || process.env.CRCL_PROFILE) && !storedProfile) {
      console.error(`Profile '${profile}' not found.`)
      process.exit(1)
    }
  }

  const section = storedProfile?.config
  return {
    profile,
    api_url: normalizeBaseURL(opts.apiUrl || process.env.CRCL_API_URL || section?.apiUrl || DEFAULT_API_URL),
    auth_url: normalizeBaseURL(opts.authUrl || process.env.CRCL_AUTH_URL || section?.authUrl || DEFAULT_AUTH_URL),
    access_token: credential?.value || null,
    credential_kind: credential?.kind || null,
    credential_source: credential?.source || null,
    credential_provider: credentialProvider,
    org: opts.org || process.env.CRCL_ORG || section?.org || null,
    email: credential?.kind === "jwt" ? emailFromJwt(credential.value) : null,
  }
}

function selectedLoginProfile(profile?: string): string | undefined {
  if (profile !== undefined) return profile
  if (Object.hasOwn(process.env, "CIRCLES_PROFILE")) return process.env.CIRCLES_PROFILE
  if (Object.hasOwn(process.env, "CRCL_PROFILE")) return process.env.CRCL_PROFILE
  return undefined
}

async function loadLoginConfig(opts: LoadConfigOpts): Promise<{ config: Config; profile?: string }> {
  const profile = selectedLoginProfile(opts.profile)
  if (profile !== undefined) {
    return { config: await loadConfig({ ...opts, profile }, true), profile }
  }

  const credentialProvider = createCredentialProvider({ profile: "default" })
  return {
    config: {
      profile: "default",
      api_url: normalizeBaseURL(opts.apiUrl || process.env.CRCL_API_URL || DEFAULT_API_URL),
      auth_url: normalizeBaseURL(opts.authUrl || process.env.CRCL_AUTH_URL || DEFAULT_AUTH_URL),
      access_token: null,
      credential_kind: null,
      credential_source: null,
      credential_provider: credentialProvider,
      org: opts.org || process.env.CRCL_ORG || null,
      email: null,
    },
  }
}

// ── API Client ──────────────────────────────────────────────────────────────

async function api<T = unknown>(
  config: Config,
  path: string,
  opts: { method?: string; body?: unknown; noExit?: boolean } = {}
): Promise<{ data: T; status: number }> {
  const url = `${config.api_url}${path}`
  const headers: Record<string, string> = {}

  if (config.access_token) {
    headers["Authorization"] = `Bearer ${config.access_token}`
  }
  if (opts.body) {
    headers["Content-Type"] = "application/json"
  }

  const doFetch = () =>
    fetch(url, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })

  let res = await doFetch()

  if (res.status === 401 && config.credential_kind === "jwt" && config.credential_source?.type === "profile") {
    try {
      const credential = await config.credential_provider.refresh()
      config.access_token = credential.value
      config.credential_kind = credential.kind
      config.credential_source = credential.source
      headers["Authorization"] = `Bearer ${credential.value}`
      res = await doFetch()
    } catch (error) {
      if (opts.noExit) return { data: undefined as T, status: res.status }
      if (isCredentialError(error)) {
        console.error(`Authentication refresh failed (${error.code}). Run: crcl login --profile ${config.profile}`)
        process.exit(1)
      }
      throw error
    }
  }

  if (!res.ok) {
    if (opts.noExit) return { data: undefined as T, status: res.status }
    const text = await res.text()
    let message: string
    try {
      message = JSON.parse(text).message || text
    } catch {
      message = text
    }
    console.error(`Error ${res.status}: ${message}`)
    process.exit(1)
  }

  if (res.status === 204) return { data: undefined as T, status: 204 }
  return { data: (await res.json()) as T, status: res.status }
}

function requireAuth(config: Config): asserts config is Config & { access_token: string } {
  if (!config.access_token) {
    console.error("Not authenticated. Run: crcl login")
    process.exit(1)
  }
}

function orgPath(slug: string, ...segments: string[]) {
  return `/orgs/${encodeURIComponent(slug)}${segments.length ? "/" + segments.map(encodeURIComponent).join("/") : ""}`
}

// ── Org Resolution ──────────────────────────────────────────────────────────

async function resolveOrg(config: Config): Promise<{ org_slug: string }> {
  requireAuth(config)

  if (!config.org) {
    console.error("No org selected. Run: crcl orgs switch <slug>")
    process.exit(1)
  }

  return { org_slug: config.org }
}

// ── Login ───────────────────────────────────────────────────────────────────

export function circlesOAuthEnvironment(apiUrl: string, authUrl: string): "prod" | "dev" | undefined {
  const endpointOrigin = (value: string): string | undefined => {
    try {
      const endpoint = new URL(normalizeBaseURL(value))
      if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
        return undefined
      }
      return endpoint.origin
    } catch {
      return undefined
    }
  }
  const normalizedAPIURL = endpointOrigin(apiUrl)
  const normalizedAuthURL = endpointOrigin(authUrl)
  if (normalizedAPIURL === DEFAULT_API_URL && normalizedAuthURL === DEFAULT_AUTH_URL) return "prod"
  if (normalizedAPIURL === DEV_API_URL && normalizedAuthURL === DEV_AUTH_URL) return "dev"
  return undefined
}

export function profileFromVerifiedEmail(email: string, environment: "prod" | "dev"): string {
  const normalizedEmail = email.trim().replace(/[A-Z]/g, (character) => character.toLowerCase())
  return `${environment}:${normalizedEmail}`
}

export async function saveLoginProfile(
  profile: string | undefined,
  email: string,
  profileConfig: ProfileConfig,
  credentials: { accessToken: string; refreshToken: string },
): Promise<string> {
  const environment = circlesOAuthEnvironment(profileConfig.apiUrl ?? "", profileConfig.authUrl ?? "")
  if (!profile && !environment) {
    throw new Error("Automatic profile naming requires matching official Circles production or development endpoints.")
  }
  const targetProfile = profile ?? profileFromVerifiedEmail(email, environment!)
  const credentialProvider = createCredentialProvider({ profile: targetProfile })
  await credentialProvider.updateProfile({ config: profileConfig, credentials })
  await credentialProvider.setCurrentProfile(targetProfile)
  return targetProfile
}

async function cmdLogin(config: Config, profile?: string) {
  if (!profile && !circlesOAuthEnvironment(config.api_url, config.auth_url)) {
    console.error("--profile is required with custom or mixed Circles endpoints.")
    console.error("Example: crcl login --api-url https://api.example.com --auth-url https://auth.example.com --profile myprofile")
    process.exit(1)
  }
  const state = randomBytes(16).toString("hex")
  const { port, waitForCode } = await startCallbackServer(state)
  const redirectUri = `http://localhost:${port}/callback`

  const authUrl = new URL(`${config.auth_url}/authorize`)
  authUrl.searchParams.set("client_id", CLIENT_ID)
  authUrl.searchParams.set("redirect_uri", redirectUri)
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("provider", "google")
  authUrl.searchParams.set("state", state)

  console.log("Opening browser for authentication...")
  console.log(`If it doesn't open, visit: ${authUrl}`)
  openBrowser(authUrl.toString())

  const code = await waitForCode

  const tokenRes = await fetch(`${config.auth_url}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
    }),
  })

  if (!tokenRes.ok) {
    console.error("Failed to exchange authorization code")
    process.exit(1)
  }

  const tokenData = (await tokenRes.json()) as { access_token: string; refresh_token: string }

  // Fetch user info
  const authedConfig: Config = { ...config, access_token: tokenData.access_token }
  const { data: me } = await api<UserMe>(authedConfig, "/users/me")

  console.log(`\nAuthenticated as ${me.name || me.email}`)

  // Save config (api_url, auth_url, org)
  const conf: ProfileConfig = { apiUrl: config.api_url, authUrl: config.auth_url }

  // Set default org
  const requestedOrg = config.org
  if (requestedOrg) {
    const org = me.orgs.find((o) => o.slug === requestedOrg)
    if (org) {
      conf.org = org.slug
      console.log(`Using org: ${org.slug}`)
    } else {
      console.error(`Org '${requestedOrg}' not found.`)
      if (me.orgs.length > 0) {
        conf.org = me.orgs[0].slug
        console.log(`Using org: ${me.orgs[0].slug}`)
      }
    }
  } else if (me.orgs.length > 0) {
    console.log("\nYour organizations:")
    for (const o of me.orgs) {
      console.log(`  ${o.slug} (${o.name}) [${o.role}]`)
    }
    conf.org = me.orgs[0].slug
    console.log(`\nUsing org: ${me.orgs[0].slug}`)
  } else {
    console.log("\nNo organizations found. Create one with: crcl orgs create <slug> <name>")
  }

  const targetProfile = await saveLoginProfile(profile, me.email, conf, {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
  })

  console.log(`Profile: ${targetProfile}`)
  console.log(`Config saved to ${dirname(config.credential_provider.paths.configFile)}`)
}

export function startCallbackServer(expectedState: string): Promise<{ port: number; waitForCode: Promise<string> }> {
  return new Promise((resolveServer) => {
    let resolveCode: (code: string) => void

    const waitForCode = new Promise<string>((resolve) => {
      resolveCode = resolve
    })

    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`)
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("Invalid state parameter")
        } else if (code) {
          res.writeHead(200, { "Content-Type": "text/html" })
          res.end("<html><body><h2>Authentication successful!</h2><p>You can close this window.</p></body></html>")
          resolveCode(code)
          setTimeout(() => server.close(), 500)
        } else {
          res.writeHead(400, { "Content-Type": "text/plain" })
          res.end("Missing authorization code")
        }
      }
    })

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolveServer({ port, waitForCode })
    })
  })
}

function openBrowser(url: string) {
  if (process.platform === "darwin") {
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" })
  } else if (process.platform === "win32") {
    Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" })
  } else {
    Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" })
  }
}

// ── Orgs ────────────────────────────────────────────────────────────────────

async function cmdOrgsList(config: Config) {
  requireAuth(config)

  const { data: me } = await api<UserMe>(config, "/users/me")

  if (me.orgs.length === 0) {
    console.log("No organizations found.")
    return
  }

  console.log(`${"Slug".padEnd(24)} ${"Name".padEnd(30)} Role`)
  console.log("─".repeat(64))
  for (const o of me.orgs) {
    const marker = config.org === o.slug ? " *" : ""
    console.log(`${o.slug.padEnd(24)} ${o.name.padEnd(30)} ${o.role}${marker}`)
  }
}

async function cmdOrgsCreate(config: Config, args: string[]) {
  requireAuth(config)

  const slug = args[0]
  const name = args.slice(1).join(" ") || slug
  if (!slug) {
    console.error("Usage: crcl orgs create <slug> [name]")
    process.exit(1)
  }

  const { data: org } = await api<{ id: number; slug: string; name: string }>(
    config,
    "/orgs/new",
    { method: "POST", body: { slug, name } }
  )

  console.log(`Organization created: ${org.slug} (${org.name})`)

  await config.credential_provider.updateProfile({ config: { org: org.slug } })
  console.log(`Set as current org: ${org.slug}`)
}

async function cmdOrgsUpdate(config: Config, opts: { name?: string; slug?: string }) {
  const body: Record<string, string> = {}
  if (opts.name) body.name = opts.name
  if (opts.slug) body.new_slug = opts.slug

  if (Object.keys(body).length === 0) {
    console.error("Nothing to update. Use --name or --slug.")
    process.exit(1)
  }

  const { org_slug } = await resolveOrg(config)

  const { data: updated } = await api<{ id: number; slug: string; name: string }>(
    config,
    orgPath(org_slug),
    { method: "PUT", body }
  )

  console.log(`Organization updated: ${updated.slug} (${updated.name})`)

  if (opts.slug && opts.slug !== org_slug) {
    await config.credential_provider.updateProfile({ config: { org: updated.slug } })
    console.log(`Local config updated: ${org_slug} → ${updated.slug}`)
  }
}

async function cmdOrgsSwitch(config: Config, args: string[]) {
  requireAuth(config)

  const slug = args[0]
  if (!slug) {
    console.error("Usage: crcl orgs switch <slug>")
    process.exit(1)
  }

  // Verify org exists on server
  const { data: me } = await api<UserMe>(config, "/users/me")
  const org = me.orgs.find((o) => o.slug === slug)

  if (!org) {
    console.error(`Org '${slug}' not found. Your orgs:`)
    for (const o of me.orgs) console.error(`  ${o.slug}`)
    process.exit(1)
  }

  await config.credential_provider.updateProfile({ config: { org: org.slug } })
  console.log(`Switched to org: ${org.slug} (${org.name})`)
}

// ── API Keys ────────────────────────────────────────────────────────────────

function requireScope(opts: { user?: boolean; org?: string }): "user" | "org" {
  if (opts.user && opts.org) {
    console.error("Cannot use both --user and --org.")
    process.exit(1)
  }
  if (!opts.user && !opts.org) {
    console.error("Specify --user or --org <slug>.")
    process.exit(1)
  }
  return opts.user ? "user" : "org"
}

async function cmdApikeysList(config: Config, opts: { user?: boolean }) {
  if (opts.user) {
    requireAuth(config)
    const { data: keys } = await api<ApiKey[]>(config, "/users/me/api_keys")
    if (keys.length === 0) { console.log("No user API keys found."); return }
    console.log(`${"ID".padEnd(12)} ${"Name".padEnd(30)} ${"Key".padEnd(18)} Created`)
    console.log("─".repeat(80))
    for (const k of keys) {
      const date = new Date(k.created_at).toLocaleDateString()
      console.log(`${k.id.padEnd(12)} ${k.name.padEnd(30)} ${k.masked_key.padEnd(18)} ${date}`)
    }
    return
  }

  const { org_slug } = await resolveOrg(config)
  const { data: keys } = await api<ApiKey[]>(config, orgPath(org_slug, "api_keys"))

  if (keys.length === 0) {
    console.log("No API keys found.")
    return
  }

  console.log(`${"ID".padEnd(12)} ${"Name".padEnd(30)} ${"Key".padEnd(18)} Created`)
  console.log("─".repeat(80))
  for (const k of keys) {
    const date = new Date(k.created_at).toLocaleDateString()
    console.log(`${k.id.padEnd(12)} ${k.name.padEnd(30)} ${k.masked_key.padEnd(18)} ${date}`)
  }
}

async function cmdApikeysCreate(config: Config, args: string[], opts: { user?: boolean }) {
  const force = args.includes("--force") || args.includes("-y")
  const cleanArgs = args.filter((a) => a !== "--force" && a !== "-y")
  const name = cleanArgs.join(" ") || `crcl-${new Date().toISOString().slice(0, 10)}`

  if (opts.user) {
    requireAuth(config)
    const { data: existing } = await api<ApiKey[]>(config, "/users/me/api_keys")

    if (existing.length > 0 && !force) {
      console.error(`User API key already exists:`)
      for (const k of existing) console.error(`  ${k.id}  ${k.name}  ${k.masked_key}`)
      console.error(`\nUse --force or -y to delete existing key(s) and create a new one.`)
      process.exit(1)
    }

    if (existing.length > 0 && force) {
      for (const k of existing) await api(config, `/users/me/api_keys/${encodeURIComponent(k.id)}`, { method: "DELETE" })
      console.log(`Deleted ${existing.length} existing key(s).`)
    }

    const { data: key } = await api<{ id: string; key: string; name: string; created_at: string }>(
      config, "/users/me/api_keys", { method: "POST", body: { name } }
    )

    console.log(`User API key created:`)
    console.log(`  ID:   ${key.id}`)
    console.log(`  Name: ${key.name}`)
    console.log(`  Key:  ${key.key}`)
    console.log(`\nSave this key — it won't be shown again.`)
    return
  }

  const { org_slug } = await resolveOrg(config)

  // Check for existing keys
  const { data: existing } = await api<ApiKey[]>(
    config,
    orgPath(org_slug, "api_keys")
  )

  if (existing.length > 0 && !force) {
    console.error(`API key already exists for org '${org_slug}':`)
    for (const k of existing) {
      console.error(`  ${k.id}  ${k.name}  ${k.masked_key}`)
    }
    console.error(`\nUse --force or -y to delete existing key(s) and create a new one.`)
    process.exit(1)
  }

  // Delete existing keys if --force
  if (existing.length > 0 && force) {
    for (const k of existing) {
      await api(config, orgPath(org_slug, "api_keys", k.id), { method: "DELETE" })
    }
    console.log(`Deleted ${existing.length} existing key(s).`)
  }

  const { data: key } = await api<{ id: string; key: string; name: string; created_at: string }>(
    config,
    orgPath(org_slug, "api_keys"),
    { method: "POST", body: { name } }
  )

  console.log(`API key created:`)
  console.log(`  ID:   ${key.id}`)
  console.log(`  Name: ${key.name}`)
  console.log(`  Key:  ${key.key}`)
  console.log(`\nSave this key — it won't be shown again.`)
}

async function cmdApikeysDelete(config: Config, args: string[], opts: { user?: boolean }) {
  const keyId = args[0]
  if (!keyId) {
    console.error("Usage: crcl apikeys delete <key_id>")
    process.exit(1)
  }

  if (opts.user) {
    requireAuth(config)
    await api(config, `/users/me/api_keys/${encodeURIComponent(keyId)}`, { method: "DELETE" })
    console.log(`User API key ${keyId} deleted.`)
    return
  }

  const { org_slug } = await resolveOrg(config)

  await api(config, orgPath(org_slug, "api_keys", keyId), { method: "DELETE" })

  console.log(`API key ${keyId} deleted.`)
}

// ── Members ─────────────────────────────────────────────────────────────────

async function cmdMembersList(config: Config) {
  const { org_slug } = await resolveOrg(config)
  const { data: members } = await api<Member[]>(config, orgPath(org_slug, "members"))

  if (members.length === 0) {
    console.log("No members found.")
    return
  }

  console.log(`${"ID".padEnd(8)} ${"Email".padEnd(30)} ${"Name".padEnd(20)} Role`)
  console.log("─".repeat(72))
  for (const m of members) {
    console.log(`${String(m.user_id).padEnd(8)} ${(m.email || "-").padEnd(30)} ${(m.name || "-").padEnd(20)} ${m.role}`)
  }
}

async function cmdMembersAdd(config: Config, email: string, role: string) {
  const { org_slug } = await resolveOrg(config)
  const { data: member } = await api<Member>(
    config,
    orgPath(org_slug, "members"),
    { method: "POST", body: { email, role } }
  )
  console.log(`Added ${member.email} as ${member.role}.`)
}

async function resolveMemberByEmail(config: Config, org_slug: string, email: string): Promise<Member> {
  const { data: members } = await api<Member[]>(config, orgPath(org_slug, "members"))
  const member = members.find((m) => m.email === email)
  if (!member) {
    console.error(`Member '${email}' not found in org.`)
    process.exit(1)
  }
  return member
}

async function cmdMembersRole(config: Config, email: string, role: string) {
  const { org_slug } = await resolveOrg(config)
  const existing = await resolveMemberByEmail(config, org_slug, email)
  const { data: member } = await api<Member>(
    config,
    orgPath(org_slug, "members", String(existing.user_id)),
    { method: "PUT", body: { role } }
  )
  console.log(`Updated ${member.email} to ${member.role}.`)
}

async function cmdMembersRemove(config: Config, email: string) {
  const { org_slug } = await resolveOrg(config)
  const existing = await resolveMemberByEmail(config, org_slug, email)
  await api(config, orgPath(org_slug, "members", String(existing.user_id)), { method: "DELETE" })
  console.log(`Removed ${email}.`)
}

// ── Groups ──────────────────────────────────────────────────────────────────

async function resolveGroup(config: Config, org_slug: string, ref: string): Promise<Group> {
  if (/^\d+$/.test(ref)) {
    const { data } = await api<Group>(config, orgPath(org_slug, "groups", ref))
    return data
  }
  const { data: groups } = await api<Group[]>(config, orgPath(org_slug, "groups"))
  const g = groups.find((x) => x.alias === ref)
  if (!g) {
    console.error(`Group '${ref}' not found.`)
    process.exit(1)
  }
  return g
}

async function resolveUserRef(config: Config, org_slug: string, ref: string): Promise<{ user_id: number; email: string | null }> {
  if (/^\d+$/.test(ref)) return { user_id: Number(ref), email: null }
  const { data: members } = await api<Member[]>(config, orgPath(org_slug, "members"))
  const m = members.find((x) => x.email === ref)
  if (!m) {
    console.error(`User '${ref}' not found in org.`)
    process.exit(1)
  }
  return { user_id: m.user_id, email: m.email }
}

async function cmdGroupsList(config: Config) {
  const { org_slug } = await resolveOrg(config)
  const { data: groups } = await api<Group[]>(config, orgPath(org_slug, "groups"))

  if (groups.length === 0) {
    console.log("No groups found.")
    return
  }

  console.log(`${"ID".padEnd(6)} ${"Alias".padEnd(24)} ${"Name".padEnd(30)} Description`)
  console.log("─".repeat(80))
  for (const g of groups) {
    console.log(`${String(g.id).padEnd(6)} ${g.alias.padEnd(24)} ${g.name.padEnd(30)} ${g.description || "-"}`)
  }
}

async function cmdGroupsCreate(config: Config, name: string, opts: { alias?: string; description?: string }) {
  const { org_slug } = await resolveOrg(config)
  const body: Record<string, string> = { name }
  if (opts.alias) body.alias = opts.alias
  if (opts.description) body.description = opts.description

  const { data: g } = await api<Group>(config, orgPath(org_slug, "groups"), { method: "POST", body })
  console.log(`Group created: ${g.alias} (${g.name}) [id=${g.id}]`)
}

async function cmdGroupsUpdate(config: Config, ref: string, opts: { name?: string; alias?: string; description?: string }) {
  const { org_slug } = await resolveOrg(config)
  const body: Record<string, string | null> = {}
  if (opts.name) body.name = opts.name
  if (opts.alias !== undefined) body.alias = opts.alias
  if (opts.description !== undefined) body.description = opts.description
  if (Object.keys(body).length === 0) {
    console.error("Nothing to update. Use --name, --alias, or --description.")
    process.exit(1)
  }

  const existing = await resolveGroup(config, org_slug, ref)
  const { data: g } = await api<Group>(
    config,
    orgPath(org_slug, "groups", String(existing.id)),
    { method: "PUT", body }
  )
  console.log(`Group updated: ${g.alias} (${g.name}) [id=${g.id}]`)
}

async function cmdGroupsDelete(config: Config, ref: string) {
  const { org_slug } = await resolveOrg(config)
  const existing = await resolveGroup(config, org_slug, ref)
  await api(config, orgPath(org_slug, "groups", String(existing.id)), { method: "DELETE" })
  console.log(`Deleted group ${existing.alias} [id=${existing.id}]`)
}

async function cmdGroupsMembersList(config: Config, ref: string) {
  const { org_slug } = await resolveOrg(config)
  const existing = await resolveGroup(config, org_slug, ref)
  const { data: members } = await api<GroupMember[]>(
    config,
    orgPath(org_slug, "groups", String(existing.id), "members")
  )

  if (members.length === 0) {
    console.log("No members found.")
    return
  }

  console.log(`${"ID".padEnd(8)} ${"Email".padEnd(30)} ${"Name".padEnd(20)} Role`)
  console.log("─".repeat(72))
  for (const m of members) {
    console.log(`${String(m.user_id).padEnd(8)} ${(m.email || "-").padEnd(30)} ${(m.name || "-").padEnd(20)} ${m.role}`)
  }
}

async function cmdGroupsMembersAdd(config: Config, ref: string, userRef: string, role: string) {
  const { org_slug } = await resolveOrg(config)
  const existing = await resolveGroup(config, org_slug, ref)
  const u = await resolveUserRef(config, org_slug, userRef)

  const { data: member } = await api<GroupMember>(
    config,
    orgPath(org_slug, "groups", String(existing.id), "members"),
    { method: "POST", body: { user_id: u.user_id, role } }
  )
  console.log(`Added ${member.email || member.user_id} to ${existing.alias} as ${member.role}.`)
}

async function cmdGroupsMembersRemove(config: Config, ref: string, userRef: string) {
  const { org_slug } = await resolveOrg(config)
  const existing = await resolveGroup(config, org_slug, ref)
  const u = await resolveUserRef(config, org_slug, userRef)

  await api(
    config,
    orgPath(org_slug, "groups", String(existing.id), "members", String(u.user_id)),
    { method: "DELETE" }
  )
  console.log(`Removed ${u.email || u.user_id} from ${existing.alias}.`)
}

// ── Auth Token ─────────────────────────────────────────────────────────────

async function cmdAuthToken(config: Config) {
  requireAuth(config)
  process.stdout.write(config.access_token)
}

type AuthStatusRow = {
  profile: string
  current: string
  status: string
  email: string
  authUrl: string
}

function sharedProfileNames(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => /^\[([^\]]+)]$/.exec(line.trim())?.[1])
    .filter((profile): profile is string => Boolean(profile) && profile !== "__circles__")
}

function failedCredentialStatus(error: unknown): string {
  if (!isCredentialError(error)) return "error"
  switch (error.code) {
    case CredentialErrorCode.NotFound: return "missing"
    case CredentialErrorCode.Invalid: return "invalid"
    case CredentialErrorCode.Ambiguous: return "ambiguous"
    case CredentialErrorCode.RefreshFailed: return "refresh-failed"
    case CredentialErrorCode.ProfileConflict: return "conflict"
    case CredentialErrorCode.StorageFailed: return "storage-failed"
  }
}

async function inspectAuthProfile(profile: string, selectedProfile: string): Promise<AuthStatusRow> {
  const credentialProvider = createCredentialProvider({ profile })
  const storedProfile = await credentialProvider.getProfile()
  const apiUrl = normalizeBaseURL(storedProfile?.config.apiUrl || DEFAULT_API_URL)
  const authUrl = normalizeBaseURL(storedProfile?.config.authUrl || DEFAULT_AUTH_URL)
  const base = { profile, current: profile === selectedProfile ? "*" : "", email: "-", authUrl }

  try {
    const credential = await credentialProvider.resolve()
    const { data: me, status } = await api<UserMe>({
      profile,
      api_url: apiUrl,
      auth_url: authUrl,
      access_token: credential.value,
      credential_kind: credential.kind,
      credential_source: credential.source,
      credential_provider: credentialProvider,
      org: storedProfile?.config.org || null,
      email: null,
    }, "/users/me", { noExit: true })
    if (status === 200) return { ...base, status: "ok", email: me.email }
    return { ...base, status: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : `http-${status}` }
  } catch (error) {
    return { ...base, status: failedCredentialStatus(error) }
  }
}

async function cmdAuthStatus() {
  const credentialProvider = createCredentialProvider()
  try {
    await credentialProvider.getCurrentProfile()
    const selectedProfile = await credentialProvider.getSelectedProfileName()
    const profiles = [...new Set([
      ...sharedProfileNames(credentialProvider.paths.configFile),
      ...sharedProfileNames(credentialProvider.paths.credentialsFile),
      selectedProfile,
    ])]
      .sort((left, right) => left === selectedProfile ? -1 : right === selectedProfile ? 1 : left.localeCompare(right))
    const rows = await Promise.all(profiles.map((profile) => inspectAuthProfile(profile, selectedProfile)))
    const headers = ["PROFILE", "CURRENT", "STATUS", "EMAIL", "AUTH URL"]
    const values = rows.map((row) => [row.profile, row.current, row.status, row.email, row.authUrl])
    const widths = headers.map((header, index) => Math.max(header.length, ...values.map((row) => row[index]!.length)))
    const format = (row: string[]) => row.map((value, index) => index === row.length - 1 ? value : value.padEnd(widths[index]!)).join("  ")
    console.log(format(headers))
    console.log(format(widths.map((width) => "─".repeat(width))))
    for (const row of values) console.log(format(row))
  } catch (error) {
    if (isCredentialError(error)) {
      console.error(`Authentication status failed (${error.code}): ${error.message}`)
      process.exit(1)
    }
    throw error
  }
}

// ── Whoami ──────────────────────────────────────────────────────────────────

async function cmdWhoami(config: Config) {
  requireAuth(config)

  const { data: me } = await api<UserMe>(config, "/users/me")

  console.log(`User:    ${me.name || me.email}`)
  console.log(`Email:   ${me.email}`)
  console.log(`Profile: ${config.profile}`)
  console.log(`API:     ${config.api_url}`)
  console.log(`Auth:    ${config.auth_url}`)
  if (config.org) console.log(`Org:     ${config.org}`)
  if (me.orgs.length > 0) {
    console.log(`Orgs:    ${me.orgs.map((o) => o.slug).join(", ")}`)
  }
}

// ── Logout ──────────────────────────────────────────────────────────────────

async function cmdLogout(config: Config, opts: { all?: boolean }) {
  if (opts.all) {
    await config.credential_provider.clearProfiles()
    console.log("Logged out of all profiles.")
    return
  }

  await config.credential_provider.deleteProfile()
  console.log(`Logged out of profile '${config.profile}'.`)
}

// ── Commands ─────────────────────────────────────────────────────────────────

const loginArgs = {
  org: { type: "string" as const, description: "Override current org" },
  "api-url": { type: "string" as const, description: "API URL (e.g. https://api.example.com)" },
  "auth-url": { type: "string" as const, description: "Auth URL (e.g. https://auth.example.com)" },
}

const globalArgs = {
  org: { type: "string" as const, description: "Override current org" },
  profile: { type: "string" as const, description: "Use a specific profile (number or name)" },
}

const orgsCommand = defineCommand({
  meta: { name: "orgs", description: "Manage organizations" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List your organizations" },
      args: { ...globalArgs },
      async run({ args }) { await cmdOrgsList(await loadConfig({ org: args.org, profile: args.profile })) },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a new organization" },
      args: {
        ...globalArgs,
        slug: { type: "positional" as const, description: "Organization slug", required: true },
        name: { type: "positional" as const, description: "Organization name", required: false },
      },
      async run({ args }) {
        await cmdOrgsCreate(await loadConfig({ org: args.org, profile: args.profile }), [args.slug, args.name].filter(Boolean) as string[])
      },
    }),
    switch: defineCommand({
      meta: { name: "switch", description: "Switch current organization" },
      args: {
        ...globalArgs,
        slug: { type: "positional" as const, description: "Organization slug", required: true },
      },
      async run({ args }) { await cmdOrgsSwitch(await loadConfig({ org: args.org, profile: args.profile }), [args.slug]) },
    }),
    update: defineCommand({
      meta: { name: "update", description: "Update organization name or slug" },
      args: {
        ...globalArgs,
        name: { type: "string" as const, description: "New organization name" },
        slug: { type: "string" as const, description: "New organization slug" },
      },
      async run({ args }) { await cmdOrgsUpdate(await loadConfig({ org: args.org, profile: args.profile }), { name: args.name, slug: args.slug }) },
    }),
  },
})

const scopeArgs = {
  ...globalArgs,
  user: { type: "boolean" as const, description: "User-level API key" },
}

const membersCommand = defineCommand({
  meta: { name: "members", description: "Manage organization members" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List organization members" },
      args: { ...globalArgs },
      async run({ args }) { await cmdMembersList(await loadConfig({ org: args.org, profile: args.profile })) },
    }),
    add: defineCommand({
      meta: { name: "add", description: "Add a member to the organization" },
      args: {
        ...globalArgs,
        email: { type: "positional" as const, description: "User email", required: true },
        role: { type: "string" as const, description: "Role: owner or member (default: member)" },
      },
      async run({ args }) {
        await cmdMembersAdd(await loadConfig({ org: args.org, profile: args.profile }), args.email, args.role || "member")
      },
    }),
    role: defineCommand({
      meta: { name: "role", description: "Change a member's role" },
      args: {
        ...globalArgs,
        email: { type: "positional" as const, description: "Member email", required: true },
        role: { type: "string" as const, description: "New role: owner or member", required: true },
      },
      async run({ args }) {
        if (!args.role) {
          console.error("Usage: crcl members role <email> --role <owner|member>")
          process.exit(1)
        }
        await cmdMembersRole(await loadConfig({ org: args.org, profile: args.profile }), args.email, args.role)
      },
    }),
    remove: defineCommand({
      meta: { name: "remove", description: "Remove a member from the organization" },
      args: {
        ...globalArgs,
        email: { type: "positional" as const, description: "Member email", required: true },
      },
      async run({ args }) {
        await cmdMembersRemove(await loadConfig({ org: args.org, profile: args.profile }), args.email)
      },
    }),
  },
})

const groupsCommand = defineCommand({
  meta: { name: "groups", description: "Manage groups" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List groups in current org" },
      args: { ...globalArgs },
      async run({ args }) { await cmdGroupsList(await loadConfig({ org: args.org, profile: args.profile })) },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a new group" },
      args: {
        ...globalArgs,
        name: { type: "positional" as const, description: "Group name", required: true },
        alias: { type: "string" as const, description: "Group alias (defaults to slugified name)" },
        description: { type: "string" as const, description: "Group description" },
      },
      async run({ args }) {
        await cmdGroupsCreate(await loadConfig({ org: args.org, profile: args.profile }), args.name, {
          alias: args.alias,
          description: args.description,
        })
      },
    }),
    update: defineCommand({
      meta: { name: "update", description: "Update group name, alias, or description" },
      args: {
        ...globalArgs,
        group: { type: "positional" as const, description: "Group ID or alias", required: true },
        name: { type: "string" as const, description: "New group name" },
        alias: { type: "string" as const, description: "New group alias" },
        description: { type: "string" as const, description: "New description" },
      },
      async run({ args }) {
        await cmdGroupsUpdate(await loadConfig({ org: args.org, profile: args.profile }), args.group, {
          name: args.name,
          alias: args.alias,
          description: args.description,
        })
      },
    }),
    delete: defineCommand({
      meta: { name: "delete", description: "Delete a group" },
      args: {
        ...globalArgs,
        group: { type: "positional" as const, description: "Group ID or alias", required: true },
      },
      async run({ args }) {
        await cmdGroupsDelete(await loadConfig({ org: args.org, profile: args.profile }), args.group)
      },
    }),
    members: defineCommand({
      meta: { name: "members", description: "Manage group members" },
      subCommands: {
        list: defineCommand({
          meta: { name: "list", description: "List members of a group" },
          args: {
            ...globalArgs,
            group: { type: "positional" as const, description: "Group ID or alias", required: true },
          },
          async run({ args }) {
            await cmdGroupsMembersList(await loadConfig({ org: args.org, profile: args.profile }), args.group)
          },
        }),
        add: defineCommand({
          meta: { name: "add", description: "Add a member to a group" },
          args: {
            ...globalArgs,
            group: { type: "positional" as const, description: "Group ID or alias", required: true },
            user: { type: "positional" as const, description: "User ID or email", required: true },
            role: { type: "string" as const, description: "Role: admin or member (default: member)" },
          },
          async run({ args }) {
            await cmdGroupsMembersAdd(
              await loadConfig({ org: args.org, profile: args.profile }),
              args.group,
              args.user,
              args.role || "member"
            )
          },
        }),
        remove: defineCommand({
          meta: { name: "remove", description: "Remove a member from a group" },
          args: {
            ...globalArgs,
            group: { type: "positional" as const, description: "Group ID or alias", required: true },
            user: { type: "positional" as const, description: "User ID or email", required: true },
          },
          async run({ args }) {
            await cmdGroupsMembersRemove(
              await loadConfig({ org: args.org, profile: args.profile }),
              args.group,
              args.user
            )
          },
        }),
      },
    }),
  },
})

const apikeysCommand = defineCommand({
  meta: { name: "apikeys", description: "Manage API keys (use --user or --org <slug>)" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List API keys" },
      args: { ...scopeArgs },
      async run({ args }) {
        const scope = requireScope({ user: args.user, org: args.org })
        await cmdApikeysList(await loadConfig({ org: args.org, profile: args.profile }), { user: scope === "user" })
      },
    }),
    create: defineCommand({
      meta: { name: "create", description: "Create a new API key" },
      args: {
        ...scopeArgs,
        name: { type: "positional" as const, description: "Key name", required: false },
        force: { type: "boolean" as const, alias: "y", description: "Delete existing keys and create new" },
      },
      async run({ args }) {
        const scope = requireScope({ user: args.user, org: args.org })
        const cmdArgs = [args.name, args.force ? "--force" : ""].filter(Boolean) as string[]
        await cmdApikeysCreate(await loadConfig({ org: args.org, profile: args.profile }), cmdArgs, { user: scope === "user" })
      },
    }),
    delete: defineCommand({
      meta: { name: "delete", description: "Delete an API key" },
      args: {
        ...scopeArgs,
        key_id: { type: "positional" as const, description: "API key ID", required: true },
      },
      async run({ args }) {
        const scope = requireScope({ user: args.user, org: args.org })
        await cmdApikeysDelete(await loadConfig({ org: args.org, profile: args.profile }), [args.key_id], { user: scope === "user" })
      },
    }),
  },
})

export const main = defineCommand({
  meta: {
    name: "crcl",
    version: VERSION,
    description: "Circles CLI — manage orgs, API keys, and authenticate with circles.ac",
  },
  subCommands: {
    login: defineCommand({
      meta: { name: "login", description: "Authenticate via circles.ac" },
      args: {
        ...loginArgs,
        profile: { type: "string" as const, description: "Profile name (required with custom or mixed endpoints)" },
      },
      async run({ args }) {
        const { config, profile } = await loadLoginConfig({
          org: args.org,
          profile: args.profile,
          apiUrl: args["api-url"],
          authUrl: args["auth-url"],
        })
        await cmdLogin(config, profile)
      },
    }),
    logout: defineCommand({
      meta: { name: "logout", description: "Clear stored credentials" },
      args: {
        profile: { type: "string" as const, description: "Profile to logout (default: current)" },
        all: { type: "boolean" as const, description: "Logout of all profiles" },
      },
      async run({ args }) { await cmdLogout(await loadConfig({ profile: args.profile }), { all: args.all }) },
    }),
    whoami: defineCommand({
      meta: { name: "whoami", description: "Show current user and org" },
      args: { ...globalArgs },
      async run({ args }) { await cmdWhoami(await loadConfig({ org: args.org, profile: args.profile })) },
    }),
    auth: defineCommand({
      meta: { name: "auth", description: "Authentication utilities" },
      subCommands: {
        status: defineCommand({
          meta: { name: "status", description: "Check all stored credential profiles" },
          async run() { await cmdAuthStatus() },
        }),
        token: defineCommand({
          meta: { name: "token", description: "Print a valid access token (refreshes if expired)" },
          args: { ...globalArgs },
          async run({ args }) { await cmdAuthToken(await loadConfig({ org: args.org, profile: args.profile })) },
        }),
      },
    }),
    orgs: orgsCommand,
    members: membersCommand,
    groups: groupsCommand,
    apikeys: apikeysCommand,
  },
})

// Only run when executed directly (not imported for testing)
if (import.meta.main) {
  await checkForUpdate()
  runMain(main)
}
