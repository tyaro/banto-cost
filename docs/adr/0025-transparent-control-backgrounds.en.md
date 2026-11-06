# ADR-0025: Use transparent backgrounds by default for inputs and selects

> 日本語: [0025-transparent-control-backgrounds.md](0025-transparent-control-backgrounds.md)

- Status: Accepted
- Date: 2026-11-04
- Related: [Issue #495](https://github.com/tyaro/banto/issues/495) /
  [ADR-0022](0022-settings-controls.en.md) / [ADR-0023](0023-shared-control-styles.en.md) /
  [ADR-0024](0024-schema-form-appearance.en.md)

## Decision

The owner requested transparent default input and native select backgrounds.
This updates the fill decision in ADR-0022 and the background-color portion of ADR-0024's default-preservation decision.
Keep the previous ADRs as history.

- Apply this to `.banto-field-control`, forms fields except checkbox, and the app's `.banto-input`.
  Normal, hover, readonly, and disabled controls show the card or page behind them.
- Preserve borders, underlines, focus indicators, muted readonly text, disabled opacity/dashed underlines, and error presentation.
  Values, attributes, interaction, authorization, validation, and submission are unchanged.
- Keep native arrows, popups and options, grid editors, filter popovers, and overlay backgrounds intact.
  Do not forcibly suppress backgrounds supplied by autofill, forced colors, or the browser.

## Rationale and consequences

Use borders and underlines to identify controls instead of a light fill.
Do not add a special fill for readonly or disabled controls; retain the existing non-background state indicators.
This intentionally changes background colors for `appearance="default"` and standalone fields too.
Check contrast against actual light, dark, and glass ancestors, and update visual baselines.
