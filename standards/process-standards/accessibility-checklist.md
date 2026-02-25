# Accessibility Checklist

WCAG 2.1 AA compliance checklist at the component level. Apply during implementation and code review for any PR that adds or modifies UI components. This is a project template — projects can override it via `.sdlc/standards/process-standards/accessibility-checklist.md` to add design-system-specific requirements.

## Keyboard Navigation

Every interactive element must be operable without a mouse.

- [ ] All buttons, links, inputs, and interactive controls are reachable via Tab in a logical order (matches visual layout, top-to-bottom / left-to-right)
- [ ] No keyboard trap: the user can Tab away from any element, including custom widgets and modals
- [ ] Focus is never lost (sent to `<body>` or an invisible element) during dynamic content changes
- [ ] After a modal or dialog closes, focus returns to the element that opened it
- [ ] Custom interactive components (e.g., a listbox, a data grid) implement the appropriate ARIA keyboard pattern from the ARIA Authoring Practices Guide

## Focus Indicators

- [ ] All focusable elements have a visible focus indicator — the browser default outline must not be removed without a replacement
- [ ] Focus indicator has at least 3:1 contrast ratio against the adjacent background
- [ ] Focus indicator is visible in both light and dark modes

## Screen Reader Support

- [ ] All images and icons have meaningful `alt` text, or `alt=""` if purely decorative
- [ ] Form inputs have explicit `<label>` elements (preferred) or `aria-label` / `aria-labelledby`
- [ ] Status messages that appear dynamically (success, error, loading complete) are announced using `aria-live="polite"` (non-urgent) or `aria-live="assertive"` (urgent, e.g., error)
- [ ] Loading states set `aria-busy="true"` on the affected region
- [ ] Modal dialogs use `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` pointing to the dialog title

## Color and Contrast

- [ ] Normal text (under 18pt / 14pt bold): 4.5:1 contrast ratio against background
- [ ] Large text (18pt+ / 14pt+ bold) and UI components: 3:1 contrast ratio
- [ ] Information is never conveyed by color alone — always use a secondary indicator (icon, text, pattern)
- [ ] Color choices work for common color blindness types (deuteranopia, protanopia) — verify with a simulator

## ARIA Usage

- [ ] Prefer semantic HTML elements over ARIA (`<button>` over `<div role="button">`, `<nav>` over `<div role="navigation">`)
- [ ] Do not use ARIA to describe a native element's existing semantics — `<button role="button">` is redundant
- [ ] Every `role` has the required ARIA properties set (e.g., `role="listbox"` requires `aria-label` or `aria-labelledby`)
- [ ] `aria-label` text is meaningful in isolation — it will be read without surrounding visual context

## Component-Specific Requirements

These are set in component contracts (`docs/ux/components/`). The component contract is the authoritative source for a specific component's keyboard behavior, ARIA roles, and focus management. This checklist covers the universal baseline; contracts specify the per-component details.

## Testing Accessibility

- Keyboard-only test: navigate the feature using only Tab, Shift+Tab, Enter, Space, and arrow keys. Every action should be possible.
- Screen reader test: VoiceOver (macOS) or NVDA (Windows). Navigate the feature and verify all content is announced correctly and interactive elements are labeled.
- Contrast check: use the browser DevTools accessibility panel or a tool like axe DevTools to verify contrast ratios.
- Automated check: `axe-core` or similar catches a subset of violations — run it, but do not rely on it exclusively. Automated tools miss ~30–40% of WCAG failures.

## Notes

WCAG 2.1 AA is the legal standard in most jurisdictions and the baseline for this project. WCAG 2.2 adds a few new criteria (focus appearance, dragging alternatives) — apply them where feasible but they are not strictly required in Phase 1.
