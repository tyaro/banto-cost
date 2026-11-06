# ADR-0023: Share the adopted control and page-navigation styles through the theme

> 日本語: [0023-shared-control-styles.md](0023-shared-control-styles.md)

- Status: Accepted
- Date: 2026-11-04
- Related: [Issue #495](https://github.com/tyaro/banto/issues/495) /
  [ADR-0022](0022-settings-controls.en.md) / [conventions.md](../conventions.md) §§4, 5, 9

## Context

The settings design has been adopted, and the shared forms now associate errors with controls and distinguish readonly from disabled.
The owner asked to continue the remaining work. The next step makes the adopted appearance available to other screens.
Input foundations currently live in app.css, floating labels in settings.css, and page navigation in the settings layout.
SCADA consumes theme and ui directly, without forms, and owns different edit, commit, and screen-switching behavior.

## Decision

- Add opt-in classes to `@banto/theme/css` and migrate settings to use them.
  Include the foundation styles so they work without app.css, Tailwind, or a Svelte wrapper.
  Keep ADR-0022's appearance and adoption scope while moving the shared CSS to the theme.
- A `label.banto-field` contains a native `.banto-field-control` followed by `.banto-field-label`.
  Support text, password, number, and single-select controls. Text labels sit inside empty controls and rise on focus or when filled.
  Select labels always stay above the value, including descriptive empty options. Keep the native arrow and popup.
- Use `.banto-field--stacked` for long labels or narrow fields. Return the label to normal flow, wrap the full text,
  and reserve its height above the control. A fixed absolute position alone does not reserve space for multiple lines.
- Page navigation uses `nav.banto-section-nav > a[href]` and `aria-current="page"` for the current link.
  Preserve wrapping, focus outlines, and forced-colors selection indicators. This does not provide ARIA tabs behavior.
- The consumer owns values, events, readonly/disabled attributes, descriptions, errors and ARIA, copy, permissions, hrefs, and routing.
  Put help, units, and error text outside the floating-label area. CSS does not control updates or submission,
  and readonly does not replace authorization.

## Alternatives considered

- **Add Svelte wrappers to `@banto/ui`:** These styles only need native HTML. Theme classes avoid adding a second API for values and events.
- **Change the defaults of `@banto/forms`:** Schema forms have a different label structure and their own styles.
  Keep their defaults while checking density, long field names, and external consumers separately.
- **Replace SCADA styles at the same time:** Its density, IME, commit, and screen-switching behavior require a separate adoption pass.

## Consequences

- No new dependencies, cross-package imports, or exports. The existing theme stylesheet exposes the classes.
  UI without the dedicated classes is unchanged. Tables, checkboxes, and switches are outside this change.
- Form widths, card layouts, save behavior, permissions, and unsaved-change guards remain in the settings application.
- Document the HTML and ownership contract in the theme README. Verify both settings and an external consumer without app.css.
  Native screen-reader and touch checks, and SCADA adoption, remain distinct from automated browser checks.
