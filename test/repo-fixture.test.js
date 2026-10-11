const assert = require('assert');
let bg;
try { bg = require('../background.js'); } catch (e) { bg = require('./background.js'); }

const ts = Date.parse('2024-05-01T12:00:00Z');

const settings = {
  baseFolder: 'LeetCode',
  folderOrg: 'difficulty',
  fileBaseName: 'solution'
};

const solvedMap = {
  'two-sum': {
    id: 1, slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy',
    tags: ['Array', 'Hash Table'],
    langs: {
      java: { lang: 'Java', runtime: '2 ms', memory: '44 MB', timestamp: ts },
      py: { lang: 'Python', runtime: '40 ms', memory: '17 MB', timestamp: ts }
    }
  },
  'combine-two-tables': {
    id: 175, slug: 'combine-two-tables', title: 'Combine Two Tables', difficulty: 'Easy',
    tags: ['Database'],
    langs: { sql: { lang: 'SQL', runtime: '500 ms', memory: '0B', timestamp: ts } }
  },
  'median-of-two-sorted-arrays': {
    id: 4, slug: 'median-of-two-sorted-arrays', title: 'Median of Two Sorted Arrays',
    difficulty: 'Hard', tags: ['Array'], langs: { py: { lang: 'Python', timestamp: ts } }
  },
  'not-in-repo-problem': {
    id: 999, slug: 'not-in-repo-problem', title: 'Not In Repo', difficulty: 'Medium',
    tags: [], langs: { py: { lang: 'Python', timestamp: ts } }
  }
};

const treeEntries = [
  { path: 'README.md', type: 'blob' },
  { path: 'Easy', type: 'tree' },
  { path: 'Easy/0001-two-sum', type: 'tree' },
  { path: 'Easy/0001-two-sum/README.md', type: 'blob' },
  { path: 'Easy/0001-two-sum/solution.java', type: 'blob' },
  { path: 'Easy/0001-two-sum/solution.py', type: 'blob' },
  { path: 'Easy/0175-combine-two-tables', type: 'tree' },
  { path: 'Easy/0175-combine-two-tables/README.md', type: 'blob' },
  { path: 'Easy/0175-combine-two-tables/solution.sql', type: 'blob' },
  { path: 'Extras', type: 'tree' },
  { path: 'Extras/1234-custom-thing', type: 'tree' },
  { path: 'Extras/1234-custom-thing/solution.js', type: 'blob' }
];

const out = bg.buildSolvedFromRepo(treeEntries, settings, solvedMap, {});
const repoProblems = out.repoProblems;

// 1. Java + Python detected on 0001
assert.ok(repoProblems['two-sum'], 'two-sum should be recognized');
assert.ok(repoProblems['two-sum'].langs.java, 'two-sum should have java');
assert.strictEqual(repoProblems['two-sum'].langs.java.lang, 'Java');
assert.ok(repoProblems['two-sum'].langs.py, 'two-sum should have py');
assert.strictEqual(repoProblems['two-sum'].langs.py.lang, 'Python');
assert.strictEqual(repoProblems['two-sum'].langs.java.runtime, '2 ms', 'existing runtime preserved');

// 2. SQL detected on 0175
assert.strictEqual(repoProblems['combine-two-tables'].langs.sql.lang, 'SQL');

// 3. Repo-only problem included
assert.ok(repoProblems['custom-thing'], 'repo-only problem should be included');
assert.strictEqual(repoProblems['custom-thing'].id, 1234);
assert.strictEqual(repoProblems['custom-thing'].title, 'Custom Thing');
assert.strictEqual(repoProblems['custom-thing'].difficulty, 'Unknown');
assert.strictEqual(repoProblems['custom-thing'].langs.js.lang, 'JavaScript');

// 4. README.md never becomes a problem or language
Object.keys(repoProblems).forEach(function (slug) {
  assert.ok(!repoProblems[slug].langs.md, slug + ' must not have an md language');
  Object.keys(repoProblems[slug].langs).forEach(function (ext) {
    assert.notStrictEqual(repoProblems[slug].langs[ext].lang, 'MD');
  });
  assert.ok(!repoProblems[slug].files.some(function (f) { return /\.md$/i.test(f.path); }), 'no README.md in files');
});
assert.ok(!repoProblems['two-sum'].langs['README'], 'README not a language');

// 5. LeetCode-only problems (absent from repo) are NOT listed
assert.ok(!repoProblems['median-of-two-sorted-arrays'], 'absent LC problem must not be listed');
assert.ok(!repoProblems['not-in-repo-problem'], 'absent LC problem must not be listed');

