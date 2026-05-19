import { Type } from "@sinclair/typebox";
// @ts-ignore — openclaw is a peer dep; types may not be available at typecheck if not installed
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { startSidecar, type SidecarHandle } from "./sidecar/index.js";

export default defineToolPlugin({
  id: "ogamex",
  name: "OgameX",
  description: "Ogame automation: goal tasks, daily ambient, emergency response.",
  configSchema: Type.Object({
    discordChannelId: Type.Optional(Type.String()),
    wsPort: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
    bridgeToken: Type.Optional(Type.String()),
  }),
  tools: (tool: any) => [
    tool({
      name: "ogame_ping",
      description: "Health check.",
      parameters: Type.Object({}),
      execute: () => ({ ok: true, ts: Date.now() }),
    }),
  ],
});

// --- Sidecar bootstrap (module side-effect) ---
// OpenClaw activates this plugin with onStartup=true + sidecar=true per
// openclaw.plugin.json — when the module is imported by the gateway, we
// kick off the WS/HTTP servers via a fire-and-forget Promise. Failures
// are logged but do not break plugin registration.
let _sidecarHandle: SidecarHandle | null = null;

async function bootSidecar(): Promise<void> {
  const wsPort = Number(process.env.OGAMEX_WS_PORT ?? 18790);
  const httpPort = Number(process.env.OGAMEX_HTTP_PORT ?? 18791);
  const bridgeToken = process.env.OGAMEX_BRIDGE_TOKEN ?? "";
  const discordChannelId = process.env.OGAMEX_DISCORD_CHANNEL_ID;
  if (!bridgeToken) {
    console.warn("[ogamex/sidecar] OGAMEX_BRIDGE_TOKEN unset — sidecar disabled");
    return;
  }
  try {
    _sidecarHandle = await startSidecar({
      wsPort,
      httpPort,
      bridgeToken,
      ...(discordChannelId !== undefined && discordChannelId !== ""
        ? { discordChannelId }
        : {}),
    });
    console.info("[ogamex/sidecar] started", {
      wsPort,
      httpPort,
      discord: discordChannelId !== undefined && discordChannelId !== "",
    });
  } catch (e) {
    console.error("[ogamex/sidecar] failed to start", e);
  }
}

// Skip auto-boot when imported by tests (vitest sets VITEST=1) or when the
// operator explicitly disables it (e.g. for local dev with manual control).
if (!process.env.VITEST && !process.env.OGAMEX_SKIP_SIDECAR) {
  void bootSidecar();
}
