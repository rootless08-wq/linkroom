import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";

const localDatabaseId =
  process.env.CLOUDFLARE_D1_DATABASE_ID ??
  "00000000-0000-4000-8000-000000000000";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      inspectorPort: false,
      config: {
        main: "worker.ts",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [
          {
            binding: "DB",
            database_name: "linkroom-db",
            database_id: localDatabaseId,
          },
        ],
      },
    }),
  ],
});

