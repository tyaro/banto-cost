# ADR-0024: Make schema-form underline styling opt-in and keep labels above controls

> 日本語: [0024-schema-form-appearance.md](0024-schema-form-appearance.md)

- Status: Accepted
- Date: 2026-11-04
- Related: [Issue #495](https://github.com/tyaro/banto/issues/495) /
  [ADR-0023](0023-shared-control-styles.en.md) / [conventions.md](../conventions.md) §§4, 5, 9

## Context

Settings and login now use shared styles. The next adoption covers item and user-management forms,
which mix schema-driven `BantoForm` controls and handwritten inputs. Creation, editing, and password reset
should share an appearance while preserving existing consumers' defaults.

## Decision

- Add `appearance?: 'default' | 'underline'` to `BantoForm`. Omission preserves the existing appearance.
  Underline requires matching `@banto/theme/css`, without adding package dependencies or cross-package imports.
- Underline labels always occupy normal flow above the control. Support text, password, number, select,
  date, and textarea with stacked labels. Preserve native date UI, textarea rows and vertical resizing,
  and the existing checkbox appearance. Do not substitute `DraftNumberField` for number fields.
- Each field forwards an optional `class` to its native element, alongside the existing readonly class.
  `BantoForm` applies shared classes; the consumer loads the theme stylesheet.
- Share generated IDs, label targets, required markers, and event wiring across appearances. Render errors outside labels.
  Keep schema, store, draft, validation, submission, and readonly contracts unchanged.
- Explicitly adopt the option for item creation/editing and user creation/editing/password reset.
  List controls, grid cell editors, and SCADA are outside this change.

## Alternatives

- **Change the default everywhere:** This would implicitly change external consumers and custom screen density.
- **Use floating labels in schema forms:** Arbitrary long labels, placeholders, date controls, and textareas need different treatment.
  Stacked labels reserve their full height without adding presentation properties to the schema.
- **Copy shared CSS into forms:** This would duplicate theme maintenance. Use the public class contract instead.

## Consequences

- `FormAppearance` and field `class` are additive APIs. Existing consumers need no changes.
  Adoption requires matching forms and theme versions.
- Run label, error, ID, submission, and readonly regressions for both appearances.
  Check CSS specificity, tabular numeric glyphs, and multiline controls in a real browser too.
