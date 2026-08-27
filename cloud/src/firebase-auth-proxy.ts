import { HttpError } from "./http";

type Fetcher = (request: Request) => Promise<Response>;

export function isFirebaseAuthHelperPath(pathname: string): boolean {
  return pathname.startsWith("/__/auth/") || pathname === "/__/firebase/init.json";
}

export async function proxyFirebaseAuthHelper(
  request: Request,
  firebaseProjectId: string,
  fetcher: Fetcher = fetch,
): Promise<Response> {
  if (!isFirebaseAuthHelperPath(new URL(request.url).pathname)) throw new HttpError(404, "Firebase auth helper not found");
  if (!/^(GET|HEAD|POST)$/u.test(request.method)) {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD, POST" } });
  }
  if (!/^[a-z][a-z0-9-]{4,62}$/u.test(firebaseProjectId)) throw new Error("FIREBASE_PROJECT_ID is invalid");

  const incomingUrl = new URL(request.url);
  const firebaseOrigin = `https://${firebaseProjectId}.firebaseapp.com`;
  const upstreamUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, firebaseOrigin);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");

  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  const upstreamResponse = await fetcher(upstreamRequest);
  const responseHeaders = new Headers(upstreamResponse.headers);
  const location = responseHeaders.get("location");
  if (location) {
    const redirect = new URL(location, upstreamUrl);
    if (redirect.origin === firebaseOrigin && isFirebaseAuthHelperPath(redirect.pathname)) {
      redirect.protocol = incomingUrl.protocol;
      redirect.host = incomingUrl.host;
      responseHeaders.set("location", redirect.toString());
    }
  }
  responseHeaders.set("cache-control", "no-store");
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
