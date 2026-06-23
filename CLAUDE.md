# CLAUDE.md

## Repository Overview

This repository is a **GitHub Pages deployment repo** for a Korean-language web arcade (`오락실`) titled **Stickfighter**. It contains only the compiled, production-ready static build output — there is no source code, `package.json`, or `src/` directory here.

**Live site**: `https://ogelacinyc.github.io/test1/`

## Project Stack

- **Framework**: React 19.2.4 (bundled, no JSX source present)
- **Build tool**: Vite (inferred from hashed asset filenames: `index-[hash].js/css`)
- **Language**: Korean UI (`lang="ko"`, title "오락실" = Arcade)
- **Deployment**: GitHub Pages (serves `index.html` directly from `main` branch root)

## Repository Structure

```
/
├── index.html                    # App entry point; splash screen + React root mount
└── assets/
    ├── index-PqFhc1dp.js         # Minified React bundle (all game logic, routing, state)
    └── index-GPiiyy07.css        # Minified styles (themes, game backgrounds, layout)
```

Asset URLs in `index.html` are **absolute**, pointing to the GitHub Pages origin:
```html
src="https://ogelacinyc.github.io/test1/assets/index-PqFhc1dp.js"
href="https://ogelacinyc.github.io/test1/assets/index-GPiiyy07.css"
```

## Application Architecture (from bundle analysis)

The app is a single-page React application with the following screens:

| Screen | CSS class | Description |
|--------|-----------|-------------|
| Splash | `#splash` | Loading screen shown on first visit; fades out after assets load |
| Select | `.select-screen` | Game selection menu with cards; shows user profile/login |
| Game screen | `.game-screen` | Placeholder screen for games not yet implemented |
| Stickfighter | `.game1-container` | Fully implemented canvas-based fighting game |

### Stickfighter Game (Game 1)

The main game renders on a `<canvas>` element (`.game1-canvas`) inside a max-width 400px container. It supports:

- **6 levels** with distinct CSS-rendered backgrounds (no image assets):
  - Level 1: Daytime grassland
  - Level 2: Desert with cacti
  - Level 3: Coastal city at dusk
  - Level 4: Night city with lit windows
  - Level 5: Volcanic landscape
  - Level 6: Hell/deep fire
- Touch and click input (`touch-action: manipulation`)
- Back button navigation to game select

### UI Theming

- **Light mode**: White background, purple accent (`#aa3bff`)
- **Dark mode**: `#16171d` background, purple accent (`#c084fc`)
- Automatic via `@media (prefers-color-scheme: dark)`
- Font: `system-ui` / `"Segoe UI"` / Roboto

### Auth / Profile

The select screen has a login button (`.login-button`, blue `#3182f6`) and a profile area (`.profile-area`) with avatar and nickname — suggesting an auth flow exists in the bundle.

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Production — GitHub Pages serves from this branch |
| `claude/*` | AI-assisted changes (current: `claude/claude-md-docs-pe7mz2`) |

## Development Workflow

**This repo holds build artifacts only.** The source code lives elsewhere. To make changes:

1. **For HTML-only changes** (title, meta tags, splash text): edit `index.html` directly and push to `main`.
2. **For app logic/style changes**: the source project must be rebuilt with Vite and the new hashed asset files committed here alongside an updated `index.html`.
3. **Deployment**: pushing to `main` triggers GitHub Pages to serve the updated files automatically (no CI pipeline in this repo).

## Git Conventions

- Commit messages are short and imperative (e.g., `init`, `Update index.html`)
- Feature/fix branches follow `claude/<description>-<id>` for AI-assisted work
- Always push with `git push -u origin <branch>`

## Key Constraints for AI Assistants

- **Do not attempt to run `npm install` or `vite build`** — there is no `package.json` here.
- **Do not create source files** (`*.tsx`, `*.ts`, `*.jsx`) unless the user explicitly wants to restructure the repo.
- **Asset hashes are content-addressed**: updating `.js`/`.css` files requires updating the `src`/`href` in `index.html` to match the new filename.
- **Absolute asset URLs**: the `index.html` uses `https://ogelacinyc.github.io/test1/assets/...` paths — these will break if the repo is renamed or moved to a different GitHub Pages URL.
- The working branch for new changes is `claude/claude-md-docs-pe7mz2`; push there, not to `main`, unless explicitly deploying.