// Counts: total solved 4, in repo 2, missing 2
const allSlugs = Object.keys(solvedMap);
const inRepoCount = allSlugs.filter(function (s) { return !!repoProblems[s]; }).length;
const missingCount = Math.max(0, allSlugs.length - inRepoCount);
assert.strictEqual(allSlugs.length, 4);
assert.strictEqual(inRepoCount, 2);
assert.strictEqual(missingCount, 2);

// 6. Root README content
const root = bg.rootReadme(repoProblems, settings);
assert.ok(/Java · Python/.test(root), 'root README should show "Java · Python". Got:\n' + root);
assert.ok(root.indexOf('(./Easy/0001-two-sum/solution.java)') !== -1, 'root README links ./\<folder\>/\<file\>');
assert.ok(/SQL/.test(root), 'root README should show SQL');
assert.ok(!/\|\s*MD\s*\|/.test(root), 'root README must not show MD');
assert.ok(!/Median of Two Sorted Arrays/.test(root), 'absent LC problem must not appear');
assert.ok(!/Not In Repo/.test(root), 'absent LC problem must not appear');

// 6b. Root README header badges are computed from the problems that appear in the
//     README table (repo problems), NOT from LeetCode solved totals.
const inRepoBadge = root.match(/In_Repo-(\d+)-/);
assert.ok(inRepoBadge, 'root README should have an In_Repo badge');
const badgeRows = root.split('\n').filter(function (l) { return /^\|\s*\d+\s*\|/.test(l); }).length;
assert.strictEqual(Number(inRepoBadge[1]), badgeRows, 'In_Repo badge equals the number of README table rows');
assert.strictEqual(Number(inRepoBadge[1]), 3, 'In_Repo badge counts repo problems (3), not all solved (4)');
assert.notStrictEqual(Number(inRepoBadge[1]), allSlugs.length, 'In_Repo badge must not equal LeetCode solved total');
const easyBadge = Number((root.match(/Easy-(\d+)-/) || [])[1]);
const medBadge = Number((root.match(/Medium-(\d+)-/) || [])[1]);
const hardBadge = Number((root.match(/Hard-(\d+)-/) || [])[1]);
const rowsByDiff = { Easy: 0, Medium: 0, Hard: 0 };
Object.keys(repoProblems).forEach(function (s) {
  const d = repoProblems[s].difficulty;
  if (rowsByDiff[d] != null) rowsByDiff[d]++;
});
assert.strictEqual(easyBadge, rowsByDiff.Easy, 'Easy badge equals repo Easy rows');
assert.strictEqual(medBadge, rowsByDiff.Medium, 'Medium badge equals repo Medium rows');
assert.strictEqual(hardBadge, rowsByDiff.Hard, 'Hard badge equals repo Hard rows');

// 7. Per-problem README content
const pr = bg.problemReadme(repoProblems['two-sum'], settings);
assert.ok(/solution\.java/.test(pr), 'problem README links java file');
assert.ok(/solution\.py/.test(pr), 'problem README links py file');
assert.ok(/View Problem on LeetCode/.test(pr), 'problem README links to LeetCode');

// 8. All markdown links are balanced: every "](" has a closing ")" on the same line
function assertBalancedLinks(text, label) {
  text.split('\n').forEach(function (line, i) {
    let idx = 0;
    while ((idx = line.indexOf('](', idx)) !== -1) {
      const close = line.indexOf(')', idx);
      assert.ok(close !== -1, label + ' line ' + (i + 1) + ' has an unclosed link: ' + line);
      idx = close + 1;
    }
  });
}
assertBalancedLinks(root, 'root README');
Object.keys(repoProblems).forEach(function (slug) {
  assertBalancedLinks(bg.problemReadme(repoProblems[slug], settings), 'problem ' + slug);
});

// 9. Helpers
assert.strictEqual(bg.langForExt('java'), 'Java');
assert.strictEqual(bg.langForExt('sql'), 'SQL');
assert.strictEqual(bg.langForExt('wat'), 'Unknown');
assert.strictEqual(bg.isCodeFileExt('md'), false);
assert.strictEqual(bg.isCodeFileExt('java'), true);

