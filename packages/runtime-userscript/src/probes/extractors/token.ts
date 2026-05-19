export interface OgameWindow extends Window {
  ogameMeta?: { token?: string };
  token?: string;
  csrfToken?: string;
}

export function extractToken(doc: Document, win: OgameWindow): string | null {
  // 1. Hidden form input (most reliable on fleetdispatch/build pages)
  const input = doc.querySelector<HTMLInputElement>('input[name="token"]');
  if (input?.value) return input.value;

  // 2. Common JS globals (ogame exposes these)
  if (win.ogameMeta?.token) return win.ogameMeta.token;
  if (win.token) return win.token;
  if (win.csrfToken) return win.csrfToken;

  // 3. Meta tag fallback
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="ogame-token"]');
  if (meta?.content) return meta.content;

  return null;
}
