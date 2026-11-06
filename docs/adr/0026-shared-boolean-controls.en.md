# ADR-0026: Share switch and native checkbox styling

> 日本語: [0026-shared-boolean-controls.md](0026-shared-boolean-controls.md)

- Status: Accepted
- Date: 2026-11-04
- Related: [Issue #495](https://github.com/tyaro/banto/issues/495) / [ADR-0023](0023-shared-control-styles.en.md)

## Decision

Move settings-only switches into opt-in styles in `@banto/theme/css`.
Use `input.banto-switch[type="checkbox"][role="switch"]` inside `label.banto-switch-field`.
Keep labeling, checked/disabled state, Space interaction, and submission native.
CSS does not control application state, persistence, or authorization.

- Define track dimensions with `--banto-switch-width`, `-height`, and `-inset`.
  Give the label row a minimum height of `--banto-control-height-lg`.
- In forced colors, use `forced-color-adjust: none` and system colors only for custom painting.
  Checked state also moves the thumb. Remove the author-colored shadow and retain a solid focus outline.
- Forms and column-menu checkboxes keep native rendering. Share `--banto-checkbox-size: 1.1rem`,
  solid focus outlines, the existing ring, and disabled opacity.
  Retain scoped CSS and size fallbacks in each package for older themes and custom token consumers.
- Preserve the readonly-to-disabled fallback, the last-visible-column lock, events, and submission.

## Rationale and consequences

Prefer preserving existing interaction and standalone contracts over a JS wrapper or fully custom checkboxes.
Do not add external code, fonts, dependencies, or cross-package imports.
The updated settings markup requires the corresponding theme version.

Check every settings category in Japanese and English at 320px and 200% text.
Fit cards, buttons, long labels, QR images, and description/value rows within their containers,
and verify persistence/discard/leave guards and native interaction.