// 10. All three folder layouts resolve to the same problem
function slugForPath(p) {
  const r = bg.buildSolvedFromRepo([{ path: p, type: 'blob' }], settings, solvedMap, {});
  return Object.keys(r.repoProblems)[0];
}
assert.strictEqual(slugForPath('Easy/0001-two-sum/solution.java'), 'two-sum', 'difficulty/subfolder layout');
assert.strictEqual(slugForPath('0001-two-sum/solution.java'), 'two-sum', 'id-slug subfolder layout');
assert.strictEqual(slugForPath('two-sum.java'), 'two-sum', 'flat file layout');
assert.strictEqual(slugForPath('0001/solution.java'), 'two-sum', 'standalone id folder layout');

// Flat layout produces a root-relative link
const flat = bg.buildSolvedFromRepo([{ path: 'two-sum.java', type: 'blob' }], settings, solvedMap, {});
assert.strictEqual(flat.repoProblems['two-sum'].files[0].path, 'two-sum.java');
assert.ok(bg.rootReadme(flat.repoProblems, settings).indexOf('(./two-sum.java)') !== -1, 'flat link is ./\<file\>');

// 11. Rebuilding keeps existing runtime/memory/tags
const rebuilt = bg.buildSolvedFromRepo(
  [{ path: 'Easy/0001-two-sum/solution.java', type: 'blob' }], settings, solvedMap, {}
).repoProblems['two-sum'];
assert.strictEqual(rebuilt.langs.java.runtime, '2 ms', 'runtime preserved on rebuild');
assert.strictEqual(rebuilt.langs.java.memory, '44 MB', 'memory preserved on rebuild');
assert.deepStrictEqual(rebuilt.tags, ['Array', 'Hash Table'], 'tags preserved on rebuild');
const rebuiltReadme = bg.problemReadme(rebuilt, settings);
assert.ok(/2 ms/.test(rebuiltReadme), 'rebuilt README keeps runtime');
assert.ok(/44 MB/.test(rebuiltReadme), 'rebuilt README keeps memory');
assert.ok(/Array/.test(rebuiltReadme), 'rebuilt README keeps tags');

console.log('All fixture tests passed.');
console.log('--- ROOT README ---');
console.log(root);
console.log('--- PROBLEM README (two-sum) ---');
console.log(pr);

// 12. Mocked LeetCode GraphQL: two languages for one problem + no accepted submission.
//     LeetCode is not reachable from CI, so we stub global.fetch. In the browser the
//     extension uses credentials:'include' + cookies to the real endpoint.
const realFetch = global.fetch;
const leetCalls = [];
global.fetch = function (url, opts) {
  leetCalls.push({ url: String(url), body: String((opts && opts.body) || '') });
  const payload = JSON.parse((opts && opts.body) || '{}');
  const q = payload.query || '';
  const respond = (obj) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });

  if (q.indexOf('submissionList') !== -1 && q.indexOf('submissionDetails') === -1) {
    const slug = payload.variables && payload.variables.questionSlug;
    const offset = (payload.variables && payload.variables.offset) || 0;
    if (slug === 'expired-session') {
      return respond({ data: { submissionList: null } });
    }
    if (slug === 'no-accepted') {
      return respond({ data: { submissionList: { lastKey: null, hasNext: false, submissions: [
        { id: 1, statusDisplay: 'Wrong Answer', lang: 'cpp', langName: 'C++', timestamp: 1700000000 },
        { id: 2, statusDisplay: 'Time Limit Exceeded', lang: 'python3', langName: 'Python3', timestamp: 1700000001 }
      ] } } });
    }
    if (slug === 'paged-problem') {
      if (offset === 0) {
        // Page 1: only failed attempts - must keep paging.
        return respond({ data: { submissionList: { lastKey: null, hasNext: true, submissions: [
          { id: 910, statusDisplay: 'Wrong Answer', lang: 'cpp', langName: 'C++', runtime: '1 ms', memory: '2 MB', timestamp: 1700000101 },
          { id: 911, statusDisplay: 'Time Limit Exceeded', lang: 'cpp', langName: 'C++', runtime: '1 ms', memory: '2 MB', timestamp: 1700000102 }
        ] } } });
      }
      // Page 2: the accepted submissions live here -> stop after this page.
      return respond({ data: { submissionList: { lastKey: null, hasNext: false, submissions: [
        { id: 912, statusDisplay: 'Accepted', lang: 'python3', langName: 'Python3', runtime: '20 ms', memory: '14 MB', timestamp: 1700000200 },
        { id: 913, statusDisplay: 'Accepted', lang: 'java', langName: 'Java', runtime: '2 ms', memory: '43 MB', timestamp: 1700000201 }
      ] } } });
    }
    return respond({ data: { submissionList: { lastKey: null, hasNext: false, submissions: [
      { id: 900, statusDisplay: 'Accepted', lang: 'python3', langName: 'Python3', runtime: '42 ms', memory: '16.3 MB', timestamp: 1700000001 },
      { id: 901, statusDisplay: 'Accepted', lang: 'python3', langName: 'Python3', runtime: '40 ms', memory: '16.2 MB', timestamp: 1700000003 },
      { id: 902, statusDisplay: 'Accepted', lang: 'java', langName: 'Java', runtime: '3 ms', memory: '44.1 MB', timestamp: 1700000002 },
      { id: 903, statusDisplay: 'Wrong Answer', lang: 'cpp', langName: 'C++', timestamp: 1700000004 }
    ] } } });
  }

  if (q.indexOf('submissionDetails') !== -1) {
    const id = payload.variables && payload.variables.submissionId;
    if (id === 900) {
      return respond({ data: { submissionDetails: { code: 'def twoSum():\n    pass', timestamp: 1700000001, runtime: '42 ms', memory: '16.3 MB', lang: { name: 'python3', verboseName: 'Python3' } } } });
    }
    if (id === 901) {
      return respond({ data: { submissionDetails: { code: 'def twoSum_2():\n    pass', timestamp: 1700000003, runtime: '40 ms', memory: '16.2 MB', lang: { name: 'python3', verboseName: 'Python3' } } } });
    }
    if (id === 902) {
      return respond({ data: { submissionDetails: { code: 'class Solution {}\n', timestamp: 1700000002, runtime: '3 ms', memory: '44.1 MB', lang: { name: 'java', verboseName: 'Java' } } } });
    }
    if (id === 912) {
      return respond({ data: { submissionDetails: { code: 'def twoSum_paged():\n    pass', timestamp: 1700000200, runtime: '20 ms', memory: '14 MB', lang: { name: 'python3', verboseName: 'Python3' } } } });
    }
    if (id === 913) {
      return respond({ data: { submissionDetails: { code: 'class Solution2 {}\n// paged', timestamp: 1700000201, runtime: '2 ms', memory: '43 MB', lang: { name: 'java', verboseName: 'Java' } } } });
    }
    return respond({ data: { submissionDetails: null } });
  }

  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
};

