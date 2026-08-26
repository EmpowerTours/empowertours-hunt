// Flat config. `npm run lint` runs bare `eslint`, which since v9 looks for this
// file and nothing else — without it lint does not report zero problems, it
// fails to start, which is how it stayed red without saying anything useful.
//
// eslint-config-next@16 exports flat-config arrays directly (`Linter.Config[]`),
// so there is no FlatCompat / .eslintrc bridge here. `core-web-vitals` already
// includes the base Next config; `typescript` already includes
// typescript-eslint's recommended set plus the standard Next ignores.

import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const config = [
  ...nextCoreWebVitals,
  ...nextTypeScript,

  {
    // Generated or vendored — never our code to fix.
    ignores: [
      "node_modules/**",
      ".next/**",
      "lib/generated/**",
      "prisma/migrations/**",
    ],
  },

  {
    // THESE ARE MONEY RULES, NOT STYLE RULES.
    //
    // Wei is `Decimal(78,0)` in Postgres and `bigint` in code. A float that
    // reaches a payout is a silently wrong amount, not a crash, so anything
    // that lets a `bigint` decay into a `number` is an error here and not a
    // warning. See AGENTS.md.
    rules: {
      // A float literal that cannot be represented exactly is a wrong amount,
      // not a crash. Most wei mistakes need type information to see and are
      // caught by `tsc --noEmit` in the verifier; this catches the literal ones.
      "no-loss-of-precision": "error",

      // An ignored promise in a payout path is a send that nobody awaited.
      // Without type information ESLint cannot see most of these; the real
      // guard is `tsc --noEmit` in the verifier. This catches the obvious ones.
      "no-async-promise-executor": "error",
      "require-atomic-updates": "error",

      // Reject-by-default depends on comparisons behaving as written.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-fallthrough": "error",
    },
  },

  {
    // Tests assert on shapes the production types deliberately forbid — a
    // malformed ring, a `"1e18"` string reaching a wei parser. That is the
    // point of the test, so `any` is allowed to express it.
    files: ["**/*.test.ts", "**/*.itest.ts", "tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
];

export default config;
