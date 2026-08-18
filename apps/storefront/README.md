# @clothing-line-project/storefront

Next.js (App Router, 16) storefront for the clothing-line headless e-commerce
monorepo. Tailwind CSS v4 (`@tailwindcss/postcss`). Build via `turbo run build`.

## Local development

From the repository root, `pnpm dev` starts the full stack — infra (Postgres +
Redis), the real Express API on `:5000`, the background worker, and this
storefront on `:3000`. See the root `AGENTS.md` for the complete command set.

The storefront talks to the API through `NEXT_PUBLIC_API_URL` (loaded from
`.env.local`, provisioned automatically by `scripts/prepare-env.mjs`; see
`.env.example`). In development it points at the real API on
`http://localhost:5000` — the Prism mock (port `4010`) is opt-in only.

## Status

The storefront is currently the stock `create-next-app` landing page; no global
state or API integration layers are implemented yet.
