// src/loader.ts
import { createHash } from 'crypto';
import type { MarkdownFile, ParsedSection } from './types.js';
import {
  fetchOfficialDocs,
  FetchHttpError,
  FetchNetworkError,
  FetchResponseTooLargeError,
  FetchTimeoutError,
} from './fetcher.js';
import { parseSections } from './parser.js';
import { readCache, readCacheIfFresh, writeCache, getDefaultCachePath } from './cache.js';
import { extractContentPath } from './url-helpers.js';
import { deriveCategory, getUnmappedSegments } from './frontmatter.js';
import type { SourceKind, CorpusProvenance } from './trust.js';
import type { LoaderDiagnostics } from './canary.js';

/** Absolute floor below which fetched content is treated as truncated and must NOT overwrite the
 *  content cache (B1). Fixed, not env-tunable: MIN_SECTION_COUNT tunes only the canary/index floor
 *  (Task 2.4). The official corpus is ~141 sections, so 40 is a wide truncation margin.
 *
 *  Consequence (intentional): this guard is unconditional and runs BEFORE the canary, in BOTH
 *  trust modes. A fresh fetch of fewer than 40 sections is rejected here, so the canary's lower
 *  unsafe floor (UNSAFE_MIN_SECTION_COUNT=3) and a MIN_SECTION_COUNT=0 override apply only to
 *  cached/replayed content — never to a fresh fetch. A small `unsafe` mirror must therefore seed a
 *  cache first; it cannot bootstrap from a sub-40 fresh fetch. Lowering this floor to admit small
 *  fresh fetches would reopen the truncated-overwrite hole B1 exists to close. */
const CACHE_WRITE_MIN_SECTIONS = 40;

/**
 * Error thrown when fetched content fails validation checks.
 */
export class ContentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentValidationError';
  }
}

