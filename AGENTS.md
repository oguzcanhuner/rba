## YAGNI

Generally speaking, abide by the YAGNI principle. Avoid adding features that aren't necessary to achieve the current goal/task.
If you think that there's a direction we should take which would improve the overall design of the program, please call it out to the user.

## UI components

Use shadcn/ui as the default source for reusable interface components. Before building a common UI pattern from scratch, check the components already installed in `src/components/ui` and the shadcn registry. Add or adapt a shadcn component in most cases so accessibility, interaction states, and styling conventions remain consistent.

Create custom components when the interface is genuinely product-specific or shadcn does not provide a suitable primitive. Keep product-specific composition outside `src/components/ui`, and document a deliberate exception when custom code replaces an available shadcn component.

## Testing

You as the agent should perform all automated checks; tests, typechecking etc. The user will do visual checks. Do not take screenshots unless explicitly told to.

## Commits

Use a conventional commits style for the commit message. For the commit body, write in regular human prose. Focus on why the change was made, not what was done.
