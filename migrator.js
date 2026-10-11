/**
 * migrator.js — Repo Migration & Deduplication helper for LeetSync
 *
 * Responsibilities
 * ─────────────────
 * 1. Fetch the full repo tree in ONE API call via /git/trees/{branch}?recursive=1
 * 2. Index all existing solution folders — handles both naming patterns:
 *      • LeetSync native : 0001-two-sum/
 *      • LeetHub legacy  : Two-Sum/
 * 3. Compare against the local solved store → identify missing slugs
 * 4. Assemble atomic batch commits for the missing solutions (reuses
 *    background.js commitBatch logic via message passing when run inside
 *    the extension, or can be called directly in Node for offline testing)
 *
 * Public API (also wired as message handler in background.js)
 * ────────────────────────────────────────────────────────────
 *   migrateScan(settings, solved)   → { totalLocal, inRepo, missing, missingItems, repoIndex }
 *   migrateImport(settings, solved, missingItems, layout, onProgress)  → { committed }
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Max blobs to touch per tree/commit API call (GitHub's implicit safe limit). */
const BATCH_SIZE = 25;

/**
 * Regex patterns for the two known folder naming conventions.
 * Group 1 = zero-padded id, Group 2 = slug  (native)
 * Group 1 = title in Title-Case              (leethub)
 */
const RE_NATIVE  = /^(\d{4})-([a-z0-9-]+)\/$/;
const RE_LEETHUB = /^([A-Z][^/]+)\/$/;         // Title-Case, no numeric prefix

// ─── Shared GitHub REST helper ────────────────────────────────────────────────

/**
 * Thin wrapper around fetch → GitHub REST API.
 * Throws on HTTP errors with a `.status` property set.
 * @param {object} s  - settings: { token, owner, repo, branch }
 * @param {string} path  - path relative to /repos/{owner}/{repo}
 * @param {object} [opts]
 */
