# ADR-0027: Read cell errors in a local overlay and separate reading from retrying

> 日本語: [0027-grid-error-reader.md](0027-grid-error-reader.md)

- Status: Accepted
- Date: 2026-11-04
- Related: [Issue #495](https://github.com/tyaro/banto/issues/495), spec §4.5, conventions §8 / §9 / §13

## Context

The old absolute, nonwrapping error below a cell clips at the right and bottom edges.
In a 320px browser, a 278px grid produced a roughly 2757px message and a larger scrollWidth.
Wrapping alone does not solve bottom clipping. An error in normal flow could shrink the scrollport
and remove the editor from the virtualization window. Very long errors need keyboard access and scrolling.

## Decision

Keep a permanent `.banto-grid-frame` and render the scrollport and error reader as siblings.
Only the reader is positioned absolutely. Preserve grid dimensions, row layout, editor DOM and session.
Constrain its width to the visible bounds, flip above/below the editor and limit height with internal scrolling.
Position updates do not recreate the message or move focus.

Keep the message's existing unique ID and `role="alert"`, referenced by the input's `aria-describedby`.
Use a named, focusable, nonmodal region around it, described by the message and keyboard hint.

- Enter failures retain the input. Tab / Shift+Tab with an existing error reads it without resubmission.
  Enter explicitly retries, including after changing the draft.
- With no error, Tab still commits. On failure, move to the reader only if the same session still owns focus.
- Shift+Tab / Escape in the reader returns to the input without saving or cancelling.
  Arrow keys, PageUp/Down, Home/End and forward Tab retain native behavior.
- Moving from the input into its own error reader suppresses blur saving.
  A late failure cannot reclaim focus from another action or a newer edit.
- Preserve IME and already handled key ownership. Provide optional message overrides for the label and hint.

## Alternatives

| Approach                                       | Assessment                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Wrap below the cell                            | Leaves bottom clipping and keyboard access unresolved               |
| Normal-flow error area                         | Can shrink the scrollport and virtualize the editor away            |
| Sticky element inside the scrollport           | Complicates containing blocks, horizontal scroll and content height |
| Body portal or general floating infrastructure | Extends the scope beyond this local error display                   |

## Consequences

Preserve normal, nonediting visuals and grid size. Document migration for consumers relying on direct-child
DOM structure or Tab while an error exists. A full-width reader temporarily covers other rows, while keeping
the input/message association and explicit retry. Add no dependencies, inter-package imports or external assets.
Verify narrow layouts, 200% text, nested clipping, bottom edges, virtualization, save failures and focus in a browser.
