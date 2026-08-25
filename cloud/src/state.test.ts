import { describe, expect, it } from "vitest";
import { canTransition, isE164 } from "./state";

describe("call state machine", () => {
  it("permits the normal incoming path", () => {
    expect(canTransition("ringing_peer", "accepted")).toBe(true);
    expect(canTransition("accepted", "active")).toBe(true);
    expect(canTransition("active", "ending")).toBe(true);
    expect(canTransition("ending", "ended")).toBe(true);
    expect(canTransition("active", "ended")).toBe(true);
  });

  it("does not reopen terminal calls", () => {
    expect(canTransition("ended", "active")).toBe(false);
    expect(canTransition("failed", "created")).toBe(false);
  });
});

describe("E.164 validation", () => {
  it("accepts international numbers and rejects short codes and MMI", () => {
    expect(isE164("+923001234567")).toBe(true);
    expect(isE164("911")).toBe(false);
    expect(isE164("*123#")).toBe(false);
  });
});
