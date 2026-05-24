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

  // 4. Operator 2026-05-24: emergency save on facilities page hit
  //    "TokenManager.refresh returned empty value" because facilities DOM
  //    has none of the above. ApiExec writes the freshest newAjaxToken to
  //    dataset on every successful POST (discover/expedition/etc), and the
  //    sniffer also persists it to localStorage. Either is fresher than
  //    what a non-fleet page DOM ever had.
  try {
    const dsTok = (doc.documentElement as HTMLElement | null)?.dataset?.["ogamexToken"];
    if (dsTok) return dsTok;
  } catch { /* */ }
  try {
    const lsTok = win.localStorage?.getItem?.("OGAMEX_TOKEN");
    if (lsTok) return lsTok;
  } catch { /* */ }

  return null;
}
