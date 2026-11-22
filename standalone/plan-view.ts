import type { parseWorkoutPlan } from '../src/workout-plan.ts';

export type RenderPlanMarkdown = (host: HTMLElement, markdown: string, sourcePath: string) => () => void;

export interface PlanViewProps {
  title: string;
  sourcePath: string;
  renderMarkdown?: RenderPlanMarkdown;
  dateLabel: string;
  result?: ReturnType<typeof parseWorkoutPlan>;
  error?: string;
  active: { section: number; exercise: number } | null;
  cannotLog: boolean;
  onBack: () => void;
  onStartPlan: () => void;
  onStopPlan: () => void;
  onMove: (section: number, exercise?: number) => void;
  onStartExercise: () => void;
  onDone: () => void;
}
