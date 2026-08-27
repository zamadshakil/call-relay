import { describe, expect, it, vi } from "vitest";
import { isFirebaseAuthHelperPath, proxyFirebaseAuthHelper } from "./firebase-auth-proxy";

describe("Firebase auth helper proxy", () => {
  it("recognizes only Firebase helper routes", () => {
    expect(isFirebaseAuthHelperPath("/__/auth/handler")).toBe(true);
    expect(isFirebaseAuthHelperPath("/__/auth/iframe")).toBe(true);
    expect(isFirebaseAuthHelperPath("/__/firebase/init.json")).toBe(true);
    expect(isFirebaseAuthHelperPath("/v1/me")).toBe(false);
  });

  it("forwards the helper request without redirecting across origins", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://call-relay-3dec7.firebaseapp.com/__/auth/handler?eventId=test");
      expect(request.method).toBe("GET");
      return new Response(null, {
        status: 302,
        headers: { location: "https://call-relay-3dec7.firebaseapp.com/__/auth/iframe?eventId=test" },
      });
    });
    const response = await proxyFirebaseAuthHelper(
      new Request("https://call-relay-staging.zamadshakil.workers.dev/__/auth/handler?eventId=test"),
      "call-relay-3dec7",
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://call-relay-staging.zamadshakil.workers.dev/__/auth/iframe?eventId=test");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects methods that the Firebase helper does not use", async () => {
    const response = await proxyFirebaseAuthHelper(
      new Request("https://relay.test/__/auth/handler", { method: "DELETE" }),
      "call-relay-3dec7",
      vi.fn(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, POST");
  });
});
