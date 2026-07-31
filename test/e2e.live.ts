import { afterAll, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const testHome = mkdtempSync(join(tmpdir(), "crcl-e2e-"))

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true })
})

function crcl(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("bun", ["run", "src/index.ts", ...args], {
      timeout: 60_000,
      env: {
        ...process.env,
        CRCL_NO_UPDATE_CHECK: "1",
        XDG_CONFIG_HOME: join(testHome, ".config"),
        CIRCLES_CONFIG_FILE: join(testHome, ".crcl", "config"),
        CIRCLES_SHARED_CREDENTIALS_FILE: join(testHome, ".crcl", "credentials"),
      },
    }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: err?.code === undefined ? 0 : (typeof err.code === "number" ? err.code : 1) })
    })
  })
}

describe("live e2e", () => {
  it("login (opens browser)", async () => {
    const { stdout, exitCode } = await crcl(["login"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Authenticated as")
  }, 120_000)

  it("whoami", async () => {
    const { stdout, exitCode } = await crcl(["whoami"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("User:")
    expect(stdout).toContain("Email:")
  })

  it("orgs list", async () => {
    const { stdout, exitCode } = await crcl(["orgs", "list"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Slug")
    expect(stdout).toContain("Role")
  })

  it("members list", async () => {
    const { stdout, exitCode } = await crcl(["members", "list"])
    expect(exitCode).toBe(0)
    expect(stdout.includes("Email") || stdout.includes("No members found")).toBe(true)
  })

  it("--help", async () => {
    const { exitCode } = await crcl(["--help"])
    expect(exitCode).toBe(0)
  })

  it("--version", async () => {
    const { exitCode } = await crcl(["--version"])
    expect(exitCode).toBe(0)
  })

  it("logout", async () => {
    const { stdout, exitCode } = await crcl(["logout"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Logged out")
  })

  it("whoami after logout fails", async () => {
    const { exitCode } = await crcl(["whoami"])
    expect(exitCode).not.toBe(0)
  })
})