async function ghFetch(s, path, opts = {}) {
  const url  = `https://api.github.com/repos/${s.owner}/${s.repo}${path}`;
  const res  = await fetch(url, {
    method:  opts.method || 'GET',
    body:    opts.body,
    headers: {
      'Authorization':        `Bearer ${s.token}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type':         'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err  = new Error(`GitHub ${res.status}: ${text.slice(0, 240)}`);
    err.status  = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// ─── Repo tree indexing ───────────────────────────────────────────────────────

/**
 * Fetch the entire repo tree in one shot and return a Set of slugs already
 * present, plus a raw map for diagnostics.
 *
 * @param {object} settings
 * @returns {{ slugSet: Set<string>, rawFolders: string[], truncated: boolean }}
 */
async function fetchRepoIndex(settings) {
  const s        = settings;
  const branch   = encodeURIComponent(s.branch || 'main');
  const data     = await ghFetch(s, `/git/trees/${branch}?recursive=1`);
  const slugSet  = new Set();
  const rawFolders = [];

  for (const node of data.tree || []) {
    if (node.type !== 'tree') continue;          // only folders
    const part = node.path + '/';                // normalise: add trailing slash

    // ── LeetSync native: 0001-two-sum
    const m1 = RE_NATIVE.exec(part);
    if (m1) {
      const slug = m1[2];                        // e.g. "two-sum"
      slugSet.add(slug);
      rawFolders.push(node.path);
      continue;
    }

    // ── LeetHub: Two-Sum  →  two-sum
    const m2 = RE_LEETHUB.exec(part);
    if (m2) {
      // Convert "Two-Sum" → "two-sum" for slug matching
      const slug = m2[1]
        .replace(/([a-z])([A-Z])/g, '$1-$2')    // camelCase boundary
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/gi, '-')
        .toLowerCase()
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      slugSet.add(slug);
      rawFolders.push(node.path);
    }
  }

  return { slugSet, rawFolders, truncated: !!data.truncated };
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

/**
 * Compare local solved store vs. remote repo tree.
 *
 * @param {object} settings
 * @param {object} solved    - keyed by slug, value is the stored entry
 * @returns {{ totalLocal, inRepo, missing, missingItems, repoIndex, truncated }}
 */
async function migrateScan(settings, solved) {
  const { slugSet, rawFolders, truncated } = await fetchRepoIndex(settings);

  const allSlugs    = Object.keys(solved);
  const inRepoSlugs = allSlugs.filter(sl => slugSet.has(sl));
  const missingSlugs = allSlugs.filter(sl => !slugSet.has(sl));

  // Build payload items for missing slugs (one item per language solution)
  const missingItems = [];
  for (const slug of missingSlugs) {
    const entry = solved[slug];
    for (const [ext, langInfo] of Object.entries(entry.langs || {})) {
      missingItems.push({
        submissionId: langInfo.submissionId,
        slug:         entry.slug,
        id:           entry.id,
        title:        entry.title,
        difficulty:   entry.difficulty,
        tags:         entry.tags      || [],
        constraints:  entry.constraints || [],
        code:         langInfo.code   || '',   // may be absent if old store
        langName:     langInfo.lang,
        ext,
        runtime:      langInfo.runtime  || '',
        memory:       langInfo.memory   || '',
        timestamp:    langInfo.timestamp || Date.now(),
      });
    }
  }

  return {
    totalLocal:   allSlugs.length,
    inRepo:       inRepoSlugs.length,
    missing:      missingSlugs.length,
    missingItems,
    repoIndex:    rawFolders,
    truncated,
  };
}

// ─── Content generators (mirrors background.js — kept in sync) ────────────────

function pad(n)          { return String(n).padStart(4, '0'); }
function withNewline(s)  { s = String(s == null ? '' : s); return s.endsWith('\n') ? s : s + '\n'; }
function esc(s)          { return String(s).replace(/\|/g, '\\|'); }
function slugify(title)  { return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function folderOf(entry, layout) {
  if (layout === 'leethub') {
    // Title-Case with hyphens, no numeric prefix — mirrors LeetHub convention
    return entry.title
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('-');
  }
  // Default: native LeetSync  0001-two-sum
  return `${pad(entry.id)}-${entry.slug}`;
}

function problemReadme(entry) {
  const lines = [];
  lines.push(`# ${entry.id}. ${entry.title}`);
  lines.push('');
  lines.push(`**Difficulty:** ${entry.difficulty}` +
    (entry.tags.length ? `  \n**Tags:** ${entry.tags.join(', ')}` : ''));
  lines.push('');
  lines.push(`[View on LeetCode](https://leetcode.com/problems/${entry.slug}/)`);
  if (entry.constraints.length) {
    lines.push('');
    lines.push('## Constraints');
    lines.push('');
    entry.constraints.forEach(c => lines.push(`- ${c}`));
  }
  lines.push('');
  lines.push('## Solutions');
  lines.push('');
  lines.push('| Language | File | Runtime | Memory | Date |');
  lines.push('| --- | --- | --- | --- | --- |');
  Object.keys(entry.langs).sort().forEach(ext => {
    const l = entry.langs[ext];
    lines.push(`| ${esc(l.lang)} | [solution.${ext}](./solution.${ext}) | ${esc(l.runtime || '-')} | ${esc(l.memory || '-')} | ${new Date(l.timestamp).toISOString().slice(0, 10)} |`);
  });
  return lines.join('\n') + '\n';
}

function rootReadme(solved) {
  const all    = Object.values(solved).sort((a, b) => a.id - b.id);
  const counts = { Easy: 0, Medium: 0, Hard: 0 };
  all.forEach(e => { if (counts[e.difficulty] != null) counts[e.difficulty]++; });
  const lines  = [];
  lines.push('# LeetCode Solutions');
  lines.push('');
  lines.push(`**Solved:** ${all.length}  |  Easy ${counts.Easy}  |  Medium ${counts.Medium}  |  Hard ${counts.Hard}`);
  lines.push('');
  lines.push('| # | Title | Difficulty | Tags | Languages |');
  lines.push('| --- | --- | --- | --- | --- |');
  all.forEach(e => {
    lines.push(`| ${e.id} | [${esc(e.title)}](./${e.slug}) | ${e.difficulty} | ${esc((e.tags||[]).join(', '))} | ${Object.keys(e.langs).sort().map(x => e.langs[x].lang).join(', ')} |`);
  });
  return lines.join('\n') + '\n';
}

// ─── Atomic batch commit ──────────────────────────────────────────────────────

/**
 * Commit a single batch of items to GitHub as one atomic commit.
 * Re-fetches HEAD ref each time to stay in sync with concurrent pushes.
 *
 * @param {object} settings
 * @param {object} solved      - full solved store (used for root README)
 * @param {object[]} batch     - array of submission items
 * @param {string} layout      - 'slug' | 'leethub'
 */
async function commitBatch(settings, solved, batch, layout = 'slug') {
  const s = settings;

  // 1. Current HEAD
  const ref        = await ghFetch(s, `/git/ref/heads/${encodeURIComponent(s.branch)}`);
  const headSha    = ref.object.sha;
  const headCommit = await ghFetch(s, `/git/commits/${headSha}`);
  const baseTree   = headCommit.tree.sha;

  // 2. Build a merged solved snapshot for README generation
  const snap = JSON.parse(JSON.stringify(solved));
  // (items already in solved; we're just generating content from existing data)

  // 3. Assemble tree entries
  const files = {};
  for (const item of batch) {
    const entry = snap[item.slug];
    if (!entry) continue;
    const folder = folderOf(entry, layout);
    files[`${folder}/README.md`]          = problemReadme(entry);
    files[`${folder}/solution.${item.ext}`] = withNewline(item.code);
  }
  files['README.md'] = rootReadme(snap);

  const treeEntries = Object.entries(files).map(([path, content]) => ({
    path, mode: '100644', type: 'blob', content,
  }));

  // 4. Create tree, commit, update ref — all atomic
  const tree = await ghFetch(s, '/git/trees', {
    method: 'POST',
    body:   JSON.stringify({ base_tree: baseTree, tree: treeEntries }),
  });
  if (tree.sha === baseTree) return { committed: false };   // tree unchanged (dedup)

  const message = batch.length === 1
    ? `[migrate] Add ${batch[0].id}. ${batch[0].title} (${batch[0].langName})`
    : `[migrate] Import ${batch.length} LeetCode solutions`;

  const commit = await ghFetch(s, '/git/commits', {
    method: 'POST',
    body:   JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
  });
  await ghFetch(s, `/git/refs/heads/${encodeURIComponent(s.branch)}`, {
    method: 'PATCH',
    body:   JSON.stringify({ sha: commit.sha }),
  });
  return { committed: true, sha: commit.sha };
}

// ─── Full import orchestrator ─────────────────────────────────────────────────

/**
 * Drive the full migration: split missingItems into BATCH_SIZE chunks,
 * commit each atomically, report progress via onProgress(pct).
 *
 * @param {object}   settings
 * @param {object}   solved
 * @param {object[]} missingItems  - from migrateScan()
 * @param {string}   layout        - 'slug' | 'leethub'
 * @param {Function} [onProgress]  - called with 0–100
 * @returns {{ committed: number, skipped: number }}
 */
async function migrateImport(settings, solved, missingItems, layout = 'slug', onProgress) {
  let committed = 0;
  let skipped   = 0;
  const total   = missingItems.length;

  for (let i = 0; i < missingItems.length; i += BATCH_SIZE) {
    const batch  = missingItems.slice(i, i + BATCH_SIZE);
    const result = await commitBatch(settings, solved, batch, layout);
    if (result.committed) committed += batch.length;
    else                  skipped  += batch.length;

    if (onProgress) {
      onProgress(Math.round(((i + batch.length) / total) * 100));
    }

    // Courteous pacing between batches
    if (i + BATCH_SIZE < missingItems.length) {
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  return { committed, skipped };
}

// ─── Message-handler registration (extension context) ────────────────────────

(function registerHandlers() {
  const _api = typeof browser !== 'undefined' ? browser
             : typeof chrome  !== 'undefined' ? chrome
             : null;
  if (!_api) return;   // Node.js / offline test

  _api.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.type === 'migrateScan') {
      (async () => {
        try {
          // Retrieve solved store from extension storage
          const st = await _api.storage.local.get({ solved: {} });
          const result = await migrateScan(msg.settings, st.solved);
          sendResponse(result);
        } catch (e) {
          sendResponse({ error: e.message });
        }
      })();
      return true;  // keep channel open for async sendResponse
    }

    if (msg.type === 'migrateImport') {
      (async () => {
        try {
          const st = await _api.storage.local.get({ solved: {} });
          const result = await migrateImport(
            msg.settings,
            st.solved,
            msg.result.missingItems,
            msg.layout || 'slug'
          );
          sendResponse(result);
        } catch (e) {
          sendResponse({ error: e.message });
        }
      })();
      return true;
    }
  });
})();

// ─── Node.js export (for unit tests / CLI) ───────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = {
    fetchRepoIndex,
    migrateScan,
    migrateImport,
    commitBatch,
    folderOf,
    problemReadme,
    rootReadme,
    ghFetch,
  };
}
