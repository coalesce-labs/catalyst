# @catalyst/tokens

Catalyst's design tokens, authored in [DTCG](https://tr.designtokens.org/format/) format
and compiled to three consumable artifacts. Two design systems coexist in the same
package and are selected at runtime via `[data-system=...]` on `<html>`:

- **`operator-console`** (System A, dark-only, default) — mission-control density, amber
  accent, Space Grotesk + IBM Plex Sans + JetBrains Mono. See
  [`thoughts/shared/product/ux-refresh/design-direction-A-operator-console.md`](../../thoughts/shared/product/ux-refresh/design-direction-A-operator-console.md).
- **`precision-instrument`** (System B, light-primary) — editorial restraint, ink-blue
  accent, GT Super Display + Söhne + Söhne Mono. See
  [`thoughts/shared/product/ux-refresh/design-direction-B-precision-instrument.md`](../../thoughts/shared/product/ux-refresh/design-direction-B-precision-instrument.md).

No app consumers are wired yet — a follow-on ticket renders both systems side-by-side
in the orch-monitor mockup harness.

## Outputs

Running `bun run build` produces:

| File | Consumer | Contents |
| --- | --- | --- |
| `dist/theme.css` | any HTML/CSS consumer | CSS custom properties. `:root, [data-system="operator-console"]` carries System A; `[data-system="precision-instrument"]` overrides to System B. |
| `dist/tailwind.tokens.js` | Tailwind config | `theme.extend` fragment of `var(--…)` references — drop-in for `tailwind.config.js`. |
| `dist/{index,generated}.{js,d.ts}` | TS code | Typed named consts per token plus a nested `tokens` object and a `Tokens` type — every value is a `var(--…)` reference. |
| `plugins/dev/scripts/orch-monitor/public/mockups/_shared/tokens.css` | static mockup harness | Copy of `dist/theme.css` at a stable URL, so static HTML mockups consume tokens without their own build step. |

No `dist/` file contains a literal hex value; the only hex literals in the package
live in `tokens/*.json`.

## Consuming

```ts
// import once at app root
import "@catalyst/tokens/theme.css";
```

```js
// tailwind.config.js
import catalystTokens from "@catalyst/tokens/tailwind";

export default {
  theme: { extend: catalystTokens },
  // ...
};
```

```ts
// any TS file
import { colorAccent, tokens } from "@catalyst/tokens";

const activeBorder = tokens.color.accent; // "var(--color-accent)"
```

Switch systems at runtime by toggling the attribute on `<html>` (or any ancestor):

```ts
document.documentElement.dataset.system = "precision-instrument";
// or remove it / set to "operator-console" for System A (the default)
```

Because System A lives under `:root, [data-system="operator-console"]`, the dark
system is active whenever no `data-system` attribute is set. System B only takes
effect when `data-system="precision-instrument"` is present.

## Adding a new token

1. **Pick the right source file** under `tokens/`:
   - `base.json` — neutral tokens shared by both systems: spacing, radius, motion
     fallback durations, font-weight.
   - `operator-console.json` — values specific to System A. Add the same path in
     `precision-instrument.json` with matching `$type` if the token should exist in
     both systems.
   - `precision-instrument.json` — values specific to System B.
2. **Add the entry** in DTCG format. When the parent group declares `$type`, only
   `$value` is required on the leaf:
   ```json
   {
     "color": {
       "$type": "color",
       "brand-amber": { "$value": "#FFB547" }
     }
   }
   ```
3. **Pick a `$type`** if you are starting a new group. Current groups use: `color`,
   `fontFamily`, `fontWeight`, `dimension` (spacing, radius, font-size, line-height,
   letter-spacing), `duration`, `cubicBezier`.
4. **Run the build:**
   ```sh
   bun run --cwd packages/tokens build
   ```
5. **Verify output** in all three artifacts:
   - `dist/theme.css` — a new `--<group>-<name>` custom property appears in the
     block you added it to.
   - `dist/tailwind.tokens.js` — the token is routed into its Tailwind scale
     (`colors`, `spacing`, `fontSize`, `transitionDuration`, etc.) if the build
     script's router recognizes the group. New groups need the router extended in
     `build/build.mjs` before they surface to Tailwind.
   - `dist/generated.d.ts` — a new named const (camelCase path) and a matching entry
     in the nested `tokens` tree.

## The `data-system` convention

Both systems declare the same token paths (`--color-bg`, `--spacing-4`,
`--font-size-heading`, etc.) but with different values. This means a single
stylesheet authored against `var(--color-bg)` will render correctly under either
system — toggling the attribute flips every token at once.

- System A uses the `:root` fallback selector: it is active whenever the attribute
  is absent.
- System B takes effect only under `[data-system="precision-instrument"]`.

To preview a component under either system, wrap it in an element carrying the
attribute:

```html
<section data-system="precision-instrument">
  <!-- renders with System B values -->
</section>
```

## Layout

```text
packages/tokens/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── build/
│   └── build.mjs                        # Style Dictionary 5, two passes
├── tokens/
│   ├── base.json                        # spacing, radius, motion, font-weight
│   ├── operator-console.json            # System A (dark)
│   └── precision-instrument.json        # System B (light)
├── src/
│   ├── index.ts                         # re-export of ./generated
│   ├── generated.ts                     # generated — gitignored
│   └── __tests__/
│       ├── outputs.test.ts
│       └── generated.test.ts
└── dist/                                # generated — gitignored
    ├── theme.css
    ├── tailwind.tokens.js
    ├── index.{js,d.ts}
    └── generated.{js,d.ts}
```
