shadcn/ui, new-york style, base colour zinc — copied in as owned code (`components.json`),
not imported from a package. Edits here are edits to this application.

`select`, `radio` and `checkbox` are the native elements with the same look rather than
the Radix versions: the window is one person's Mac, the native controls are already
accessible and keyboard-correct, and a `<select>` is what `page.selectOption` drives in
the Playwright specs. Radix appears only where it earns its place — `Slot` for `asChild`,
`Label` for the label/control association, `Separator` for a divider with the right role.
