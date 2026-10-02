import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";

/**
 * Long-lived vendor chunks for the browser bundle: they change far less often than
 * the app, so returning visitors keep them cached across deploys. The editor group
 * is only reached through the lazily loaded compose window and settings pages.
 */
const vendorGroups = [
  { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
  { name: "router", test: /node_modules[\\/](react-router|cookie|set-cookie-parser)[\\/]/, priority: 20 },
  { name: "query", test: /node_modules[\\/]@tanstack[\\/]/, priority: 20 },
  { name: "editor", test: /node_modules[\\/](@tiptap|prosemirror-[a-z-]+|orderedmap|rope-sequence|w3c-keyname|linkifyjs|markdown-it|mdurl|uc\.micro|punycode\.js|entities|linkify-it)[\\/]/, priority: 20 },
];

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  environments: {
    client: {
      build: {
        rolldownOptions: { output: { codeSplitting: { groups: vendorGroups } } },
      },
    },
  },
});
