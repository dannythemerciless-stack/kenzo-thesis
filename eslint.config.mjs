import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // ---------------------------------------------------------------------
  // The blinding import wall.
  //
  // Layer 3 of 4 protecting the control group (the others: two separate
  // return types, two code-split chunks, and the CI grep in
  // scripts/check-blinding.sh).
  //
  // NOTE: `next build` no longer runs ESLint in Next 16, so this layer only
  // does anything if `pnpm lint` runs as its own CI step.
  // ---------------------------------------------------------------------
  {
    files: ["**/*.{ts,tsx}"],
    ignores: [
      "components/quiz/treatment/**",
      "app/quiz/page.tsx",
      "scripts/**",
      "lib/quiz/randomize.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/components/quiz/treatment/*", "@/components/quiz/treatment/*"],
              message:
                "Treatment-only UI. Importing this anywhere outside the treatment shell would leak the progress cue to the control group and invalidate the experiment.",
            },
            {
              group: ["**/lib/supabase/*", "**/lib/dal/*", "**/lib/env", "@/lib/env"],
              message:
                "Server-only module. Importing it from a Client Component would ship the service-role key to the browser.",
            },
          ],
        },
      ],
    },
  },

  // Server-side code legitimately imports the server-only modules.
  {
    files: [
      "app/**/page.tsx",
      "app/**/route.ts",
      "app/**/actions.ts",
      "app/actions/**",
      "lib/**",
      "proxy.ts",
    ],
    rules: { "no-restricted-imports": "off" },
  },
]);

export default eslintConfig;
