<script lang="ts">
  import type { PlanViewProps } from './plan-view.ts';

  let {
    title, sourcePath, renderMarkdown, dateLabel, result, error, active, cannotLog,
    onBack, onStartPlan, onStopPlan, onMove, onStartExercise, onDone,
  }: PlanViewProps = $props();
  let plan = $derived(result?.plan);
</script>

{#snippet notes(value?: string)}
  {#if value && renderMarkdown}
    <div class="notes" {@attach (host) => renderMarkdown(host, value, sourcePath)}></div>
  {:else if value}
    <p class="notes">{value}</p>
  {/if}
{/snippet}

<section class="page">
  <button type="button" class="text-button" onclick={onBack}>← Workout log</button>
  <h1>{plan?.title ?? title}</h1>
  <p class="secondary">{dateLabel}</p>

  {#if error}
    <p role="alert" class="warning">{error}</p>
  {:else if !result}
    <p role="status">Loading plan…</p>
  {:else if result.issues}
    <ul class="warning">
      {#each result.issues as issue}
        <li>Line {issue.line}. {issue.message}</li>
      {/each}
    </ul>
  {/if}

  {#if plan}
    {@render notes(plan.notes)}

    {#if active}
      {@const position = active.section}
      <div class="plan-controls">
        <button type="button" disabled={position === 0} onclick={() => onMove(position - 1)}>Previous section</button>
        <button type="button" disabled={position === plan.sections.length - 1} onclick={() => onMove(position + 1)}>Next section</button>
      </div>
    {/if}

    {#each plan.sections as section, index}
      {@const current = index === active?.section}
      <section class="plan-section" class:current-section={current} aria-current={current ? 'step' : undefined}>
        {#if current}<p class="active-section-label">Active section</p>{/if}
        <div class="section-heading">
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (Focus moves to the active heading programmatically.) -->
          <h2 tabindex={current ? -1 : undefined}>{section.name}</h2>
          {#if section.superset}<span class="secondary">Superset</span>{/if}
        </div>
        {@render notes(section.notes)}

        {#each section.exercises as exercise, exerciseIndex}
          {@const selected = current && exerciseIndex === active?.exercise}
          <div class="plan-exercise">
            <div class="plan-exercise-heading">
              {#if current}
                <button
                  type="button"
                  class="exercise-choice"
                  aria-pressed={selected}
                  data-plan-status={selected ? 'next' : 'planned'}
                  onclick={() => onMove(index, exerciseIndex)}
                >{exercise.name}</button>
              {:else}
                <h3>{exercise.name}</h3>
              {/if}
              {#if selected}
                <button type="button" class="primary" aria-label={`Start ${exercise.name}`} disabled={cannotLog} onclick={onStartExercise}>Start</button>
              {/if}
            </div>
            {@render notes(exercise.notes)}
          </div>
        {/each}

        {#if current}
          <button type="button" class="plan-done" aria-label={`Done with ${section.name}`} onclick={onDone}>Done</button>
        {/if}
      </section>
    {/each}

    <div class="plan-controls">
      {#if active}
        <button type="button" onclick={onStopPlan}>Stop plan</button>
      {:else}
        <button type="button" class="primary" onclick={onStartPlan}>Start plan</button>
      {/if}
    </div>
  {/if}
</section>
