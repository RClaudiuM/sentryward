import { describe, expect, it } from "vitest"

import { timeAgo } from "./time"

describe("timeAgo", () => {
  const now = Date.parse("2026-11-01T12:00:00Z")

  it("returns 'just now' for durations under one minute", () => {
    expect(timeAgo(new Date(now).toISOString(), now)).toBe("just now")
    expect(timeAgo(new Date(now - 30 * 1000).toISOString(), now)).toBe("just now")
    expect(timeAgo(new Date(now - 59.9 * 1000).toISOString(), now)).toBe("just now")
  })

  it("formats normal past minutes and hours", () => {
    expect(timeAgo(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 minutes ago")
    expect(timeAgo(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3 hours ago")
  })

  it("rounds values reaching the next unit up to hours instead of '60 minutes'", () => {
    expect(timeAgo(new Date(now - 59.5 * 60_000).toISOString(), now)).toBe("1 hour ago")
    expect(timeAgo(new Date(now - 59.9 * 60_000).toISOString(), now)).toBe("1 hour ago")
    expect(timeAgo(new Date(now - 60 * 60_000).toISOString(), now)).toBe("1 hour ago")
  })

  it("rounds values reaching the next unit up to days instead of '24 hours'", () => {
    expect(timeAgo(new Date(now - 23.5 * 3_600_000).toISOString(), now)).toBe("yesterday")
    expect(timeAgo(new Date(now - 23.9 * 3_600_000).toISOString(), now)).toBe("yesterday")
    expect(timeAgo(new Date(now - 24 * 3_600_000).toISOString(), now)).toBe("yesterday")
  })

  it("formats future timestamps with correct units and signs", () => {
    expect(timeAgo(new Date(now + 2 * 3_600_000).toISOString(), now)).toBe("in 2 hours")
    expect(timeAgo(new Date(now + 59.9 * 60_000).toISOString(), now)).toBe("in 1 hour")
    expect(timeAgo(new Date(now + 23.9 * 3_600_000).toISOString(), now)).toBe("tomorrow")
  })

  it("rounds halfway values the same way in the past and the future", () => {
    expect(timeAgo(new Date(now - 90_000).toISOString(), now)).toBe("2 minutes ago")
    expect(timeAgo(new Date(now + 90_000).toISOString(), now)).toBe("in 2 minutes")
    expect(timeAgo(new Date(now - 36 * 3_600_000).toISOString(), now)).toBe("2 days ago")
    expect(timeAgo(new Date(now + 36 * 3_600_000).toISOString(), now)).toBe("in 2 days")
  })

  it("returns 'just now' for an invalid timestamp", () => {
    expect(timeAgo("not a date", now)).toBe("just now")
  })
})
