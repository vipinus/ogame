export interface OgameWindow extends Window {
  ogameMeta?: { token?: string };
  token?: string;
  csrfToken?: string;
}

export function extractToken(doc: Document, win: OgameWindow): string | null {
  // v0.0.464: dataset PROMOTED to priority 1 (operator 2026-05-29 root cause:
  // bot's background cp= fetches rotate ogame's token via newAjaxToken in
  // response, captured to dataset. But form input / win.token / meta are
  // PAGE-LOAD values that don't update without operator clicking through
  // ogame's own UI. Reading those first returned stale tokens for hundreds
  // of build POSTs → ogame 100001 every time. Bot-captured dataset value
  // is the freshest known source for background dispatch paths.
  try {
    const dsTok = (doc.documentElement as HTMLElement | null)?.dataset?.["ogamexToken"];
    if (dsTok) return dsTok;
  } catch { /* */ }

  // 2. Hidden form input (still fresh when operator was just on fleetdispatch
  //    or build pages — ogame's frontend writes newAjaxToken into the input
  //    on its own ajax responses).
  const input = doc.querySelector<HTMLInputElement>('input[name="token"]');
  if (input?.value) return input.value;

  // 3. Common JS globals (ogame exposes these on some pages).
  if (win.ogameMeta?.token) return win.ogameMeta.token;
  if (win.token) return win.token;
  if (win.csrfToken) return win.csrfToken;

  // 4. Meta tag fallback (page-load value, often stale for background dispatch).
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="ogame-token"]');
  if (meta?.content) return meta.content;

  // 5. localStorage last-resort.
  try {
    const lsTok = win.localStorage?.getItem?.("OGAMEX_TOKEN");
    if (lsTok) return lsTok;
  } catch { /* */ }

  return null;
}
