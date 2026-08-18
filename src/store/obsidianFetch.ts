/**
 * Signatur von Obsidians `requestUrl`, auf das reduziert, was hier gebraucht
 * wird. Bewusst als Typ statt Import: so bleibt dieses Modul frei von
 * "obsidian" und damit unter vitest testbar. Die echte Funktion wird in
 * main.ts hereingereicht.
 */
export type RequestUrlLike = (opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ArrayBuffer | string;
  throw: boolean;
  contentType?: string;
}) => Promise<{
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
}>;

// Statuscodes, bei denen der Response-Konstruktor keinen Rumpf akzeptiert.
const NO_BODY = new Set([101, 103, 204, 205, 304]);

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as { url: string }).url;
}

async function bodyOf(body: BodyInit | null | undefined): Promise<ArrayBuffer | string | undefined> {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return await body.arrayBuffer();
  if (body instanceof URLSearchParams) return body.toString();
  // FormData/ReadableStream nutzt PouchDBs HTTP-Adapter nie als Rumpf — hier
  // laut scheitern statt still "[object FormData]" zu senden (String(body)
  // wäre für diese Typen ohne aussagekräftiges toString(), siehe
  // @typescript-eslint/no-base-to-string).
  throw new Error(`obsidianFetch: nicht unterstützter body-Typ (${Object.prototype.toString.call(body)})`);
}

/**
 * Baut aus Obsidians `requestUrl` eine `fetch`-kompatible Funktion, die als
 * `{ fetch }`-Option an die Remote-PouchDB übergeben werden kann.
 *
 * Sinn: `requestUrl` läuft auf dem Desktop im Electron-Main-Prozess und auf
 * Mobil über die native Bridge — also außerhalb des Renderers. Damit greifen
 * weder CORS noch Chromiums Local Network Access, das seit Chrome 142
 * Zugriffe auf lokale Adressen sperrt und dafür keine Serverkonfiguration mehr
 * kennt.
 *
 * Grenzen, die den Einsatz als NICHT-Standard begründen: `requestUrl` puffert
 * die Antwort vollständig (kein Streaming) und kennt kein AbortSignal, ein
 * abgebrochener Live-Sync kann also noch bis zum Timeout offen bleiben. Für
 * PouchDB reicht es, weil dessen Live-Replikation `_changes?feed=longpoll`
 * benutzt und damit vollständige Antwortkörper erhält.
 */
export function makeRequestUrlFetch(request: RequestUrlLike): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = await bodyOf(init?.body);
    const res = await request({
      url: urlOf(input),
      method: init?.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
      // Fehlerstatus als Antwort, nicht als Ausnahme — PouchDB wertet
      // Statuscodes selbst aus (404 bedeutet dort z. B. "Dokument neu").
      throw: false,
    });
    return new Response(NO_BODY.has(res.status) ? null : res.arrayBuffer, {
      status: res.status,
      headers: res.headers,
    });
  };
  return impl;
}
