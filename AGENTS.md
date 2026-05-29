# AGENTS.md

## Runtime & Tooling
- Use Node `>=22.12.0` (`package.json` engines); CI builds with Node 22.
- Use npm (lockfile is `package-lock.json`). Install with `npm ci` for CI parity.
- Primary commands: `npm run dev`, `npm run build`, `npm run preview`.
- No dedicated lint/test scripts are configured; use `npm run astro -- check` for Astro/type checks when validating changes.

## Deploy & Build Constraints
- GitHub Pages deploy runs only on pushes to `main` via `.github/workflows/deploy.yml`.
- CI build flow is: `npm ci` -> `npm run build` -> upload `dist/` artifact.
- `dist/` and `.astro/` are generated outputs; do not commit them.

## Content Model (source of truth)
- Blog content is loaded from `src/content/blog/**/*.{md,mdx}` via `src/content.config.ts`.
- Required frontmatter: `title`, `description`, `pubDate`; optional: `updatedDate`, `heroImage`; `tags` defaults to `[]`.
- `pubDate`/`updatedDate` are coerced to `Date` by schema; keep date values parseable.

## Routing & URL Conventions
- Post pages are statically generated from collection entry IDs in `src/pages/[...slug].astro`; entry path controls URL slug.
- Tag pages are generated in `src/pages/tags/[tag].astro` using normalized slugs from `src/utils/tags.ts`.
- Tag normalization is opinionated: lowercase, `&` -> `and`, non-alphanumerics -> `-`, trim edge dashes. Reuse `getTagSlug`/`getTagHref` instead of duplicating logic.
- Link building intentionally normalizes `import.meta.env.BASE_URL` with trailing `/`; preserve this pattern when adding internal links, RSS links, or navigation paths.

## Astro-Specific Quirks
- Markdown uses a custom processor (`unified`) with `remark-svgbob` in `astro.config.mjs`; keep this if editing markdown pipeline.
- Local font setup is configured in `astro.config.mjs` (Atkinson woff files under `src/assets/fonts/`); avoid breaking font asset paths.
