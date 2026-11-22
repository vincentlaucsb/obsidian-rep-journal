# Workout plans

Write the plan in an Obsidian Markdown note. In the workout log, open **Menu → Plans** or choose **Follow a plan** on an empty day. Select the note and choose **Start plan**. In Obsidian, you can also run **Start workout plan from current note** while that note is active.

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

- An optional opening `#` heading names the plan. Text before the first section appears above the sections.
- Each `##` heading starts a section. You choose the section name. Text before its first `###` heading appears as section notes. A section can contain just instructions.
- Each `###` heading names an existing exercise or alias. Text below it appears while that exercise entry is selected. The plan picker reports unresolved or ambiguous headings with their line numbers. Choose a starter exercise with **Log set** to add its note before using it in a plan.
- Put `Mode: superset` on the first nonblank line below a section heading to rotate through its exercises. After a successful set, Rep Journal selects the next exercise and wraps to the first at the end. A superset needs at least two exercise headings.

Tap an exercise in the active section to switch to it. Choose **Start** beside the selected exercise or in Today’s plan banner to open its set form and follow the plan. The regular **Log set** picker lists the next exercise first, followed by the other exercises in the active plan. Use that picker for extra sets that keep the current plan position.

Choose **Done** on the active section when you finish it or want to move on early. Instruction-only sections also offer **Done** in Today’s banner. **Done** on the final section ends the active plan. Use **Previous section** or **Next section** to navigate manually, or **Stop plan** to end the plan from any section. Targets and rest instructions are Markdown notes, so you decide when to move on. Sets are saved in the selected workout in the order you logged them. Today remembers the active plan and position on this device.
