import { Type } from "@sinclair/typebox";
// @ts-ignore — openclaw is a peer dep; types may not be available at typecheck if not installed
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

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