function getMaxStaleCacheMs(): number {
  const raw = process.env.DOCS_CACHE_MAX_STALE_MS?.trim();
  if (!raw) return 0;
  const val = Number(raw);
  if (!Number.isFinite(val) || val < 0) return 0;
  return val;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function resolveCachePath(override?: string): string {
  if (override) return override;
  const envPath = process.env.CACHE_PATH?.trim();
  return envPath && envPath.length > 0 ? envPath : getDefaultCachePath();
}

export interface LoadResult {
  files: MarkdownFile[];
  contentHash: string;
  provenance: CorpusProvenance;
  diagnostics: LoaderDiagnostics;
}

interface FetchResult {
  sections: ParsedSection[];
  contentHash: string;
  sourceKind: SourceKind;
  obtainedAt: number;
}

/**
 * Escape a string for safe inclusion in YAML.
 * Uses JSON.stringify which produces valid YAML double-quoted strings.
 */
function yamlEscape(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build synthetic YAML frontmatter from parsed section metadata.
 * Only includes non-empty fields.
 */
function buildSyntheticFrontmatter(fields: {
  topic?: string;
  id?: string;
  category?: string;
}): string {
  const lines: string[] = ['---'];

  if (fields.topic) {
    lines.push(`topic: ${yamlEscape(fields.topic)}`);
  }
  if (fields.id) {
    lines.push(`id: ${yamlEscape(fields.id)}`);
  }
  if (fields.category) {
    lines.push(`category: ${yamlEscape(fields.category)}`);
  }

  // Only return frontmatter if we have at least one field
  if (lines.length === 1) {
    return '';
  }

  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Derive a document ID from a URL's content path.
 * E.g., 'https://code.claude.com/docs/en/hooks/input-schema' → 'hooks-input-schema'
 */
function deriveIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const segments = extractContentPath(url);
  return segments.length > 0 ? segments.join('-') : undefined;
}

/**
 * Transform one parsed section into the frontmatter-enriched MarkdownFile the
 * index is built from. Exported so the live golden-query suite indexes the
 * cached corpus through the exact production path (golden-queries.live.test.ts)
 * — keep this the single source of that mapping.
 */
export function sectionToMarkdownFile(s: ParsedSection): MarkdownFile {
  const sourceKey = s.sourceUrl || s.title || '';
  const topic = s.title?.trim() || undefined;
  const id = deriveIdFromUrl(s.sourceUrl);
  const category = deriveCategory(sourceKey);

  // Build synthetic frontmatter to enrich metadata for search
  const frontmatter = buildSyntheticFrontmatter({ topic, id, category });

  return {
    path: s.sourceUrl || s.title || 'unknown',
    content: frontmatter + s.content,
  };
}

/**
 * Drop every section that repeats an earlier section exactly: same Source: URL
 * and same content. The first copy is kept, in its original position.
 *
 * Upstream llms-full.txt can list a page twice (2026-11: plugins/create,
 * plugins/install, plugins/mods/overview, each with identical text). Indexing
 * both copies produces duplicate chunk IDs and the same chunk twice in results.
 *
 * Sections that share a URL but differ in content are kept: which copy is
 * right is not knowable here, and corpus-validation.test.ts reports the
 * resulting duplicate chunk IDs. Sections with no Source: URL (the preamble)
 * are never dropped.
 *
 * Exported so the corpus tests index the cached corpus through the same
 * selection production uses.
 */
export function dropRepeatedSections(sections: readonly ParsedSection[]): ParsedSection[] {
  const seenContentByUrl = new Map<string, Set<string>>();
  return sections.filter((s) => {
    if (s.sourceUrl === '') return true;
    const seenContent = seenContentByUrl.get(s.sourceUrl);
    if (seenContent === undefined) {
      seenContentByUrl.set(s.sourceUrl, new Set([s.content]));
      return true;
    }
    if (seenContent.has(s.content)) return false;
    seenContent.add(s.content);
    return true;
  });
}

export async function loadFromOfficial(
  url: string,
  cachePath?: string,
  forceRefresh = false,
): Promise<LoadResult> {
  const resolvedCachePath = resolveCachePath(cachePath);
  const { sections, contentHash, sourceKind, obtainedAt } = await fetchAndParse(url, resolvedCachePath, forceRefresh);
  const nonEmpty = sections.filter((s) => s.content.trim().length > 0);
  const filtered = dropRepeatedSections(nonEmpty);
  const repeatedSectionCount = nonEmpty.length - filtered.length;

  // Parse diagnostics: count only Source:-anchored sections (exclude preamble pseudo-section)
  const sourceAnchoredCount = sections.filter(s => s.sourceUrl !== '').length;

  // Count fallback sections (sections where deriveCategory returns 'uncategorized' —
  // i.e. no URL segment was mapped). This is what the fallback-delta canary watches.
  //
  // NOTE — intentional population asymmetry: fallbackSectionCount is computed over the
  // PRE-filter `sections` array (matching sectionCount = sections.length, the value the
  // canary thresholds compare against), whereas fallbackSegmentCount / unmappedSegments
  // below are derived from the POST-filter `filtered` set (and skip empty-sourceUrl
  // preamble). The two are observability diagnostics over different populations; the
  // canary gates (fallback_segment_collapse FAIL, fallback_segment_drift WARN) read
  // fallbackSectionCount ONLY, so the asymmetry has no gate impact. Keep the gate input
  // on the same pre-filter basis as sectionCount.
  const fallbackSectionCount = sections.filter(s => {
    const sourceKey = s.sourceUrl || s.title || '';
    return deriveCategory(sourceKey) === 'uncategorized';
  }).length;

  console.error(
    `Parse diagnostics: ${sourceAnchoredCount} Source: lines, ` +
    `${nonEmpty.length} non-empty sections, ` +
    `${repeatedSectionCount} repeated section(s) skipped`
  );

  // Report unmapped URL segments (per-load, no module-level state)
  // Guard: skip preamble sections with empty sourceUrl (defense-in-depth —
  // getUnmappedSegments handles '' safely, but the guard makes intent explicit)
  const unmapped = new Map<string, number>();
  for (const section of filtered) {
    if (section.sourceUrl === '') continue;
    for (const seg of getUnmappedSegments(section.sourceUrl)) {
      unmapped.set(seg, (unmapped.get(seg) ?? 0) + 1);
    }
  }
  if (unmapped.size > 0) {
    const entries = [...unmapped.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([seg, count]) => `${seg} (${count}x)`)
      .join(', ');
    console.warn(`Category: ${unmapped.size} unmapped URL segment(s): ${entries}`);
  }

  // Build sorted unmapped segments: count desc, then name asc
  const sortedUnmapped: Array<[string, number]> = [...unmapped.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return {
    contentHash,
    provenance: { sourceKind, obtainedAt },
    // sectionCount = pre-filter total (includes empty preamble pseudo-sections);
    // nonEmptySectionCount = after the empty-content filter, before repeated
    // sections are dropped (so it can exceed files.length). Canary thresholds
    // compare against sectionCount.
    diagnostics: {
      sourceAnchoredCount,
      nonEmptySectionCount: nonEmpty.length,
      sectionCount: sections.length,
      fallbackSectionCount,
      fallbackSegmentCount: sortedUnmapped.length,
      unmappedSegments: sortedUnmapped,
    },
    files: filtered.map(sectionToMarkdownFile),
  };
}

async function fetchAndParse(
  url: string,
  cachePath: string,
  forceRefresh = false,
): Promise<FetchResult> {
  // Skip fresh cache check if force refresh requested
  if (!forceRefresh) {
    const fresh = await readCacheIfFresh(cachePath);
    if (fresh) {
      return {
        sections: parseSections(fresh.content),
        contentHash: hashContent(fresh.content),
        sourceKind: 'cached',
        obtainedAt: Date.now() - fresh.age,
      };
    }
  }

  try {
    const { content } = await fetchOfficialDocs(url);
    const sections = parseSections(content);

    // Refuse to overwrite the content cache with truncated content (B1). Fixed floor; the canary
    // owns the tunable index floor (Task 2.4). The throw fires BEFORE writeCache, so the good cache survives.
    if (sections.length < CACHE_WRITE_MIN_SECTIONS) {
      throw new ContentValidationError(
        `Fetched content has only ${sections.length} sections (minimum: ${CACHE_WRITE_MIN_SECTIONS}). ` +
          'Content may be truncated or incomplete.',
      );
    }

    const contentHash = hashContent(content);
    await writeCache(cachePath, content);
    return { sections, contentHash, sourceKind: 'fetched', obtainedAt: Date.now() };
  } catch (err: unknown) {
    // Only fall back to stale cache for expected operational errors.
    // Programmer errors (TypeError, RangeError, etc.) propagate immediately
    // so parser regressions are not masked by serving stale data.
    const isExpected =
      err instanceof FetchHttpError ||
      err instanceof FetchNetworkError ||
      err instanceof FetchResponseTooLargeError ||
      err instanceof FetchTimeoutError ||
      err instanceof ContentValidationError;

    if (!isExpected) throw err;

    if (err instanceof ContentValidationError) {
      console.error(`Content validation failed: ${err.message}`);
    } else {
      console.error(err.message);
    }

    // Fall back to stale cache on expected fetch/validation error
    const cached = await readCache(cachePath);
    if (cached) {
      const ageHours = (cached.age / 3600000).toFixed(1);

      // Reject stale cache exceeding hard age limit (if configured)
      const maxStaleMs = getMaxStaleCacheMs();
      if (maxStaleMs > 0 && cached.age > maxStaleMs) {
        const maxHours = (maxStaleMs / 3600000).toFixed(1);
        console.error(
          `Stale cache rejected: ${ageHours}h old exceeds max stale limit of ${maxHours}h`,
        );
        throw err;
      }

      console.warn(`Using cached docs (${ageHours}h old)`);
      return {
        sections: parseSections(cached.content),
        contentHash: hashContent(cached.content),
        sourceKind: 'stale-fallback',
        obtainedAt: Date.now() - cached.age,
      };
    }

    throw err;
  }
}
