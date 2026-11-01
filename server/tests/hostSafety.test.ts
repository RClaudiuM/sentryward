import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "../src/lib/hostSafety.ts";

describe("isPrivateAddress", () => {
  it("refuses IETF-assigned, benchmarking, multicast and reserved IPv4 ranges", () => {
    // 192.0.0.0/24 (IETF protocol assignments).
    expect(isPrivateAddress("192.0.0.1")).toBe(true);
    expect(isPrivateAddress("192.0.0.254")).toBe(true);
    // 198.18.0.0/15 (benchmarking).
    expect(isPrivateAddress("198.18.0.1")).toBe(true);
    expect(isPrivateAddress("198.19.255.255")).toBe(true);
    // 224.0.0.0/4 (multicast).
    expect(isPrivateAddress("224.0.0.1")).toBe(true);
    expect(isPrivateAddress("239.255.255.255")).toBe(true);
    // 240.0.0.0/4 (reserved, including the limited broadcast).
    expect(isPrivateAddress("240.0.0.1")).toBe(true);
    expect(isPrivateAddress("255.255.255.255")).toBe(true);
  });

  it("refuses NAT64 and 6to4 ranges", () => {
    // 64:ff9b::/96 (NAT64), hex and dotted-quad forms.
    expect(isPrivateAddress("64:ff9b::a9fe:a9fe")).toBe(true);
    expect(isPrivateAddress("64:ff9b::169.254.169.254")).toBe(true);
    // 2002::/16 (6to4) wrapping 127.0.0.1.
    expect(isPrivateAddress("2002:7f00:0001::")).toBe(true);
    expect(isPrivateAddress("2002:7f00:1::")).toBe(true);
  });

  it("still accepts public addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("104.18.1.1")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    // A NAT64 or 6to4 address embedding a public IPv4 is refused by the range
    // itself, not because of the embedded address.
    expect(isPrivateAddress("64:ff9b::0808:0808")).toBe(true);
    expect(isPrivateAddress("2002:0808:0808::")).toBe(true);
  });
});
