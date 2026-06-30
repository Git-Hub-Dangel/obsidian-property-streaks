# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project structure

This is a vanilla Obsidian plugin — no build step, no bundler, no package.json. `main.js` is the final artifact shipped directly. Edit it in place. To test, copy or symlink the folder into an Obsidian vault's `.obsidian/plugins/property-streak/` and reload the plugin from Settings → Community Plugins.

All logic lives in three files:
- `main.js` — entire plugin (~1150 lines), loaded as CommonJS by Obsidian
- `styles.css` — all visual styles; Obsidian injects this automatically
- `manifest.json` — plugin metadata; bump `version` here when shipping changes

## Architecture

The plugin has two rendering surfaces and one shared engine.

### Streak engine (top of `main.js`, pure functions)
`buildDailyNoteMap` → `simulateStreak` → `getStreakStateForDate` is the core pipeline. It reads all daily notes via `metadataCache`, forward-simulates streak state day by day (handling freeze logic), and returns an array of day-state objects. Everything downstream is read-only against this data — nothing writes to notes.

`evaluateProperty` / `evaluateStreakDay` determine per-day completion. `getFlameState` maps a day-state pair to one of four visual states: `lit`, `grey`, `frozen`, `abandoned`. `computeMessage` generates the contextual text shown beside the count.

### Inline properties widget (`StreakInjector` class)
Injected into Obsidian's `.metadata-properties` DOM via `MutationObserver` (50 ms debounce). One observer per markdown leaf, stored in `this._observers`. `_injectAll()` iterates all open leaves; `_renderWidgets()` upserts `.streak-widget` divs inside matching `.metadata-property` rows. The widget shows flame + count + message. On mobile, messages are suppressed and the widget moves left of the property key via `order: -1`.

### Sidebar panel (`StreakWidgetView`, ItemView)
Always renders today's date regardless of the active note. Rebuilds entirely (`container.empty()`) on each `refresh()`. Triggered by `file-open`, `active-leaf-change`, and `metadata-changed` (500 ms debounce).

### Flame SVG rendering
The flame is a two-path SVG: `.streak-flame-outer` (silhouette) and `.streak-flame-inner` (teardrop highlight). `applyFlameColors()` stamps inline styles directly — CSS variable inheritance through SVG is unreliable in Obsidian's Electron shell.

**Multi-streak partial fill**: for multi-streaks on today, `applyPartialFlameGradient()` injects a `<linearGradient>` with a hard stop into the SVG's `<defs>`, filling the flame from the bottom up proportional to completed/total properties. Gradient IDs use `sfg-i-{streakId}` for inline widgets and `sfg-w-{streakId}` for the sidebar widget — the different namespaces prevent `url(#id)` from resolving to the wrong gradient when both surfaces are in the DOM simultaneously. The inner teardrop is hidden in partial states since it would bisect the boundary.

## Key conventions

- **No separate state store.** Streak state is always recomputed from frontmatter. The `_cache` map only caches the last computed `dayStates` array per streak to avoid redundant simulation on rapid re-renders.
- **Colors are always resolved to hex before stamping SVG.** Use `getComputedStyle` to resolve CSS variables, then pass hex values into flame functions. Never rely on `var(--...)` inside SVG attributes.
- **`applyFlameColors` always runs before the partial fill check.** It resets all path styles to a clean baseline. The partial fill block only overrides when `streak.type === 'multi' && isToday && 0 < done < total`; all other states fall through untouched.
- **Mobile uses `.is-mobile` body class, not media queries.** Obsidian sets this class reliably on mobile; viewport width is not a reliable signal. Runtime checks use `this.app.isMobile`.
- **Streak IDs are UUIDs** generated once on creation and never changed. They are used as DOM dataset attributes, gradient IDs, and cache keys.
