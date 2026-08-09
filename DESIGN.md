# RBA design direction

This document defines the intent and rules for RBA's interface. The design is deliberately quiet and reading-first. It takes inspiration from the generous, editorial qualities of conversational tools without copying another product's brand.

The semantic CSS variables in `src/styles.css` are the source of truth for exact values. This document explains how to apply them.

## Priorities

When design goals conflict, use this order:

1. Reading comprehension
2. Simplicity
3. Accessibility
4. Clear system status
5. Visual character
6. Information density

The transcript is the product's primary surface. Controls should be easy to find when needed and visually recede while someone is reading.

## Foundation

- Use shadcn/ui for standard interactive components and states.
- Check `src/components/ui` and the shadcn registry before creating a common UI component.
- Keep generated and adapted shadcn primitives in `src/components/ui`.
- Keep product-specific compositions outside `src/components/ui`.
- Prefer semantic tokens such as `background`, `foreground`, `muted`, `border`, and `destructive` over literal colors.
- Add dependencies and components only when a current feature requires them.

## Visual language

Use Catppuccin Latte as the single product palette. Map shadcn semantic tokens to the exact Catppuccin values in `src/styles.css`; do not approximate or introduce parallel colors. Color should communicate action or meaning, not decorate empty space.

- Avoid gradients, glass effects, ornamental textures, and decorative animation.
- Prefer whitespace and subtle background changes to shadows.
- Use borders only where they clarify a boundary or interaction.
- Avoid nesting cards inside cards. Most reading content should sit directly on the page.
- Keep one visually dominant action in a region.
- Use rounded corners consistently and avoid pill shapes unless the content is naturally compact, such as a tag.

RBA has one light theme. Do not add automatic dark-mode or operating-system theme switching unless the product direction changes explicitly.

## Typography and reading

Use the system sans-serif stack for interface and prose. Use the system monospace stack only for paths, code, commands, identifiers, and structured tool output.

- Default reading text is 16px with a line height near 1.65.
- Keep sustained prose at or below 72 characters per line.
- Use sentence case throughout the interface.
- Use no more than three levels of type hierarchy on one screen.
- Prefer regular and medium weights. Reserve semibold for labels and clear emphasis.
- Muted text must remain comfortably readable; do not use low contrast to force hierarchy.
- Do not reduce important instructions, labels, or status text merely to make a layout fit.

## Spacing and layout

Use a 4px base rhythm. Prefer spacing values divisible by four, with 6px or 10px allowed for compact control internals.

- Give separate ideas visible breathing room.
- Keep application chrome compact and reading surfaces generous.
- Align the transcript and composer to the same content column.
- Preserve a stable composer position and allow the transcript to scroll independently.
- Truncate file paths and other machine values before allowing them to distort the layout; expose the full value accessibly where practical.

## Conversation patterns

- Distinguish authorship consistently without reducing the readability of either role or relying on color alone.
- Speaker labels are navigational aids, not prominent headings.
- Separate messages with whitespace rather than heavy dividers.
- Tool activity is secondary to the conversation. Show its action, state, and most useful detail without competing with the response.
- Streaming, completed, cancelled, and failed states must be distinguishable without relying on color alone.
- Error messages should state what happened and, when known, what the user can do next.

## Interaction

- Every interactive element must have a visible keyboard focus state.
- Use native semantics through shadcn primitives; do not recreate button, dialog, menu, tooltip, or form-control behavior with generic elements.
- Keep labels explicit. An icon alone is acceptable only when its meaning is conventional and it has an accessible name.
- Disable an action only when it genuinely cannot run. If the reason is not obvious, explain it nearby.
- Motion should explain state changes. Respect `prefers-reduced-motion` and avoid decorative motion.

## Review checklist

Before accepting a UI change, ask:

- Is the main text effortless to read for several minutes?
- Can any container, label, color, or decoration be removed without losing meaning?
- Does the interface use an existing shadcn component where appropriate?
- Are hierarchy and state still clear in both light and dark modes?
- Can the flow be completed with a keyboard and an obvious focus indicator?
- Does the change work at the application's minimum supported width without shrinking essential text?
