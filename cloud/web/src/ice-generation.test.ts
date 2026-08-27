import { describe, expect, it } from "vitest";
import { IceGenerationRouter } from "./ice-generation";

describe("ICE generation routing", () => {
  it("drops a delayed old candidate instead of relabeling it after restart", () => {
    const router = new IceGenerationRouter();
    router.activate("negotiation_old");
    router.bindLocalDescription("negotiation_old", "v=0\r\na=ice-ufrag:oldUfrag\r\n");
    expect(router.negotiationForCandidate({
      candidate: "candidate:1 1 udp 1 10.0.0.1 1234 typ host ufrag oldUfrag",
    })).toBe("negotiation_old");

    router.activate("negotiation_new");
    router.bindLocalDescription("negotiation_new", "v=0\r\na=ice-ufrag:newUfrag\r\n");

    expect(router.negotiationForCandidate({
      candidate: "candidate:1 1 udp 1 10.0.0.1 1234 typ host ufrag oldUfrag",
      usernameFragment: "oldUfrag",
    })).toBeUndefined();
    expect(router.negotiationForCandidate({
      candidate: "candidate:2 1 udp 1 10.0.0.2 5678 typ relay",
      usernameFragment: "newUfrag",
    })).toBe("negotiation_new");
  });
});
