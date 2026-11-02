import { describe, expect, it } from "vitest";
import { assertPublicHostname, isInternalHost, isNonPublicAddress, isPrivateAddress, type Resolve } from "../src/lib/hostSafety.ts";

const resolver =
  (table: Record<string, string[]>): Resolve =>
  async (hostname) => {
    const addresses = table[hostname];
    if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({ address }));
  };

describe("isNonPublicAddress (SSRF guard)", () => {
  it("refuses IETF-assigned, benchmarking, multicast and reserved IPv4 ranges", () => {
    for (const address of ["192.0.0.1", "198.18.0.1", "198.19.255.255", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255"]) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
  });

  it("still refuses the internal ranges", () => {
    for (const address of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1"]) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
  });

  it("refuses IPv4-compatible, Teredo, site-local and multicast IPv6", () => {
    for (const address of ["::7f00:1", "::127.0.0.1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "fec0::1", "ff02::1"]) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
  });

  it("refuses translation addresses that carry an internal IPv4, in any spelling", () => {
    for (const address of [
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::169.254.169.254",
      "64:ff9b:0:0:0:0:a9fe:a9fe",
      "0064:ff9b::7f00:1",
      "[64:ff9b::7f00:1]",
      "64:ff9b:1::a9fe:a9fe",
      "2002:7f00:0001::",
      "2002:7f00:1::",
      "2002:a00:1::1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
  });

  it("refuses local-use NAT64 in a layout it cannot decode", () => {
    expect(isNonPublicAddress("64:ff9b:1:808:8:800::")).toBe(true);
  });

  it("accepts public addresses, including translations of public IPv4", () => {
    for (const address of [
      "8.8.8.8",
      "104.18.1.1",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "64:ff9b::808:808",
      "64:ff9b::8.8.8.8",
      "2002:808:808::",
      "::ffff:8.8.8.8",
    ]) {
      expect(isNonPublicAddress(address), address).toBe(false);
    }
  });
});

describe("isPrivateAddress (local-only mode)", () => {
  it("does not trust reserved ranges as internal", () => {
    for (const address of ["198.18.0.42", "192.0.0.1", "224.0.0.1", "240.0.0.1", "ff02::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("classifies translation addresses by the IPv4 they carry", () => {
    expect(isPrivateAddress("64:ff9b::808:808")).toBe(false);
    expect(isPrivateAddress("2002:808:808::")).toBe(false);
    expect(isPrivateAddress("64:ff9b::a00:5")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
  });

  it("treats strings that are not addresses as external", () => {
    expect(isPrivateAddress("2002:7f00:1:zz")).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(false);
  });

  it("does not trust a name that resolves to a NAT64 address of a public host", async () => {
    const resolve = resolver({ "api.openai.com": ["64:ff9b::6812:101"], "fake-ip": ["198.18.0.42"] });
    expect(await isInternalHost("api.openai.com", resolve)).toBe(false);
    expect(await isInternalHost("fake-ip", resolve)).toBe(false);
  });
});

describe("assertPublicHostname", () => {
  const resolve = resolver({
    "bench.example": ["198.18.0.1"],
    "metadata.example": ["64:ff9b::a9fe:a9fe"],
    "dns64.example": ["140.82.112.3", "64:ff9b::8c52:7003"],
  });

  it("refuses names that resolve to non-public addresses", async () => {
    await expect(assertPublicHostname("bench.example", "URL", resolve)).rejects.toMatchObject({ status: 400 });
    await expect(assertPublicHostname("metadata.example", "URL", resolve)).rejects.toMatchObject({ status: 400 });
    await expect(assertPublicHostname("[64:ff9b::7f00:1]", "URL", resolve)).rejects.toMatchObject({ status: 400 });
  });

  it("accepts a public host whose DNS64 AAAA record is synthesized", async () => {
    await expect(assertPublicHostname("dns64.example", "URL", resolve)).resolves.toBeUndefined();
  });

  it("refuses a name that does not resolve", async () => {
    await expect(assertPublicHostname("missing.example", "URL", resolve)).rejects.toThrow("Could not resolve");
  });
});