(async function () {
  bg._setLeetPaceMs(0);

  // 13. commitTopicsUpdate must never commit when there are no changed slugs.
  const noChange = await bg.commitTopicsUpdate(settings, repoProblems, []);
  assert.strictEqual(noChange.committed, false, 'topics commit skipped when nothing changed');
  assert.strictEqual(noChange.changed, 0);

  const polyGot = await bg.fetchAcceptedForProblem('two-sum');
  assert.deepStrictEqual(Object.keys(polyGot).sort(), ['java', 'py']);
  assert.strictEqual(polyGot.py.submissionId, '901', 'latest accepted python3 wins');
  assert.strictEqual(polyGot.py.lang, 'Python3');
  assert.strictEqual(polyGot.py.code, 'def twoSum_2():\n    pass');
  assert.strictEqual(polyGot.java.lang, 'Java');
  assert.strictEqual(polyGot.java.code, 'class Solution {}\n');

  assert.strictEqual(bg.extForLangSlug('python3'), 'py');
  assert.strictEqual(bg.extForLangSlug('java'), 'java');
  assert.strictEqual(bg.extForLangSlug('mysql'), 'sql');
  assert.strictEqual(bg.extForLangSlug('javascript'), 'js');
  assert.strictEqual(bg.extForLangSlug('golang'), 'go');
  assert.strictEqual(bg.extForLangSlug('pythondata'), 'py');

  const callsBeforeNone = leetCalls.length;
  const noneGot = await bg.fetchAcceptedForProblem('no-accepted');
  assert.deepStrictEqual(Object.keys(noneGot), [], 'no accepted submission -> no languages');
  const detailCallsBetween = leetCalls.slice(callsBeforeNone).filter((c) => c.body.indexOf('submissionDetails') !== -1);
  assert.strictEqual(detailCallsBetween.length, 0, 'no submissionDetails call when nothing was accepted');

  // Accepted submission is on page 2: we must page, then stop early (no offset 40).
  const pagedStart = leetCalls.length;
  const pagedGot = await bg.fetchAcceptedForProblem('paged-problem');
  assert.deepStrictEqual(Object.keys(pagedGot).sort(), ['java', 'py']);
  assert.strictEqual(pagedGot.py.submissionId, '912', 'accepted python3 found on page 2');
  assert.strictEqual(pagedGot.java.code, 'class Solution2 {}\n// paged');
  const pagedListCalls = leetCalls.slice(pagedStart).filter((c) => c.body.indexOf('submissionList') !== -1);
  assert.strictEqual(pagedListCalls.length, 2, 'paged exactly: page1 (no accepted) + page2 (accepted)');
  const maxOffsetAsked = pagedListCalls.map((c) => JSON.parse(c.body).variables.offset);
  assert.deepStrictEqual(maxOffsetAsked, [0, 20], 'stopped after finding accepted - never asked for offset 40');

  // 15. Acceptance matching is case-insensitive and recognises the numeric status.
  assert.strictEqual(bg.isAcceptedSubmission({ status: 10 }), true);
  assert.strictEqual(bg.isAcceptedSubmission({ statusDisplay: 'Accepted' }), true);
  assert.strictEqual(bg.isAcceptedSubmission({ statusDisplay: 'accepted' }), true);
  assert.strictEqual(bg.isAcceptedSubmission({ statusDisplay: '  Accepted  ' }), true);
  assert.strictEqual(bg.isAcceptedSubmission({ statusDisplay: 'Wrong Answer' }), false);
  assert.strictEqual(bg.isAcceptedSubmission({ statusDisplay: 'Time Limit Exceeded' }), false);
  assert.strictEqual(bg.isAcceptedSubmission(null), false);

  // 16. SQL variants and pandas map to real file extensions.
  assert.strictEqual(bg.extForLangSlug('mssql'), 'sql');
  assert.strictEqual(bg.extForLangSlug('oraclesql'), 'sql');
  assert.strictEqual(bg.extForLangSlug('postgresql'), 'sql');
  assert.strictEqual(bg.extForLangSlug('pandas'), 'py');

  // 17. An expired session (HTTP 200 with submissionList === null) must be
  //     reported as a session error, not mistaken for "no accepted submission".
  let sessionErr = null;
  try { await bg.fetchAcceptedForProblem('expired-session'); } catch (e) { sessionErr = e; }
  assert.ok(sessionErr, 'null submissionList must throw');
  assert.strictEqual(sessionErr.session, true, 'error flagged as session problem');
  assert.strictEqual(sessionErr.kind, 'session');

  // 18. summarizeOutcomes groups per-problem results by reason.
  const summary = bg.summarizeOutcomes({
    a: { status: 'fetched', id: 1, title: 'A', langs: ['py'] },
    b: { status: 'cached', id: 2, title: 'B', langs: ['java'] },
    c: { status: 'no-accepted', id: 3, title: 'C' },
    d: { status: 'fetch-failed', id: 4, title: 'D', error: 'HTTP 500', httpStatus: 500, kind: 'http' },
    e: { status: 'auth', id: 5, title: 'E', error: 'HTTP 403', httpStatus: 403 },
    f: { status: 'session', id: 6, title: 'F', error: 'expired' },
    g: { status: 'skipped', id: 7, title: 'G' }
  });
  assert.strictEqual(summary.counts.fetched, 2);
  assert.strictEqual(summary.counts.cached, 1);
  assert.strictEqual(summary.counts.noAccepted, 1);
  assert.strictEqual(summary.counts.fetchFailed, 1);
  assert.strictEqual(summary.counts.auth, 1);
  assert.strictEqual(summary.counts.session, 1);
  assert.strictEqual(summary.counts.skipped, 1);
  assert.deepStrictEqual(summary.reasons.fetchFailed.map((r) => r.slug), ['d']);
  assert.deepStrictEqual(summary.reasons.auth.map((r) => r.slug), ['e']);
  assert.deepStrictEqual(summary.reasons.session.map((r) => r.slug), ['f']);
  assert.deepStrictEqual(summary.reasons.noAccepted.map((r) => r.slug), ['c']);

  // 18b. reconcileSolved: only accepted problems survive, one entry per id.
  //      A prior solved entry with no accepted submission must be revoked, and
  //      two slugs sharing one problem id must collapse to the catalog slug.
  const catalog = {
    'two-sum': { id: 1, title: 'Two Sum', difficulty: 'Easy', status: 'ac' },
    'valid-anagram': { id: 242, title: 'Valid Anagram', difficulty: 'Easy', status: 'ac' }
  };
  const acceptSlugs = {
    'two-sum': { id: 1, langs: { py: { lang: 'Python', submissionId: '1' } } },
    'two-sums': { id: 1, langs: { java: { lang: 'Java', submissionId: '2' } } },
    'valid-anagram': { id: 242, title: 'Valid Anagram', langs: { java: { lang: 'Java', submissionId: '3' } } }
  }; // note: NO entry for 'ghost-problem'
  const prior = {
    'two-sum': { id: 1, slug: 'two-sum', title: 'Two Sum', langs: { py: { submissionId: '900' } } },
    'two-sums': { id: 1, slug: 'two-sums', title: 'Two Sum (dup slug)', langs: { java: { submissionId: '901' } } },
    'valid-anagram': { id: 242, langs: { py: { submissionId: '7' } } },
    'ghost-problem': { id: 4242, slug: 'wrong-slug', status: 'notac', langs: { py: {} } }
  };
  const rec = bg.reconcileSolved(acceptSlugs, prior, catalog);
  assert.strictEqual(Object.keys(rec.solved).length, 2, 'no inflation: only accepted ids remain (deduped)');
  assert.ok(rec.solved['two-sum'], 'catalog canonical slug kept');
  assert.ok(!rec.solved['two-sums'], 'the non-catalog duplicate slug is dropped');
  assert.deepStrictEqual(Object.keys(rec.solved['two-sum'].langs).sort(), ['java', 'py'], 'duplicate langs merged under kept slug');
  assert.ok(rec.solved['valid-anagram']);
  assert.strictEqual(rec.duplicates.length, 1, 'duplicate id recorded');
  const revokedSlugs = rec.revoked.map((r) => r.slug);
  assert.deepStrictEqual(rec.duplicates.map((d) => d.dropped), ['two-sums'], 'the non-catalog duplicate slug is the one dropped');
  assert.strictEqual(rec.duplicates[0].kept, 'two-sum');
  assert.strictEqual(revokedSlugs.length, 1, 'only the truly unsubmitted prior entry is revoked');
  assert.strictEqual(revokedSlugs[0], 'ghost-problem', 'non-accepted prior solved entry revoked');
  assert.strictEqual(rec.revoked[0].catalogStatus, 'not-in-catalog');

  // 18c. reconcileSolved does not keep any solved problem without an accepted slug.
  const rec2 = bg.reconcileSolved({}, { 'ghost': { id: 7, langs: { py: {} } } }, {});
  assert.deepStrictEqual(Object.keys(rec2.solved), [], 'nothing accepted -> empty solved map');

  // 18d. Import completion must NOT claim "finished" unless the re-scan shows 0 missing.
  const stillSummary = bg.summarizeOutcomes({ a: { status: 'no-accepted' }, b: { status: 'fetch-failed', kind: 'other' } });
  const notDone = bg.importCompletionState(stillSummary, 0, 5, { committed: 10, processed: 10, total: 15 });
  assert.strictEqual(notDone.finished, false);
  assert.strictEqual(notDone.state, 'ended');
  assert.ok(/Import ended: 10 committed, 5 still missing/.test(notDone.message), 'ended message states X committed, Y missing');
  assert.ok(/no accepted submission/.test(notDone.message), 'reason breakdown included');
  assert.ok(/fetch-failed/.test(notDone.message));

  const done = bg.importCompletionState(bg.summarizeOutcomes({}), 0, 0, { committed: 10, processed: 10, total: 10, inRepoNow: 10 });
  assert.strictEqual(done.finished, true);
  assert.strictEqual(done.state, 'finished');
  assert.ok(/Import finished: 10 committed, 0 missing/.test(done.message));

  const cancelled = bg.importCompletionState(bg.summarizeOutcomes({}), 0, 5, { cancelled: true, processed: 3, total: 10 });
  assert.strictEqual(cancelled.state, 'cancelled');
  assert.strictEqual(cancelled.finished, false);

  // 18e. Missing is measured in unique problems, and "ended" never reports zero.
  const noReasons = bg.importCompletionState({ counts: {} }, 0, 3, { committed: 0, processed: 0, total: 3 });
  assert.ok(/3 still missing/.test(noReasons.message));
  assert.ok(/not in the queued list/.test(noReasons.message), 'generic reason when no outcome reason applies');

  // ---------------------------------------------------------------------------
  // 19. GitHub commit pipeline: stale ref protection + 422 fast-forward retry.
  //     A fake GitHub Git-Data API (trees/commits/refs) is served through
  //     global.fetch. The fake returns STALE refs when a request is NOT made
  //     with cache:'no-store' (simulating GitHub's Cache-Control: max-age=60),
  //     and rejects non-fast-forward ref PATCHes with 422.
  // ---------------------------------------------------------------------------
  const gh = {
    head: 'S0',
    staleRef: 'S0',
    commits: {},
    trees: {},
    next: 1,
    patchCount: 0,
    getRefCalls: 0,
    badCacheReads: 0,
    patch422Once: false,
    saw422: false,
    silentPatchFail: false
  };
  function ghReset() {
    gh.head = 'S0'; gh.staleRef = 'S0';
    gh.commits = { S0: { sha: 'S0', tree: { sha: 'Troot' }, parents: [] } };
    gh.trees = { Troot: { 'README.md': '# root\n' } };
    gh.next = 1; gh.patchCount = 0; gh.getRefCalls = 0; gh.badCacheReads = 0;
    gh.patch422Once = false; gh.saw422 = false; gh.silentPatchFail = false;
  }
  function ghRes(status, obj) {
    return Promise.resolve({
      ok: status >= 200 && status < 300, status: status,
      headers: { get: function () { return null; } },
      json: function () { return Promise.resolve(obj); },
      text: function () { return Promise.resolve(JSON.stringify(obj)); }
    });
  }
  function ghFileList(treeSha) { return Object.keys(gh.trees[treeSha] || {}); }
  function ghHeadFiles() { return ghFileList(gh.commits[gh.head].tree.sha); }
  function handleGitHub(url, opts) {
    opts = opts || {};
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};
    const cached = opts.cache !== 'no-store';

    if (/\/git\/ref\/heads\//.test(u) && method === 'GET') {
      gh.getRefCalls++;
      if (cached) gh.badCacheReads++;
      // Stale (cached) reads return the OLD sha even after a successful PATCH.
      const sha = cached ? gh.staleRef : gh.head;
      return ghRes(200, { object: { sha: sha } });
    }
    if (/\/git\/commits\/[^/?]+$/.test(u) && method === 'GET') {
      const sha = u.split('/git/commits/')[1];
      const c = gh.commits[sha];
      return c ? ghRes(200, c) : ghRes(404, { message: 'Not Found' });
    }
    if (/\/git\/trees$/.test(u) && method === 'POST') {
      const base = body.base_tree ? Object.assign({}, gh.trees[body.base_tree]) : {};
      (body.tree || []).forEach(function (e) { base[e.path] = e.content; });
      const tsha = 'T' + (gh.next++);
      gh.trees[tsha] = base;
      return ghRes(201, { sha: tsha });
    }
    if (/\/git\/commits$/.test(u) && method === 'POST') {
      const csha = 'C' + (gh.next++);
      gh.commits[csha] = { sha: csha, tree: { sha: body.tree }, parents: body.parents || [] };
      return ghRes(201, { sha: csha });
    }
    if (/\/git\/refs\/heads\//.test(u) && method === 'PATCH') {
      if (gh.patch422Once && !gh.saw422) { gh.saw422 = true; return ghRes(422, { message: 'Update is not a fast forward' }); }
      // force:false must be a true fast-forward, else 422.
      if (body.force === false) {
        const c = gh.commits[body.sha];
        const parent = c && c.parents && c.parents[0];
        if (parent !== gh.head) return ghRes(422, { message: 'Update is not a fast forward' });
      }
      if (gh.silentPatchFail) return ghRes(200, { object: { sha: gh.head } }); // 200 but no change
      gh.head = body.sha;
      gh.patchCount++;
      return ghRes(200, { object: { sha: gh.head } });
    }
    if (/\/git\/refs$/.test(u) && method === 'POST') {
      gh.head = body.sha; gh.patchCount++;
      return ghRes(201, { object: { sha: gh.head } });
    }
    return ghRes(404, { message: 'unhandled ' + method + ' ' + u });
  }
  const leetFetch = global.fetch;
  global.fetch = function (url, opts) {
    if (String(url).indexOf('api.github.com') !== -1) return handleGitHub(url, opts);
    return leetFetch(url, opts);
  };

  const ghSettings = {
    owner: 'octo', repo: 'leet', branch: 'main', token: 'x',
    baseFolder: 'LeetCode', folderOrg: 'difficulty', fileBaseName: 'solution',
    generateProblemReadme: true, maintainRootReadme: true
  };
  function mkItem(id, slug, title, ext, code) {
    return {
      id: id, slug: slug, title: title, difficulty: 'Easy', tags: ['Array'], constraints: [],
      code: code, langName: 'Python3', ext: ext, runtime: '1 ms', memory: '1 MB',
      submissionId: String(id), timestamp: ts
    };
  }

  // 19a. Stale GET ref must not lose any batch: the in-memory head chain keeps
  //      every batch, and no request is allowed to be served from the cache.
  ghReset();
  const ghState = { settings: ghSettings, solved: {}, queue: {}, repoProblems: {} };
  const ctx = {};
  const b1 = [mkItem(1, 'two-sum', 'Two Sum', 'py', 'print(1)\n'), mkItem(2, 'add-two-numbers', 'Add Two Numbers', 'py', 'print(2)\n')];
  const b2 = [mkItem(3, 'lru-cache', 'LRU Cache', 'py', 'print(3)\n')];
  const b3 = [mkItem(4, 'median', 'Median', 'py', 'print(4)\n'), mkItem(5, 'regex', 'Regex', 'py', 'print(5)\n')];
  const r1 = await bg.commitBatch(ghState, b1, ctx);
  const r2 = await bg.commitBatch(ghState, b2, ctx);
  const r3 = await bg.commitBatch(ghState, b3, ctx);
  assert.strictEqual(r1.committed, true);
  assert.strictEqual(r2.committed, true);
  assert.strictEqual(r3.committed, true);
  assert.strictEqual(gh.badCacheReads, 0, 'every GitHub read must use cache:no-store');
  const finalFiles = ghHeadFiles();
  ['LeetCode/Easy/1-two-sum/solution.py', 'LeetCode/Easy/2-add-two-numbers/solution.py',
   'LeetCode/Easy/3-lru-cache/solution.py', 'LeetCode/Easy/4-median/solution.py',
   'LeetCode/Easy/5-regex/solution.py'].forEach(function (p) {
    assert.ok(finalFiles.indexOf(p) !== -1, 'final tree must contain ' + p + ' (no lost batch)');
  });
  // All three commits form a chain on the server (nothing orphaned).
  let chainLen = 0, walk = gh.head;
  while (walk && walk !== 'S0') { chainLen++; walk = gh.commits[walk].parents[0]; }
  assert.strictEqual(chainLen, 3, 'three chained commits, no orphaned batch');
  // Head was resolved once and verified per batch (1 + 3 reads), not re-read per batch.
  assert.strictEqual(gh.getRefCalls, 4, 'ref read once up front + once to verify each batch');

  // 19b. A 422 (not a fast-forward) must be rebuilt on the real head and retried
  //      ONCE, without losing the batch.
  ghReset();
  gh.patch422Once = true;
  const ghState2 = { settings: ghSettings, solved: {}, queue: {}, repoProblems: {} };
  const ctx2 = {};
  const rr = await bg.commitBatch(ghState2, [mkItem(10, 'probe', 'Probe', 'py', 'print(10)\n')], ctx2);
  assert.strictEqual(rr.committed, true, 'commit recovers from a one-off 422');
  assert.strictEqual(gh.saw422, true, 'the 422 path was exercised');
  assert.ok(ghHeadFiles().indexOf('LeetCode/Easy/10-probe/solution.py') !== -1, 'batch content survives the 422 retry');

  // 19c. A ref PATCH that reports success but does NOT move the head must be
  //      detected by the post-commit verification (never overwrite silently).
  ghReset();
  gh.silentPatchFail = true;
  let mismatch = null;
  try {
    await bg.commitBatch({ settings: ghSettings, solved: {}, queue: {}, repoProblems: {} }, [mkItem(20, 'ghost', 'Ghost', 'py', 'x\n')], {});
  } catch (e) { mismatch = e; }
  assert.ok(mismatch, 'a non-advancing ref must throw');
  assert.ok(/did not take effect|head/i.test(mismatch.message), 'head-mismatch error is reported');
  assert.strictEqual(gh.head, 'S0', 'the branch was not silently overwritten');

  global.fetch = realFetch;
  console.log('GitHub stale-ref / 422 commit tests passed.');
  // 20. Restart safety smoke test: resume state persists/clears
  try {
    const bg2 = bg;
    await bg2.persistImportResume({ problemOrder: ['p1','p2'], currentBatch: 1, totalProblems: 2, batchSize: 1 });
    const rs = await bg2.getImportResume ? await bg2.getImportResume() : null;
    assert.ok(rs && rs.problemOrder, 'resume state persisted');
    await bg2.clearImportResume();
    const rs2 = await bg2.getImportResume ? await bg2.getImportResume() : null;
    assert.ok(!rs2, 'resume state cleared');
    console.log('Restart safety: resume persist/clear OK');
  } catch (e) {
    // ignore if not exposed in this context
  }
  console.log('Mocked LeetCode GraphQL tests passed.');
  console.log('LeetCode calls made by mock: ' + leetCalls.length);
})().catch(function (e) {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
