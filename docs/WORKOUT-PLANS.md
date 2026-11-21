# Workout plans

Write the plan in an Obsidian Markdown note. Open **Workout → Start plan** and choose the note, or run **Start workout plan from current note** from the command palette while the note is active.

```markdown
# Upper body

Keep the first working set comfortable.

## Warm-Up

Start easy and take your time between movements.

### Band Pull-apart

2 sets of 15. Pause briefly at the end of each rep.

## Phase 1
Mode: superset

### Bench Press

3 sets of 8–10 reps.

### Face Pull

3 sets of 12–15 reps. Rest 90 seconds after this exercise.
```

- An optional opening `#` heading names the plan. Text before the first section appears under **Plan notes**.
- Each `##` heading starts a section. You choose the section name. Text before its first `###` heading appears as section notes. A section can contain just instructions.
- Each `###` heading names an existing exercise or alias. Text below it appears while that exercise entry is selected. The plan picker reports unresolved or ambiguous headings with their line numbers. Create or select a starter exercise in Workout once to add its note before using it in a plan.
- Put `Mode: superset` on the first nonblank line below a section heading to rotate through its exercises. After a successful set, Rep Journal selects the next exercise and wraps to the first at the end. A superset needs at least two exercise headings.

Tap an exercise in the active section to switch to it. You can also use the regular exercise picker for extra work. A set for an exercise outside the active section leaves the plan position as it was. Every exercise keeps its own set draft.

Use **Previous section** and **Next section** to move through the plan, and **Stop plan** to return to ordinary logging. Targets and rest instructions remain Markdown notes, so you decide when to move on. Sets are saved in the selected workout in the order you logged them. The plan stays active while the Workout tab is open.
