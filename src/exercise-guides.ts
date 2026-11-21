import exerciseSources from '../docs/exercise-sources.json' with { type: 'json' };
import { nameKey, type Exercise } from './model.ts';

type GuideExercise = Pick<Exercise, 'name' | 'aliases'>;
type SourceEntry = (typeof exerciseSources)[number];

const equivalentNames = new Map([
  ['abdominal crunch machine', 'machine crunch'],
  ['back hyperextension', 'back extension'],
  ['chest press machine', 'machine chest press'],
  ['dumbbell hammer curl', 'hammer curl'],
  ['flat dumbbell bench press', 'dumbbell bench press'],
  ['lying leg curl machine', 'lying leg curl'],
  ['military press', 'standing barbell overhead press'],
  ['palloff press', 'cable pallof press'],
  ['seated calf raise machine', 'seated machine calf raise'],
  ['seated leg curl machine', 'seated leg curl'],
  ['standing calf raise machine', 'standing machine calf raise'],
  ['straight-arm cable pushdown', 'straight-arm pulldown'],
]);

const publishers = new Map([
  ['acefitness.org', 'ACE Fitness'],
  ['shop.bodybuilding.com', 'Bodybuilding.com'],
  ['concept2.com', 'Concept2'],
  ['muscleandstrength.com', 'Muscle & Strength'],
  ['nasm.org', 'NASM'],
  ['strengthlog.com', 'StrengthLog'],
  ['worldathletics.org', 'World Athletics'],
]);

const catalog = new Map<string, SourceEntry[]>();
for (const entry of exerciseSources) {
  for (const key of new Set([entry.name, ...entry.aliases].map(nameKey))) {
    const matches = catalog.get(key) ?? [];
    matches.push(entry);
    catalog.set(key, matches);
  }
}

function matchesFor(name: string): SourceEntry[] {
  const key = nameKey(name);
  return catalog.get(key) ?? catalog.get(equivalentNames.get(key) ?? '') ?? [];
}

function catalogSources(exercise: GuideExercise): string[] {
  const byName = matchesFor(exercise.name);
  const matches = byName.length ? byName : [...new Set(exercise.aliases.flatMap(matchesFor))];
  return matches.length === 1 ? matches[0].sources : [];
}

function guideUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (!/^https?:\/\//i.test(text) || /[\s<>]/.test(text)) return;
  try {
    const url = new URL(text);
    if (!url.username && !url.password) return url;
  } catch {
    return;
  }
}

function urlKey(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/$/, '')}${url.search}${url.hash}`;
}

function bodyStart(markdown: string): number {
  const frontmatter = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$)/m.exec(markdown);
  return frontmatter?.index === 0 ? frontmatter[0].length : 0;
}

function guideHeadingEnd(body: string): number | undefined {
  let fence: string | undefined;
  for (const line of body.matchAll(/[^\r\n]*(?:\r?\n|$)/g)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line[0]);
    if (marker) {
      const [, delimiter, rest] = marker;
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && !rest.trim()) fence = undefined;
    } else if (!fence && /^ {0,3}##[ \t]+Exercise guides(?:[ \t]+#+)?[ \t]*\r?$/im.test(line[0])) {
      return line.index + line[0].length;
    }
  }
}

export function appendExerciseGuides(markdown: string, exercise: GuideExercise, sources?: unknown): string {
  const sourcesFromNote: unknown[] = Array.isArray(sources) ? sources : [];
  const offset = bodyStart(markdown);
  const body = markdown.slice(offset);
  const seen = new Set<string>();
  for (const match of body.matchAll(/<(https?:\/\/[^\s<>]+)>|(https?:\/\/(?:[^\s<>"()[\]]|\([^()\s]*\))+)/gi)) {
    const url = guideUrl(match[1] ?? match[2].replace(/[.,;!]$/, ''));
    if (url) seen.add(urlKey(url));
  }

  const links: string[] = [];
  for (const candidate of [...sourcesFromNote, ...catalogSources(exercise)]) {
    const url = guideUrl(candidate);
    if (!url || seen.has(urlKey(url))) continue;
    seen.add(urlKey(url));
    const host = url.hostname.replace(/^www\./, '');
    links.push(`- [${publishers.get(host) ?? host}](<${url.href}>)`);
  }
  if (!links.length) return markdown;

  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const guideText = links.join(newline);
  const headingEnd = guideHeadingEnd(body);
  if (headingEnd === undefined) {
    const separator = !markdown || /\r?\n[ \t]*\r?\n$/.test(markdown) ? '' : markdown.endsWith('\n') ? newline : newline.repeat(2);
    return `${markdown}${separator}## Exercise guides${newline}${newline}${guideText}${newline}`;
  }

  const heading = markdown.slice(0, offset + headingEnd);
  const rest = body.slice(headingEnd);
  const blank = /^(?:[ \t]*\r?\n)+/.exec(rest)?.[0];
  const content = rest.slice(blank?.length ?? 0);
  const before = heading.endsWith('\n') ? '' : newline;
  const after = content && !/^- /.test(content) ? newline : '';
  return `${heading}${before}${blank ?? newline}${guideText}${newline}${after}${content}`;
}
