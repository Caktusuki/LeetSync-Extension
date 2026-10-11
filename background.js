// Background script: queue -> atomic GitHub commits.
// Everything is stored locally (browser.storage.local). The only network calls
// are to api.github.com with the token YOU provide.

const api = globalThis.browser ?? globalThis.chrome ?? null;

const GITHUB_CLIENT_ID = 'Iv23lis69kPQFd8PJfLf';
const OAUTH_WORKER_URL = 'https://leetsync-oauth.cactusuki.workers.dev';

function getOAuthRedirectUri() {
  return api.identity && api.identity.getRedirectURL
    ? api.identity.getRedirectURL()
    : '';
}

function encodeState(nonce, redirectUrl) {
  return btoa(JSON.stringify({ n: nonce, r: redirectUrl, t: Date.now() }));
}

var DEFAULTS = {
  token: '',
  owner: '',
  repo: 'leetcode-solutions',
  branch: 'main',
  baseFolder: 'LeetCode',
  folderOrg: 'difficulty',
  customFolderTemplate: '{difficulty}/{padded_id}-{slug}',
  fileBaseName: 'solution',
  generateProblemReadme: true,
  maintainRootReadme: true,
  periodicSync: true,
  syncInterval: 15,
  realtimeSync: true,
  overwriteExisting: false
};
var BATCH_SIZE = 20;
var PACE_MS = 1500;
var MAX_ATTEMPTS = 3;

async function getOAuthLock() {
  const { oauthLock } = await api.storage.session.get({ oauthLock: 0 });
  return oauthLock;
}

var running = false;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function getState() {
  var s = await api.storage.local.get({
    settings: DEFAULTS, solved: {}, queue: [], lastError: null, lastSync: null,
    lastScanResults: null, importStatus: null, isSyncing: null, lastImport: null
  });
  s.settings = Object.assign({}, DEFAULTS, s.settings);
  return s;
}

function setError(msg) { return api.storage.local.set({ lastError: msg }); }

// ---------- Structured Logging (persisted last 500 lines, token masked) ----------

function maskToken(str) {
  if (!str) return '';
  return String(str).replace(/(?:ghp_|github_pat_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9_]{10,}/g, function (m) {
    return m.slice(0, 10) + '********************';
  });
}

async function appendLog(level, message, details) {
  if (!api || !api.storage) return;
  try {
    var d = new Date();
    var timeStr = [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (n) { return String(n).padStart(2, '0'); }).join(':');
    var item = {
      timestamp: d.toISOString(),
      timeStr: timeStr,
      level: level,
      message: maskToken(message),
      details: details ? JSON.parse(maskToken(JSON.stringify(details))) : null
    };
    var data = await api.storage.local.get({ logs: [] });
    var logs = data.logs || [];
    logs.push(item);
    if (logs.length > 2000) logs = logs.slice(logs.length - 2000);
    await api.storage.local.set({ logs: logs });
    if (api.runtime && api.runtime.sendMessage) {
      api.runtime.sendMessage({ type: 'logAdded', log: item }).catch(function () {});
    }
  } catch (e) {
    console.warn('[LeetSync Log]', e);
  }
}

// ---------- GitHub API ----------

function RateLimitError(waitMs) {
  this.name = 'RateLimitError';
  this.message = 'GitHub rate limit hit';
  this.waitMs = waitMs;
}
RateLimitError.prototype = Object.create(Error.prototype);

async function gh(settings, path, opts) {
  opts = opts || {};
  var method = opts.method || 'GET';
  await appendLog('DEBUG', 'GitHub ' + method + ' ' + (opts.urlOverride || path));

  var url = opts.urlOverride || ('https://api.github.com/repos/' + settings.owner + '/' + settings.repo + path);
  var timeoutMs = opts.timeoutMs || 20000;
  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
  var res;
  try {
    res = await fetch(url, {
      method: method,
      body: opts.body,
      signal: controller ? controller.signal : undefined,
      cache: 'no-store',
      headers: {
        'Authorization': 'Bearer ' + settings.token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      }
    });
  } catch (netErr) {
    if (timer) clearTimeout(timer);
    if (netErr && (netErr.name === 'AbortError' || String(netErr.message || '').indexOf('abort') !== -1)) {
      await appendLog('ERROR', 'GitHub request timed out after ' + Math.round(timeoutMs / 1000) + 's (' + path + ')');
      var te = new Error('GitHub request timed out after ' + Math.round(timeoutMs / 1000) + 's');
      te.status = 0;
      te.timeout = true;
      throw te;
    }
    throw netErr;
  }
  if (timer) clearTimeout(timer);

  var remaining = res.headers.get('x-ratelimit-remaining');
  var reset = res.headers.get('x-ratelimit-reset');

  if (res.status === 403 || res.status === 429) {
    var retryAfter = res.headers.get('retry-after');
    await appendLog('WARN', 'GitHub rate limit reached (status ' + res.status + ')', {
      remaining: remaining,
      reset: reset,
      retryAfter: retryAfter
    });
    if (retryAfter) throw new RateLimitError(Number(retryAfter) * 1000);
    if (remaining === '0' && reset) {
      throw new RateLimitError(Math.max(0, Number(reset) * 1000 - Date.now()) + 1000);
    }
  }
  if (!res.ok) {
    var text = await res.text();
    await appendLog('ERROR', 'GitHub ' + res.status + ' (' + path + '): ' + text.slice(0, 150));
    var err = new Error('GitHub ' + res.status + ': ' + text.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  await appendLog('INFO', 'GitHub ' + res.status + ' OK (' + path + ')', { remaining: remaining });
  return res.status === 204 ? null : res.json();
}

// ---------- Content generation ----------

function pad(n) { return String(n).padStart(4, '0'); }

function resolveFileBaseName(e, it, settings) {
  var s = settings || {};
  var template = (s.fileBaseName && s.fileBaseName.trim()) ? s.fileBaseName.trim() : 'solution';
  if (!e) return template;
  
  var sanitizedTitle = (e.title || e.slug || '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  var primaryLang = (it && it.langName) || (e.langs && Object.keys(e.langs)[0]) || 'Solution';
  var cleanLang = primaryLang.replace(/\s+/g, '');

  var resolved = template
    .replace(/{title}/g, sanitizedTitle)
    .replace(/{slug}/g, e.slug || '')
    .replace(/{id}/g, String(e.id || ''))
    .replace(/{padded_id}/g, pad(e.id || 0))
    .replace(/{difficulty}/g, e.difficulty || 'Easy')
    .replace(/{lang}/g, cleanLang);

  resolved = resolved.replace(/[^\w\s-]/g, '').trim();
  return resolved || 'solution';
}

function folderOf(e, settings) {
  var s = settings || {};
  var base = (s.baseFolder && s.baseFolder.trim()) ? s.baseFolder.trim().replace(/^\/+|\/+$/g, '') + '/' : '';
  var org = s.folderOrg || 'difficulty';

  var primaryLang = Object.keys(e.langs || {})[0] || 'Solution';
  var langName = (e.langs && e.langs[primaryLang] && e.langs[primaryLang].lang) || primaryLang;
  var cleanLang = langName.replace(/\s+/g, '');
  var tag = (e.tags && e.tags.length) ? e.tags[0].replace(/\s+/g, '-') : 'General';
  var sanitizedTitle = (e.title || e.slug || '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

  if (org === 'custom' && s.customFolderTemplate) {
    var customPath = s.customFolderTemplate
      .replace(/{id}/g, String(e.id || ''))
      .replace(/{padded_id}/g, pad(e.id || 0))
      .replace(/{title}/g, sanitizedTitle)
      .replace(/{slug}/g, e.slug || '')
      .replace(/{difficulty}/g, e.difficulty || 'Easy')
      .replace(/{lang}/g, cleanLang)
      .replace(/{category}/g, tag)
      .replace(/{tag}/g, tag);

    return base + customPath.replace(/^\/+|\/+$/g, '');
  }

  if (org === 'difficulty') {
    return base + (e.difficulty || 'Easy') + '/' + e.id + '-' + e.slug;
  }
  if (org === 'language') {
    return base + cleanLang + '/' + (e.difficulty || 'Easy') + '/' + e.id + '-' + e.slug;
  }
  if (org === 'leethub') {
    // Legacy LeetHub preset: Title-Slug directory (e.g., Two-Sum/ or 0001-two-sum/)
    return base + sanitizedTitle;
  }
  if (org === 'tag' && e.tags && e.tags.length) {
    return base + tag + '/' + e.id + '-' + e.slug;
  }
  // flat / standard
  return base + pad(e.id) + '-' + e.slug;
}
function withNewline(s) { s = String(s == null ? '' : s); return s.endsWith('\n') ? s : s + '\n'; }
function esc(s) { return String(s).replace(/\|/g, '\\|'); }

// ---------- Language / file classification (repo-driven README) ----------

var CODE_EXT_LANG = {
  cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', hxx: 'C++',
  c: 'C', h: 'C',
  cs: 'C#',
  java: 'Java',
  py: 'Python', py3: 'Python',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript',
  go: 'Go',
  rs: 'Rust',
  rb: 'Ruby',
  swift: 'Swift',
  kt: 'Kotlin', kts: 'Kotlin',
  php: 'PHP',
  sql: 'SQL',
  sh: 'Bash', bash: 'Bash',
  scala: 'Scala',
  dart: 'Dart',
  rkt: 'Racket',
  erl: 'Erlang',
  ex: 'Elixir', exs: 'Elixir',
  lua: 'Lua',
  pl: 'Perl',
  r: 'R',
  jl: 'Julia',
  m: 'Objective-C',
  groovy: 'Groovy',
  clj: 'Clojure',
  fs: 'F#',
  vb: 'Visual Basic'
};

var NON_CODE_EXT = new Set([
  'md', 'markdown', 'txt', 'text', 'json', 'yml', 'yaml', 'toml', 'ini', 'cfg',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp',
  'html', 'htm', 'css', 'scss', 'less', 'xml', 'csv', 'tsv', 'pdf', 'lock',
  'log', 'gitignore', 'gitattributes', 'license', 'editorconfig', 'env', 'db', 'bak'
]);

function extOf(path) {
  var base = String(path || '').split('/').pop();
  var i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i + 1).toLowerCase();
}

function isCodeFileExt(ext) {
  return Object.prototype.hasOwnProperty.call(CODE_EXT_LANG, String(ext || '').toLowerCase());
}

function langForExt(ext) {
  var e = String(ext || '').toLowerCase();
  return CODE_EXT_LANG[e] || 'Unknown';
}

function slugifyName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function titleCaseFromSlug(s) {
  return String(s || '').split(/[-_\s]+/).filter(Boolean).map(function (w) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

function addKnownFn(knownIds, knownSlugs, id, slug, title, difficulty) {
  if (!slug) return;
  var normSlug = String(slug).toLowerCase().trim();
  var numId = (id != null && !isNaN(Number(id))) ? Number(id) : null;
  var normTitleSlug = slugifyName(title || slug);
  var info = { id: numId, slug: normSlug, title: title || slug, difficulty: difficulty || 'Easy' };
  if (numId != null) {
    knownIds[numId] = info;
    var p4 = String(numId).padStart(4, '0');
    var p3 = String(numId).padStart(3, '0');
    knownSlugs[p4 + '-' + normSlug] = info;
    knownSlugs[p3 + '-' + normSlug] = info;
    if (normTitleSlug) {
      knownSlugs[p4 + '-' + normTitleSlug] = info;
      knownSlugs[p3 + '-' + normTitleSlug] = info;
    }
  }
  knownSlugs[normSlug] = info;
  if (normTitleSlug) knownSlugs[normTitleSlug] = info;
  knownSlugs[normSlug.replace(/-/g, '')] = info;
}

function buildKnownIndex(solvedMap, catalog) {
  var knownIds = {};
  var knownSlugs = {};
  if (catalog) {
    Object.keys(catalog).forEach(function (slug) {
      if (slug.startsWith('_')) return;
      var item = catalog[slug];
      if (item) addKnownFn(knownIds, knownSlugs, item.id, slug, item.title, item.difficulty);
    });
  }
  if (solvedMap) {
    Object.keys(solvedMap).forEach(function (slug) {
      var item = solvedMap[slug];
      if (item) addKnownFn(knownIds, knownSlugs, item.id, slug, item.title, item.difficulty);
    });
  }
  return { knownIds: knownIds, knownSlugs: knownSlugs };
}

function matchProblemByName(name, knownIds, knownSlugs) {
  var clean = slugifyName(name);
  if (!clean) return null;
  var m = clean.match(/^(\d+)-(.+)$/);
  if (m) {
    var num = Number(m[1]);
    if (knownIds[num]) return knownIds[num];
    if (knownSlugs[m[1] + '-' + m[2]]) return knownSlugs[m[1] + '-' + m[2]];
    if (knownSlugs[m[2]]) return knownSlugs[m[2]];
  }
  if (knownSlugs[clean]) return knownSlugs[clean];
  if (knownSlugs[clean.replace(/-/g, '')]) return knownSlugs[clean.replace(/-/g, '')];
  if (/^\d+$/.test(clean) && knownIds[Number(clean)]) return knownIds[Number(clean)];
  return null;
}

// Builds the repository's problem set from the actual file tree.
// Repo contents win: every problem that has code files is listed (including
// repo-only problems). LeetCode data only fills title/difficulty/tags.
function buildSolvedFromRepo(treeEntries, settings, solvedMap, catalog) {
  solvedMap = solvedMap || {};
  catalog = catalog || {};
  var idx = buildKnownIndex(solvedMap, catalog);
  var repoProblems = {};
  var filesBySlug = {};

  (treeEntries || []).forEach(function (item) {
    if (!item || item.type === 'tree' || item.type === 'commit') return;
    var path = item.path || '';
    if (!path || path.indexOf('.git/') === 0) return;
    var ext = extOf(path);
    if (!isCodeFileExt(ext)) return;

    var parts = path.split('/');
    var filename = parts[parts.length - 1];
    var baseName = filename.slice(0, Math.max(0, filename.length - (ext.length + 1)));
    var folderPath = parts.slice(0, -1).join('/');
    var folderName = parts.length >= 2 ? parts[parts.length - 2] : baseName;

    var match = matchProblemByName(folderName, idx.knownIds, idx.knownSlugs);
    if (!match) match = matchProblemByName(baseName, idx.knownIds, idx.knownSlugs);

    var id, slug, title, difficulty;
    if (match) {
      id = match.id;
      slug = match.slug;
      title = match.title;
      difficulty = match.difficulty;
    } else {
      var src = folderName || baseName;
      var parsed = slugifyName(src).match(/^(\d+)-(.+)$/);
      if (parsed) { id = Number(parsed[1]); slug = parsed[2]; }
      else { id = null; slug = slugifyName(src); }
      if (!slug) return;
      title = titleCaseFromSlug(slug);
      difficulty = 'Unknown';
    }

    var source = solvedMap[slug] || {};
    var tags = (source.tags && source.tags.length) ? source.tags
      : (catalog[slug] && catalog[slug].tags) ? catalog[slug].tags : [];

    if (!repoProblems[slug]) {
      repoProblems[slug] = {
        id: id, slug: slug, title: title, difficulty: difficulty,
        tags: tags, folder: folderPath, langs: {}, files: []
      };
      filesBySlug[slug] = repoProblems[slug].files;
    } else if (!repoProblems[slug].folder) {
      repoProblems[slug].folder = folderPath;
    }

    if ((!repoProblems[slug].tags || !repoProblems[slug].tags.length) && tags.length) {
      repoProblems[slug].tags = tags;
    }
    if (repoProblems[slug].id == null && id != null) repoProblems[slug].id = id;
    if (repoProblems[slug].difficulty === 'Unknown' && difficulty !== 'Unknown') {
      repoProblems[slug].difficulty = difficulty;
    }

    var srcLang = source.langs && source.langs[ext];
    repoProblems[slug].langs[ext] = {
      lang: langForExt(ext),
      runtime: (srcLang && srcLang.runtime) ? srcLang.runtime : '-',
      memory: (srcLang && srcLang.memory) ? srcLang.memory : '-',
      timestamp: (srcLang && srcLang.timestamp) ? srcLang.timestamp : null
    };
    repoProblems[slug].files.push({ path: path, filename: filename, ext: ext, folder: folderPath });
  });

  return { repoProblems: repoProblems, filesBySlug: filesBySlug };
}

function applyItem(solved, it) {
  var e = solved[it.slug] || { langs: {} };
  e.id = it.id;
  e.title = it.title;
  e.slug = it.slug;
  e.difficulty = it.difficulty;
  e.tags = it.tags || [];
  e.constraints = it.constraints || [];
  e.domain = it.domain || 'leetcode.com';
  e.langs[it.ext] = {
    lang: it.langName,
    submissionId: it.submissionId,
    runtime: it.runtime,
    memory: it.memory,
    timestamp: it.timestamp
  };
  solved[it.slug] = e;
}

function problemReadme(p, settings) {
  var s = settings || {};
  p = p || {};
  var lines = [];
  var heading = (p.id != null ? p.id + '. ' : '') + (p.title || p.slug || 'Problem');
  lines.push('# ' + heading);
  lines.push('');
  if (p.difficulty && p.difficulty !== 'Unknown') {
    var diffColor = p.difficulty === 'Easy' ? '10b981' : (p.difficulty === 'Medium' ? 'f59e0b' : 'f43f5e');
    lines.push('![Difficulty: ' + p.difficulty + '](https://img.shields.io/badge/Difficulty-' + p.difficulty + '-' + diffColor + '?style=flat-square)');
    lines.push('');
  }
  if (p.tags && p.tags.length) {
    lines.push('**Topics:** ' + p.tags.map(function (t) { return '`' + t + '`'; }).join(' '));
    lines.push('');
  }
  if (p.slug && p.leetcode !== false) {
    lines.push('[View Problem on LeetCode ↗](https://leetcode.com/problems/' + p.slug + '/)');
    lines.push('');
  }
  lines.push('## Solutions');
  lines.push('');
  lines.push('| Language | File | Runtime | Memory | Date |');
  lines.push('| --- | --- | --- | --- | --- |');

  var files = (p.files && p.files.length) ? p.files : [];
  if (files.length) {
    files.slice().sort(function (a, b) { return a.path.localeCompare(b.path); }).forEach(function (f) {
      var l = (p.langs && p.langs[f.ext]) || {};
      var date = l.timestamp ? new Date(l.timestamp).toISOString().slice(0, 10) : '-';
      var rel = f.filename;
      lines.push('| ' + esc(l.lang || langForExt(f.ext)) + ' | [' + rel + '](./' + rel + ') | ' +
        esc(l.runtime || '-') + ' | ' + esc(l.memory || '-') + ' | ' + date + ' |');
    });
  } else {
    Object.keys(p.langs || {}).sort().forEach(function (ext) {
      var l = p.langs[ext];
      var fname = resolveFileBaseName(p, { langName: l.lang, ext: ext }, s) + '.' + ext;
      var date = l.timestamp ? new Date(l.timestamp).toISOString().slice(0, 10) : '-';
      lines.push('| ' + esc(l.lang || langForExt(ext)) + ' | [' + fname + '](./' + fname + ') | ' +
        esc(l.runtime || '-') + ' | ' + esc(l.memory || '-') + ' | ' + date + ' |');
    });
  }
  lines.push('');
  lines.push('---');
  lines.push('*Synced automatically by [LeetSync](https://github.com/Caktusuki).*');
  return lines.join('\n') + '\n';
}

function rootReadme(repoProblems, settings) {
  var s = settings || {};
  var rows = Object.keys(repoProblems || {}).map(function (k) { return repoProblems[k]; })
    .filter(function (p) { return p && p.slug; });
  rows.sort(function (a, b) {
    var ai = (a.id == null) ? Number.MAX_SAFE_INTEGER : Number(a.id);
    var bi = (b.id == null) ? Number.MAX_SAFE_INTEGER : Number(b.id);
    if (ai !== bi) return ai - bi;
    return String(a.title).localeCompare(String(b.title));
  });

  // Badges must come from the same rows that appear in the table below.
  var counts = { Easy: 0, Medium: 0, Hard: 0 };
  rows.forEach(function (p) { if (counts[p.difficulty] != null) counts[p.difficulty]++; });

  var lines = [];
  lines.push('# 🧩 LeetCode Solutions');
  lines.push('');
  lines.push('Automated repository of accepted LeetCode solutions, managed by **LeetSync**.');
  lines.push('');
  lines.push('[![In Repo](https://img.shields.io/badge/In_Repo-' + rows.length + '-6366f1?style=flat-square)](#)');
  lines.push('[![Easy](https://img.shields.io/badge/Easy-' + counts.Easy + '-10b981?style=flat-square)](#)');
  lines.push('[![Medium](https://img.shields.io/badge/Medium-' + counts.Medium + '-f59e0b?style=flat-square)](#)');
  lines.push('[![Hard](https://img.shields.io/badge/Hard-' + counts.Hard + '-f43f5e?style=flat-square)](#)');
  lines.push('');
  lines.push('## 📚 Problems in this repository');
  lines.push('');
  lines.push('| # | Title | Difficulty | Topics | Languages |');
  lines.push('| --- | --- | --- | --- | --- |');

  rows.forEach(function (p) {
    var folder = p.folder || '';
    var files = (p.files || []).slice().sort(function (a, b) { return a.path.localeCompare(b.path); });
    var link = files.length ? './' + files[0].path : (folder ? './' + folder : './');
    var tagStr = (p.tags && p.tags.length) ? p.tags.join(', ') : '-';
    var langStr = Object.keys(p.langs || {}).sort().map(function (ext) { return p.langs[ext].lang; }).join(' · ');
    if (!langStr) langStr = '-';
    var idTxt = (p.id == null) ? '-' : String(p.id);
    lines.push('| ' + idTxt + ' | [' + esc(p.title) + '](' + link + ') | ' + esc(p.difficulty || '-') +
      ' | ' + esc(tagStr) + ' | ' + esc(langStr) + ' |');
  });

  lines.push('');
  lines.push('---');
  lines.push('Created with ❤️ using [LeetSync](https://github.com/Caktusuki)');
  return lines.join('\n') + '\n';
}

// ---------- Repo auto-initialization ----------

async function ensureRepoInitialized(s) {
  var branch = s.branch || 'main';
  try {
    await gh(s, '/git/ref/heads/' + encodeURIComponent(branch));
    return { created: false, branch: branch };
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
  }

  await appendLog('INFO', 'Repository has no commits yet - auto-initializing with a root README...');
  try {
    var content = btoa('# LeetCode Solutions\n\nSolutions synced automatically with LeetSync.\n');
    await gh(s, '/contents/README.md', {
      method: 'PUT',
      body: JSON.stringify({ message: 'Initial commit: LeetSync setup', content: content })
    });
  } catch (e2) {
    if (e2.status === 422) return { created: false };
    throw e2;
  }

  var repo = await gh(s, '');
  var corrected = (repo && repo.default_branch) || branch;
  if (corrected && corrected !== s.branch) {
    s.branch = corrected;
    try {
      var data = await api.storage.local.get({ settings: {} });
      await api.storage.local.set({ settings: Object.assign({}, data.settings || {}, { branch: corrected }) });
      await appendLog('INFO', 'Branch corrected to repo default "' + corrected + '".');
    } catch (e3) {}
  }
  return { created: true, branch: s.branch };
}

// ---------- Repo index (source of truth for READMEs) ----------

async function loadRepoIndex() {
  try {
    var d = await api.storage.local.get({ repoIndex: null });
    return (d.repoIndex && d.repoIndex.problems) ? d.repoIndex.problems : null;
  } catch (e) { return null; }
}

async function persistRepoIndex(problems) {
  try {
    await api.storage.local.set({ repoIndex: { problems: problems, timestamp: Date.now() } });
  } catch (e) {}
}

// Read the branch head and its tree FRESH (gh is no-store). Never cache this
// across commits - a stale head is what made later batches overwrite earlier.
async function ghHead(s) {
  var ref = await gh(s, '/git/ref/heads/' + encodeURIComponent(s.branch));
  var sha = ref && ref.object && ref.object.sha;
  if (!sha) throw new Error('Could not read branch head for "' + s.branch + '"');
  var c = await gh(s, '/git/commits/' + sha);
  var tree = (c && c.tree && c.tree.sha) ? c.tree.sha : null;
  return { headSha: sha, baseTree: tree };
}

// Fast-forward only. force:false so GitHub returns 422 instead of silently
// clobbering newer commits.
async function updateRef(s, sha) {
  return gh(s, '/git/refs/heads/' + encodeURIComponent(s.branch), {
    method: 'PATCH', body: JSON.stringify({ sha: sha, force: false })
  });
}

// Verify that a ref PATCH actually took effect by re-reading the head no-store.
async function verifyHead(s, expectedSha) {
  var now = await ghHead(s);
  if (now.headSha !== expectedSha) {
    var e = new Error('Branch head is ' + String(now.headSha).slice(0, 7) + ' but the new commit is ' + String(expectedSha).slice(0, 7) + ' - the ref update did not take effect. Stopping so later batches cannot overwrite it.');
    e.headMismatch = true;
    e.status = 0;
    throw e;
  }
  return now;
}

// Merge the files a batch is about to write into the repo index so the
// generated READMEs always describe what is actually in the repository.
function mergeBatchIntoRepo(repoMap, it, e, settings) {
  var s = settings || {};
  var folder = folderOf(e, s);
  var baseName = resolveFileBaseName(e, it, s);
  var p = repoMap[it.slug];
  if (!p) {
    p = {
      id: it.id, slug: it.slug, title: it.title, difficulty: it.difficulty,
      tags: it.tags || [], folder: folder, langs: {}, files: []
    };
    repoMap[it.slug] = p;
  }
  if (!p.folder) p.folder = folder;
  if (p.id == null && it.id != null) p.id = it.id;
  if ((!p.tags || !p.tags.length) && it.tags && it.tags.length) p.tags = it.tags;
  p.langs[it.ext] = {
    lang: it.langName || langForExt(it.ext),
    runtime: it.runtime || '-',
    memory: it.memory || '-',
    timestamp: it.timestamp || null
  };
  var fpath = folder + '/' + baseName + '.' + it.ext;
  if (!p.files.some(function (f) { return f.path === fpath; })) {
    p.files.push({ path: fpath, filename: baseName + '.' + it.ext, ext: it.ext, folder: folder });
  }
  return fpath;
}

// ---------- Atomic commit of a batch ----------

async function commitBatch(state, batch, ctx) {
  var s = state.settings;
  var solved = JSON.parse(JSON.stringify(state.solved));
  batch.forEach(function (it) { applyItem(solved, it); });

  var repoMap = state.repoProblems || (await loadRepoIndex()) || {};

  ctx = ctx || {};
  // 1. current branch head (or empty repo). During an import, ctx.headSha is
  //    chained IN MEMORY from the previous batch's commit so we never re-read
  //    a (possibly HTTP-cached, stale) ref between batches.
  var headSha = ctx.headSha || null;
  var baseTree = ctx.headSha ? ctx.baseTree : null;
  var branchExists = true;

  if (!headSha) {
    try {
      var h = await ghHead(s);
      headSha = h.headSha;
      baseTree = h.baseTree;
    } catch (e) {
      if (e.status !== 404 && e.status !== 409) throw e;
      branchExists = false;
    }
  }

  if (!branchExists) {
    var initRes = await ensureRepoInitialized(s);
    if (initRes.created) {
      await appendLog('INFO', 'Empty repository detected - created root README, branch "' + s.branch + '" is ready for import.');
    }
    for (var retryRef = 0; retryRef < 3; retryRef++) {
      try {
        var refNow = await gh(s, '/git/ref/heads/' + encodeURIComponent(s.branch));
        headSha = refNow.object.sha;
        var headCommitNow = await gh(s, '/git/commits/' + headSha);
        baseTree = (headCommitNow.tree && headCommitNow.tree.sha) ? headCommitNow.tree.sha : null;
        branchExists = true;
        break;
      } catch (eRetry) {
        if (eRetry.status !== 404 && eRetry.status !== 409) throw eRetry;
        if (retryRef < 2) await sleep(800);
      }
    }
  }

  // 2. files: README + solution per item, plus master README
  var files = {};
  var writableBatch = [];
  var skippedCount = 0;
  for (var i = 0; i < batch.length; i++) {
    var it = batch[i];
    if (!it.ext) {
      skippedCount++;
      await appendLog('WARN', 'Skipping ' + (it.id || '') + '. ' + (it.title || it.slug) + ' - no language/code available (not committing a placeholder).');
      continue;
    }
    var e = solved[it.slug] || it;
    var folder = folderOf(e, s);
    var baseName = resolveFileBaseName(e, it, s);
    var needsCode = !it.code || !it.code.trim() || it.code.indexOf('# Solution for ') === 0;
    if (needsCode) {
      var fetchedCode = await fetchSubmissionCode(it.submissionId, it.slug);
      if (fetchedCode && fetchedCode.indexOf('# Solution for ') !== 0) {
        it.code = fetchedCode;
      } else {
        skippedCount++;
        await appendLog('WARN', 'No submission code found for ' + (it.id || '') + '. ' + (it.title || it.slug) + ' (' + (it.langName || 'unknown') + ') - skipping to avoid committing a placeholder.');
        continue;
      }
    }
    mergeBatchIntoRepo(repoMap, it, e, s);
    writableBatch.push(it);
    files[folder + '/' + baseName + '.' + it.ext] = withNewline(it.code);
  }

  // Nothing writable: do not create a README-only/"already identical" commit.
  if (writableBatch.length === 0) {
    return { committed: false, written: 0, skipped: skippedCount };
  }

  writableBatch.forEach(function (it) {
    if (s.generateProblemReadme === false) return;
    var folder = folderOf(solved[it.slug] || it, s);
    var p = repoMap[it.slug];
    files[folder + '/README.md'] = problemReadme(p || (solved[it.slug] || it), s);
  });
  if (s.maintainRootReadme !== false) {
    files['README.md'] = rootReadme(repoMap, s);
  }

  var entries = Object.keys(files).map(function (p) {
    return { path: p, mode: '100644', type: 'blob', content: files[p] };
  });

  // 3. one tree, one commit, one ref update => atomic
  var treeBody = { tree: entries };
  if (baseTree) treeBody.base_tree = baseTree;
  var tree = await gh(s, '/git/trees', {
    method: 'POST', body: JSON.stringify(treeBody)
  });
  if (baseTree && tree.sha === baseTree) {
    if (ctx) { ctx.headSha = headSha; ctx.baseTree = baseTree; }
    await persistRepoIndex(repoMap);
    return { committed: false, written: writableBatch.length, skipped: skippedCount }; // nothing changed (dedup)
  }

  var template = s.commitTemplate || 'Add {id}. {title} ({lang})';
  var item = batch[0];
  var message = batch.length === 1
    ? template
        .replace(/{id}/g, item.id || '')
        .replace(/{title}/g, item.title || '')
        .replace(/{difficulty}/g, item.difficulty || '')
        .replace(/{lang}/g, item.langName || '')
        .replace(/{runtime}/g, item.runtime || '')
        .replace(/{memory}/g, item.memory || '')
    : 'Sync ' + batch.length + ' LeetCode solutions (LeetSync)';

  var committedTreeSha = tree.sha;
  var commitBody = {
    message: message,
    tree: tree.sha,
    parents: headSha ? [headSha] : []
  };
  var commit = await gh(s, '/git/commits', {
    method: 'POST', body: JSON.stringify(commitBody)
  });

  if (branchExists) {
    try {
      await updateRef(s, commit.sha);
    } catch (refErr) {
      if (refErr && refErr.status === 422) {
        // Not a fast-forward: the branch moved under us. Re-read the REAL head
        // (no-store), rebuild this batch on top of it, and retry ONCE. Never
        // overwrite silently.
        await appendLog('WARN', 'Ref update rejected (422, not a fast-forward). Re-reading head and rebuilding this batch on top...');
        var h2 = await ghHead(s);
        var treeBody2 = { tree: entries };
        if (h2.baseTree) treeBody2.base_tree = h2.baseTree;
        var tree2 = await gh(s, '/git/trees', { method: 'POST', body: JSON.stringify(treeBody2) });
        var commit2 = await gh(s, '/git/commits', {
          method: 'POST', body: JSON.stringify({ message: message, tree: tree2.sha, parents: [h2.headSha] })
        });
        await updateRef(s, commit2.sha);
        commit = commit2;
        committedTreeSha = tree2.sha;
        headSha = h2.headSha;
        baseTree = h2.baseTree;
      } else {
        throw refErr;
      }
    }
  } else {
    await gh(s, '/git/refs', {
      method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + s.branch, sha: commit.sha })
    });
  }

  // Verify the ref actually advanced to our new commit before the next batch
  // builds on it. If not, stop - otherwise later batches would overwrite this.
  await verifyHead(s, commit.sha);

  if (ctx) { ctx.headSha = commit.sha; ctx.baseTree = committedTreeSha; }
  await persistRepoIndex(repoMap);
  return { committed: true, sha: commit.sha, tree: committedTreeSha, written: writableBatch.length, skipped: skippedCount };
}

// One atomic "Update topics" commit regenerating README.md + affected problem
// READMEs from freshly fetched tags. Never commits when nothing changed.
async function commitTopicsUpdate(s, repoProblems, changedSlugs) {
  if (!changedSlugs || !changedSlugs.length) return { committed: false, changed: 0 };
  if (s.maintainRootReadme === false && s.generateProblemReadme === false) {
    return { committed: false, changed: 0 };
  }
  try {
    var ref = await gh(s, '/git/ref/heads/' + encodeURIComponent(s.branch));
    if (!ref || !ref.object || !ref.object.sha) return { committed: false, error: 'no ref' };
    var headCommit = await gh(s, '/git/commits/' + ref.object.sha);
    var baseTree = (headCommit && headCommit.tree && headCommit.tree.sha) || '';

    var files = {};
    if (s.maintainRootReadme !== false) {
      files['README.md'] = rootReadme(repoProblems, s);
    }
    if (s.generateProblemReadme !== false) {
      changedSlugs.forEach(function (slug) {
        var p = repoProblems[slug];
        if (!p) return;
        var folder = (p.folder || '').replace(/\/+$/, '');
        if (!folder) return;
        files[folder + '/README.md'] = problemReadme(p, s);
      });
    }

    var entries = Object.keys(files).map(function (path) {
      return { path: path, mode: '100644', type: 'blob', content: files[path] };
    });
    if (!entries.length) return { committed: false, changed: 0 };

    var treeBody = { tree: entries };
    if (baseTree) treeBody.base_tree = baseTree;
    var tree = await gh(s, '/git/trees', {
      method: 'POST', body: JSON.stringify(treeBody)
    });
    if (baseTree && tree.sha === baseTree) return { committed: false, changed: changedSlugs.length }; // nothing changed

    var commit = await gh(s, '/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message: 'Update topics', tree: tree.sha, parents: [ref.object.sha] })
    });
    try {
      await updateRef(s, commit.sha);
    } catch (e422) {
      if (e422 && e422.status === 422) {
        // Branch moved: rebuild once on the real head.
        var h3 = await ghHead(s);
        var treeBody3 = { tree: entries };
        if (h3.baseTree) treeBody3.base_tree = h3.baseTree;
        var tree3 = await gh(s, '/git/trees', { method: 'POST', body: JSON.stringify(treeBody3) });
        if (h3.baseTree && tree3.sha === h3.baseTree) return { committed: false, changed: 0 };
        commit = await gh(s, '/git/commits', {
          method: 'POST', body: JSON.stringify({ message: 'Update topics', tree: tree3.sha, parents: [h3.headSha] })
        });
        await updateRef(s, commit.sha);
      } else {
        throw e422;
      }
    }
    await verifyHead(s, commit.sha);
    await appendLog('INFO', '✓ Committed "Update topics" for ' + changedSlugs.length + ' problem(s) (single commit).');
    return { committed: true, sha: commit.sha, changed: changedSlugs.length };
  } catch (e) {
    await appendLog('WARN', 'Topics commit failed: ' + e.message);
    return { committed: false, error: e.message };
  }
}

// ---------- Queue ----------

async function processQueue() {
  if (running) return;
  running = true;
  var attempts = 0;
  await api.storage.local.set({ isSyncing: true });
  if (api.runtime && api.runtime.sendMessage) {
    api.runtime.sendMessage({ type: 'syncStatusChanged', isSyncing: true }).catch(function () {});
  }

  try {
    for (;;) {
      var st = await getState();
      var s = st.settings;
      if (!s.token || !s.owner || !s.repo) {
        if (st.queue && st.queue.length > 0) {
          await setError('Configure your GitHub token and repository in settings to sync queued solutions.');
          await appendLog('WARN', 'Sync skipped: ' + st.queue.length + ' queued item(s) waiting - GitHub not configured.');
        }
        return;
      }
      if (!st.queue.length) return;

      var batch = st.queue.slice(0, BATCH_SIZE);
      await appendLog('INFO', 'Sync: committing batch of ' + batch.length + ' solution(s) to ' + s.owner + '/' + s.repo + '...');
      try {
        await commitBatch(st, batch);
        var fresh = await getState();
        var solved = fresh.solved;
        batch.forEach(function (it) { applyItem(solved, it); });
        var ids = batch.map(function (b) { return b.submissionId; });
        var rest = fresh.queue.filter(function (q) { return ids.indexOf(q.submissionId) === -1; });
        await api.storage.local.set({ solved: solved, queue: rest, lastError: null, lastSync: Date.now() });
        await appendLog('INFO', 'Sync: committed ' + batch.length + ' solution(s) (' + rest.length + ' remaining in queue).');
        attempts = 0;
        if (rest.length) await sleep(PACE_MS);
      } catch (e) {
        if (e instanceof RateLimitError) {
          await setError('GitHub rate limit reached. Resuming automatically in ~' + Math.ceil(e.waitMs / 1000) + 's.');
          await appendLog('WARN', 'Sync: rate limited, sleeping ' + Math.ceil(e.waitMs / 1000) + 's...');
          await sleep(Math.min(e.waitMs, 60 * 60 * 1000));
          continue;
        }
        if (e.status === 401 || e.status === 403 || e.status === 404) {
          await setError(authHint(e));
          await appendLog('ERROR', 'Sync stopped: ' + authHint(e));
          return;
        }
        if (e.status === 409) {
          await setError('Repository is empty and auto-initialization failed (409). Check that the token has write access, then press "Sync now".');
          await appendLog('ERROR', 'Sync stopped: repository is empty and auto-initialization failed (409).');
          return;
        }
        attempts++;
        if (attempts >= MAX_ATTEMPTS) {
          await setError('Sync failed: ' + e.message + ' (queued items are kept; press "Sync now" to retry)');
          await appendLog('ERROR', 'Sync failed after ' + attempts + ' attempts: ' + e.message);
          return;
        }
        await appendLog('WARN', 'Sync attempt ' + attempts + ' failed: ' + e.message + '. Retrying...');
        await sleep(2000 * Math.pow(2, attempts - 1));
      }
    }
  } finally {
    running = false;
    await api.storage.local.set({ isSyncing: false });
    if (api.runtime && api.runtime.sendMessage) {
      api.runtime.sendMessage({ type: 'syncStatusChanged', isSyncing: false }).catch(function () {});
    }
  }
}

function authHint(e) {
  if (e.status === 401) return 'GitHub rejected the token (401). Check or regenerate it in settings.';
  if (e.status === 404) return 'Repository or branch not found (404). Check owner, repo and branch, and that the token can access it.';
  return 'GitHub denied access (403). The token needs Contents: read & write on this repo.';
}

async function enqueue(it) {
  var st = await getState();
  var done = st.solved[it.slug] && st.solved[it.slug].langs[it.ext];
  if (done && done.submissionId === it.submissionId) return { skipped: 'already synced' };
  if (st.queue.some(function (q) { return q.submissionId === it.submissionId; })) return { skipped: 'already queued' };
  // newer accepted solution for same problem+language replaces an older queued one
  var queue = st.queue.filter(function (q) { return !(q.slug === it.slug && q.ext === it.ext); });
  queue.push(it);
  await api.storage.local.set({ queue: queue });
  await appendLog('INFO', 'Queued: ' + it.id + '. ' + it.title + ' (' + (it.langName || it.ext) + ') - queue size: ' + queue.length);
  // A fresh accepted submission means the account's submission list changed;
  // force-refresh it (single-flight) so the solved list stays accurate.
  fetchLeetCodeSubmissions(null, true).catch(function () {});
  if (st.settings.realtimeSync !== false) {
    processQueue();
  }
  return { queued: true };
}

async function testConnection(settings) {
  var s = Object.assign({}, DEFAULTS, settings);
  if (!s.token) throw new Error('Token is missing. Connect your GitHub account first.');

  // Auto-detect username from GitHub if not specified
  if (!s.owner) {
    try {
      var userRes = await gh(s, '', { urlOverride: 'https://api.github.com/user' });
      if (userRes && userRes.login) s.owner = userRes.login;
    } catch (e) {}
  }
  if (!s.owner) throw new Error('Could not identify GitHub username. Please check your token permissions.');
  if (!s.repo) throw new Error('Repository name is missing. Please select or enter a repository name.');

  var repoInfo = await gh(s, '');
  try {
    var ref = await gh(s, '/git/ref/heads/' + encodeURIComponent(s.branch));
    await appendLog('INFO', 'Connection test succeeded: ' + s.owner + '/' + s.repo + ' (' + s.branch + '), head sha ' + ref.object.sha.slice(0, 7));
    return { ok: true, sha: ref.object.sha, repo: repoInfo.full_name, detectedOwner: s.owner };
  } catch (err) {
    if (err.status === 404 || err.status === 409) {
      await appendLog('INFO', 'Connected to repo ' + repoInfo.full_name + ', branch "' + s.branch + '" has no commits yet.');
      return { ok: true, sha: 'empty', emptyRepo: true, message: 'Connected to ' + repoInfo.full_name + '. Branch will be created on first sync.', detectedOwner: s.owner };
    }
    throw err;
  }
}

// Universal Problem Scanner for Older & Custom Repositories (LeetHub 1.0, 2.0, 3.0, LeetCode-Sync, nested dirs)
var IGNORED_REPO_DIR_NAMES = new Set([
  'leetcode', 'easy', 'medium', 'hard', 'python', 'python3', 'cpp', 'c++', 'java',
  'js', 'javascript', 'ts', 'typescript', 'go', 'golang', 'rust', 'csharp', 'c#',
  'ruby', 'swift', 'kotlin', 'sql', 'bash', 'solutions', 'notes', 'src', 'docs',
  'assets', 'img', 'images', 'bin', '.github', '.git', 'build', 'dist', 'leetsync',
  'leethub', 'my-solutions', 'code', 'problems'
]);

async function analyzeRepoTree(treeEntries, solvedMap) {
  var catalog = await getQuestionCatalog();
  var knownIds = {};
  var knownSlugs = {};

  function addKnown(id, slug, title, difficulty) {
    if (!slug) return;
    var normSlug = String(slug).toLowerCase().trim();
    var numId = (id != null && !isNaN(Number(id))) ? Number(id) : null;
    var normTitleSlug = (title || slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var info = { id: numId, slug: normSlug, title: title || slug, difficulty: difficulty || 'Easy' };

    if (numId != null) {
      knownIds[numId] = info;
      var p4 = String(numId).padStart(4, '0');
      var p3 = String(numId).padStart(3, '0');
      knownSlugs[p4 + '-' + normSlug] = info;
      knownSlugs[p3 + '-' + normSlug] = info;
      if (normTitleSlug) {
        knownSlugs[p4 + '-' + normTitleSlug] = info;
        knownSlugs[p3 + '-' + normTitleSlug] = info;
      }
    }
    knownSlugs[normSlug] = info;
    if (normTitleSlug) knownSlugs[normTitleSlug] = info;
    knownSlugs[normSlug.replace(/-/g, '')] = info;
  }

  // Build lookup index from full LeetCode catalog & solved user problems
  if (catalog) {
    Object.keys(catalog).forEach(function (slug) {
      if (slug.startsWith('_')) return;
      var item = catalog[slug];
      if (item) {
        addKnown(item.id, slug, item.title, item.difficulty);
      }
    });
  }

  if (solvedMap) {
    Object.keys(solvedMap).forEach(function (slug) {
      var item = solvedMap[slug];
      if (item) {
        addKnown(item.id, slug, item.title, item.difficulty);
      }
    });
  }

  var recognizedProblemsMap = {};
  var recognizedSlugs = new Set();
  var recognizedIds = new Set();
  var topLevelDirs = new Set();
  var unrecognizedTopDirs = new Set();
  var rootReadmeFound = false;

  (treeEntries || []).forEach(function (item) {
    var pathStr = item.path || '';
    if (pathStr.toLowerCase() === 'readme.md') rootReadmeFound = true;

    var parts = pathStr.split('/');
    if (parts.length > 0 && parts[0]) {
      topLevelDirs.add(parts[0]);
    }

    parts.forEach(function (part) {
      if (!part) return;
      var lowerPart = part.toLowerCase();
      var nameClean = lowerPart.replace(/\.(py|cpp|c|java|js|ts|cs|go|rs|rb|swift|kt|php|sql|sh|md|txt)$/i, '');
      nameClean = nameClean.replace(/^(leetcode|leethub|problem|sol|solution)[._\s-]+/i, '');

      if (IGNORED_REPO_DIR_NAMES.has(nameClean)) return;

      var matchInfo = null;

      // 1. Check ID + Title pattern: e.g. "0001-two-sum", "1. Two Sum", "0001_two_sum", "1-two-sum", "1.Two Sum"
      var m = nameClean.match(/^(\d+)[._\s-]+(.+)$/);
      if (m) {
        var num = Number(m[1]);
        var titleCandidate = m[2].replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (knownIds[num]) {
          matchInfo = knownIds[num];
        } else if (knownSlugs[titleCandidate]) {
          matchInfo = knownSlugs[titleCandidate];
        }
      }

      // 2. Check Title-Only / LeetHub pattern: e.g. "Two-Sum", "two-sum", "Two Sum"
      if (!matchInfo) {
        var titleCandidate = nameClean.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (titleCandidate.length > 1 && knownSlugs[titleCandidate]) {
          matchInfo = knownSlugs[titleCandidate];
        } else if (knownSlugs[nameClean.replace(/[^a-z0-9]/g, '')]) {
          matchInfo = knownSlugs[nameClean.replace(/[^a-z0-9]/g, '')];
        }
      }

      // 3. Check standalone ID pattern: e.g. folder "0001" or "1"
      if (!matchInfo && /^\d+$/.test(nameClean)) {
        var num = Number(nameClean);
        if (knownIds[num]) {
          matchInfo = knownIds[num];
        }
      }

      // 4. Check Submission #12345 or folder with path parent ID
      if (!matchInfo && nameClean.includes('submission')) {
        parts.forEach(function (p2) {
          var numCandidate = Number(p2.replace(/[^0-9]/g, ''));
          if (numCandidate && knownIds[numCandidate]) {
            matchInfo = knownIds[numCandidate];
          }
        });
      }

      if (matchInfo) {
        var slug = matchInfo.slug;
        recognizedSlugs.add(slug);
        if (matchInfo.id) recognizedIds.add(Number(matchInfo.id));
        if (!recognizedProblemsMap[slug]) {
          recognizedProblemsMap[slug] = {
            id: matchInfo.id,
            slug: matchInfo.slug,
            title: matchInfo.title,
            difficulty: matchInfo.difficulty,
            path: pathStr,
            matchedSegment: part
          };
        }
      }
    });
  });

  // Calculate unrecognized top-level folders
  topLevelDirs.forEach(function (top) {
    var topLower = top.toLowerCase();
    if (IGNORED_REPO_DIR_NAMES.has(topLower) || topLower === 'readme.md') return;
    var isProb = false;
    Object.values(recognizedProblemsMap).forEach(function (p) {
      if (p.path.startsWith(top)) isProb = true;
    });
    if (!isProb) unrecognizedTopDirs.add(top);
  });

  return {
    recognizedSlugs: recognizedSlugs,
    recognizedIds: recognizedIds,
    recognizedProblems: Object.values(recognizedProblemsMap),
    unrecognizedTopDirs: Array.from(unrecognizedTopDirs),
    rootReadmeFound: rootReadmeFound,
    knownIds: knownIds,
    knownSlugs: knownSlugs
  };
}

function parseReadmeContent(rawText, knownIds, knownSlugs) {
  var recognizedSlugs = new Set();
  var recognizedIds = new Set();

  if (!rawText) return { recognizedSlugs: recognizedSlugs, recognizedIds: recognizedIds };

  var lines = rawText.split(/\r?\n/);
  lines.forEach(function (line) {
    if (!line) return;

    var idMatch = line.match(/(?:\||\b|-)\s*(\d{1,5})\s*(?:\.|\s*\||\])/);
    if (idMatch) {
      var num = Number(idMatch[1]);
      if (knownIds && knownIds[num]) {
        recognizedSlugs.add(knownIds[num].slug);
        recognizedIds.add(num);
      }
    }

    var linkMatches = line.match(/\.\/([^)\s]+)|\/problems\/([a-z0-9-]+)/gi);
    if (linkMatches) {
      linkMatches.forEach(function (link) {
        var clean = link.replace(/^\.\/|\/problems\//i, '').replace(/\/$/, '').toLowerCase();
        var parts = clean.split('/');
        parts.forEach(function (part) {
          var nameClean = part.replace(/\.(py|cpp|c|java|js|ts|cs|go|rs|rb|swift|kt|php|sql|sh|md|txt)$/i, '');
          nameClean = nameClean.replace(/^(leetcode|leethub|problem|sol|solution)[._\s-]+/i, '');

          var m = nameClean.match(/^(\d+)[._\s-]+(.+)$/);
          if (m) {
            var num = Number(m[1]);
            var titleCandidate = m[2].replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            if (knownIds && knownIds[num]) {
              recognizedSlugs.add(knownIds[num].slug);
              recognizedIds.add(num);
            }
            if (knownSlugs && knownSlugs[titleCandidate]) {
              recognizedSlugs.add(knownSlugs[titleCandidate].slug);
            }
          } else {
            var titleCandidate = nameClean.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            if (knownSlugs && knownSlugs[titleCandidate]) {
              recognizedSlugs.add(knownSlugs[titleCandidate].slug);
            }
          }
        });
      });
    }
  });

  return { recognizedSlugs: recognizedSlugs, recognizedIds: recognizedIds };
}

async function checkRepo(settings) {
  var s = Object.assign({}, DEFAULTS, settings);
  var inventory = await scanRepoInventory(s);
  await appendLog('INFO', 'Repo check completed: ' + inventory.inRepoCount + ' problem(s) in repo, ' + inventory.missingCount + ' missing to add (Total solved: ' + inventory.totalSolved + ').');
  return {
    ok: true,
    totalFiles: inventory.totalFiles,
    totalSolved: inventory.totalSolved,
    inRepoCount: inventory.inRepoCount,
    missingCount: inventory.missingCount,
    recognizedProblems: inventory.inRepoCount,
    unrecognizedFolders: inventory.unrecognizedCount
  };
}

// ---------- Real LeetCode Submissions Fetcher & Import Runner ----------

var importRunning = false;
var importCancelled = false;
var currentImportStatus = {
  running: false,
  imported: 0,
  total: 0,
  pct: 0,
  skipped: 0,
  failed: 0,
  currentProblem: '',
  currentBatch: 0,
  totalBatches: 0,
  commits: []
};

var questionCatalogCache = null;
var catalogFetchPromise = null;
async function getQuestionCatalog(forceRefresh) {
  if (questionCatalogCache && !forceRefresh) return questionCatalogCache;
  if (catalogFetchPromise) return catalogFetchPromise;
  catalogFetchPromise = (async function () {
    try {
      var categories = ['all', 'database', 'shell', 'concurrency', 'javascript', 'pandas'];
      var map = {};
      var solvedSet = new Set();
      var allOk = false;

      await Promise.all(categories.map(async function (cat) {
        try {
          var res = await fetch('https://leetcode.com/api/problems/' + cat + '/', { credentials: 'include' });
          if (res.ok) {
            var json = await res.json();
            var pairs = json.stat_status_pairs || [];
            pairs.forEach(function (p) {
              var slug = p.stat && p.stat.question__title_slug;
              if (!slug) return;
              var diff = 'Easy';
              if (p.difficulty && p.difficulty.level === 2) diff = 'Medium';
              if (p.difficulty && p.difficulty.level === 3) diff = 'Hard';
              var item = {
                id: p.stat.frontend_question_id || p.stat.question_id,
                title: p.stat.question__title,
                difficulty: diff,
                status: p.status,
                category: cat
              };
              map[slug] = item;
              if (p.status === 'ac') {
                solvedSet.add(slug);
              }
            });
            // The 'all' category contains every problem, so it is authoritative
            // for the solved count. Other categories only add metadata.
            if (cat === 'all') allOk = true;
          }
        } catch (e) {
          console.warn('[LeetSync Catalog ' + cat + ']', e);
        }
      }));

      map._allSolvedSlugs = Array.from(solvedSet);
      if (allOk && map._allSolvedSlugs.length > 0) {
        questionCatalogCache = map;
      }
      return map;
    } catch (e) {
      console.warn('[LeetSync Catalog Error]', e);
    }
    return {};
  })();
  try {
    return await catalogFetchPromise;
  } finally {
    catalogFetchPromise = null;
  }
}

// ---------- Solved-list reconciliation (accepted only, one entry per problem id) ----------

function catalogSlugForId(catalog, id) {
  if (id == null || !catalog) return null;
  var keys = Object.keys(catalog);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k.startsWith('_')) continue;
    var it = catalog[k];
    if (it && Number(it.id) === Number(id)) return k;
  }
  return null;
}

// Returns { solved, dropped, duplicates } where solved contains only problems
// that are backed by an accepted submission, at most ONE slug per problem id.
// `acceptedSlugs` is the authoritative set of accepted slugs. `priorSolved` is
// used only to preserve already-fetched code/langs for retained problems.
function reconcileSolved(acceptedSlugs, priorSolved, catalog) {
  priorSolved = priorSolved || {};
  acceptedSlugs = acceptedSlugs || {};
  catalog = catalog || {};
  var byId = {};
  var result = {};
  var revoked = [];
  var dups = [];

  Object.keys(acceptedSlugs).forEach(function (slug) {
    var src = acceptedSlugs[slug] || {};
    var cat = catalog[slug];
    var id = (cat && cat.id != null) ? cat.id : src.id;
    var prior = priorSolved[slug];
    var entry = {
      id: id != null ? id : (prior ? prior.id : src.id),
      slug: slug,
      title: (cat && cat.title) || src.title || (prior && prior.title) || slug,
      difficulty: (cat && cat.difficulty) || src.difficulty || (prior && prior.difficulty) || 'Easy',
      tags: (prior && prior.tags && prior.tags.length) ? prior.tags : (src.tags || []),
      constraints: (prior && prior.constraints) || src.constraints || [],
      langs: Object.assign({}, (prior && prior.langs) || {}, src.langs || {})
    };
    var key = (entry.id == null) ? 'slug:' + slug : 'id:' + Number(entry.id);
    if (byId[key]) {
      // Same problem id under two slugs: keep the catalog's canonical slug and
      // merge the language maps so no accepted code is lost.
      var kept = byId[key];
      var keptIsCatalog = !!catalog[kept.slug];
      var curIsCatalog = !!catalog[slug];
      dups.push({ id: entry.id, kept: kept.slug, dropped: slug });
      if (curIsCatalog && !keptIsCatalog) {
        entry.langs = Object.assign({}, kept.langs, entry.langs);
        result[slug] = entry;
        delete result[kept.slug];
        byId[key] = entry;
      } else {
        kept.langs = Object.assign({}, kept.langs, entry.langs);
      }
      return;
    }
    byId[key] = entry;
    result[slug] = entry;
  });

  // Any previously-solved problem that is NOT backed by an accepted submission
  // is removed (this is what kept the solved list inflated).
  Object.keys(priorSolved).forEach(function (slug) {
    if (!acceptedSlugs[slug]) {
      revoked.push({
        slug: slug,
        id: (priorSolved[slug] && priorSolved[slug].id) || (catalog[slug] && catalog[slug].id) || null,
        catalogStatus: (catalog[slug] && catalog[slug].status) || (catalog[slug] ? 'unknown' : 'not-in-catalog')
      });
    }
  });

  return { solved: result, revoked: revoked, duplicates: dups };
}

// Diagnostic: which slugs are in the live solved map but not in the catalog's
// accepted set, and why. Used to explain "171 -> 216"-style inflation.
async function diagnoseSolved() {
  var st = await getState();
  var catalog = await getQuestionCatalog();
  var acceptedSet = new Set(catalog._allSolvedSlugs || []);
  var solved = st.solved || {};
  var ids = {};
  Object.keys(solved).forEach(function (slug) {
    var id = solved[slug] && solved[slug].id;
    if (id != null) {
      ids[id] = ids[id] || [];
      ids[id].push(slug);
    }
  });
  var extra = [];
  Object.keys(solved).forEach(function (slug) {
    if (acceptedSet.has(slug)) return;
    var e = solved[slug] || {};
    var id = e.id;
    var reason;
    if (id != null && ids[id] && ids[id].length > 1) {
      reason = 'duplicate-id (' + ids[id].join(', ') + ')';
    } else if (!catalog[slug]) {
      reason = 'not-in-catalog';
    } else if (catalog[slug].status && catalog[slug].status !== 'ac') {
      reason = 'catalog-status:' + catalog[slug].status;
    } else {
      reason = 'not-accepted';
    }
    extra.push({ slug: slug, id: id == null ? null : id, reason: reason, langs: Object.keys(e.langs || {}) });
  });
  return {
    solvedTotal: Object.keys(solved).length,
    catalogAccepted: acceptedSet.size,
    extraCount: extra.length,
    extra: extra
  };
}

async function checkLeetCodeSession() {
  try {
    var res = await fetch('https://leetcode.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        query: `query globalData {
          userStatus {
            isSignedIn
            username
            realName
            avatar
          }
        }`
      })
    });
    if (res.ok) {
      var data = await res.json();
      var userStatus = data && data.data && data.data.userStatus;
      if (userStatus && userStatus.isSignedIn) {
        return { ok: true, loggedIn: true, username: userStatus.username || 'LeetCoder', user: userStatus.username || 'LeetCoder', realName: userStatus.realName || '' };
      }
    }
  } catch (e) {
    console.warn('[LeetSync checkLeetCode]', e);
  }

  try {
    var res2 = await fetch('https://leetcode.com/api/problems/all/', { credentials: 'include' });
    if (res2.ok) {
      var json = await res2.json();
      if (json && json.user_name) {
        return { ok: true, loggedIn: true, username: json.user_name, user: json.user_name };
      }
    }
  } catch (e) {}

  return { ok: false, loggedIn: false };
}

// ---------- LeetCode submission fetching (GraphQL) ----------

var LEET_PACE_MS = 400;
var lastLeetCall = 0;
async function leetPace() {
  var wait = LEET_PACE_MS - (Date.now() - lastLeetCall);
  if (wait > 0) await sleep(wait);
  lastLeetCall = Date.now();
}

async function getCsrfToken() {
  try {
    if (api && api.cookies && api.cookies.get) {
      var c = await api.cookies.get({ url: 'https://leetcode.com', name: 'csrftoken' });
      return (c && c.value) ? c.value : '';
    }
  } catch (e) {}
  return '';
}

var LANG_SLUG_EXT = {
  cpp: 'cpp', c: 'c', csharp: 'cs', java: 'java', python: 'py', python3: 'py',
  pythondata: 'py', pandas: 'py', javascript: 'js', typescript: 'ts', php: 'php', swift: 'swift',
  kotlin: 'kt', dart: 'dart', golang: 'go', go: 'go', ruby: 'rb', scala: 'scala',
  rust: 'rs', racket: 'rkt', erlang: 'erl', elixir: 'ex', mysql: 'sql', mssql: 'sql',
  oraclesql: 'sql', postgresql: 'sql', sql: 'sql', bash: 'sh', shell: 'sh'
};

function extForLangSlug(slug) {
  var k = String(slug || '').toLowerCase().replace(/\s+/g, '');
  if (LANG_SLUG_EXT[k]) return LANG_SLUG_EXT[k];
  if (k.indexOf('sql') !== -1) return 'sql';
  if (k.indexOf('pandas') !== -1) return 'py';
  return k.replace(/[^a-z0-9]/g, '');
}

async function leetcodePOST(body) {
  await leetPace();
  var headers = { 'Content-Type': 'application/json' };
  var csrf = await getCsrfToken();
  if (csrf) headers['x-csrftoken'] = csrf;
  return fetch('https://leetcode.com/graphql', {
    method: 'POST',
    headers: headers,
    credentials: 'include',
    body: JSON.stringify(body)
  });
}

async function leetcodePOSTWithBackoff(body, attempt) {
  attempt = attempt || 1;
  var res = await leetcodePOST(body);
  if (res.status === 429) {
    if (attempt >= 4) {
      var re = new Error('LeetCode rate limit (HTTP 429) - retries exhausted.');
      re.httpStatus = 429;
      re.kind = 'rate-limit';
      throw re;
    }
    await appendLog('WARN', 'LeetCode rate limit (429). Backing off ' + (attempt * 2) + 's...');
    await sleep(attempt * 2000);
    return leetcodePOSTWithBackoff(body, attempt + 1);
  }
  if (res.status === 401 || res.status === 403) {
    var err = new Error('Not logged into LeetCode (HTTP ' + res.status + '). Open leetcode.com in another tab and sign in.');
    err.auth = true;
    err.httpStatus = res.status;
    err.kind = 'auth';
    throw err;
  }
  return res;
}

async function fetchSubmissionDetail(submissionId) {
  var res = await leetcodePOSTWithBackoff({
    query: `query submissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        code
        timestamp
        runtime
        memory
        lang { name verboseName }
      }
    }`,
    variables: { submissionId: Number(submissionId) }
  });
  if (!res.ok) return null;
  var data = await res.json();
  return (data && data.data && data.data.submissionDetails) || null;
}

function isAcceptedSubmission(x) {
  if (!x) return false;
  if (x.status === 10) return true;
  return String(x.statusDisplay || '').trim().toLowerCase() === 'accepted';
}

async function fetchAcceptedForProblem(slug) {
  var accepted = [];
  var pageSize = 20;
  var maxSubs = 100;
  var offset = 0;
  var lastKey = null;
  var pages = 0;

  for (;;) {
    pages++;
    var res = await leetcodePOSTWithBackoff({
      query: `query submissionList($offset: Int!, $limit: Int!, $lastKey: String, $questionSlug: String) {
        submissionList(offset: $offset, limit: $limit, lastKey: $lastKey, questionSlug: $questionSlug) {
          lastKey
          hasNext
          submissions { id status statusDisplay lang langName runtime memory timestamp }
        }
      }`,
      variables: { offset: offset, limit: pageSize, lastKey: lastKey, questionSlug: slug }
    });
    if (!res.ok) {
      var he = new Error('LeetCode submissionList HTTP ' + res.status);
      he.httpStatus = res.status;
      he.kind = (res.status === 429) ? 'rate-limit' : 'http';
      throw he;
    }
    var data = await res.json();
    var block = data && data.data && data.data.submissionList;

    // An invalid/expired session returns HTTP 200 with submissionList === null
    // (hasNext/submissions null). Distinguish that from "no accepted submission"
    // so the import can report the real reason instead of silently syncing nothing.
    if (!block || block.submissions == null || block.hasNext == null) {
      var se = new Error('LeetCode returned an empty submission list for "' + slug + '" - the session cookie is likely invalid/expired. Open leetcode.com in a tab, sign in, then retry.');
      se.session = true;
      se.kind = 'session';
      throw se;
    }

    var subs = block.submissions || [];
    subs.forEach(function (x) { if (isAcceptedSubmission(x)) accepted.push(x); });

    // LeetCode paginates either by numeric offset or by an opaque cursor
    // (lastKey). Use the cursor when the server supplies one, otherwise advance
    // the offset - never both at once, to avoid skipping submissions.
    if (block.lastKey != null) {
      lastKey = block.lastKey;
      offset = 0;
    } else {
      lastKey = null;
      offset += pageSize;
    }
    // Keep paging (bounded) until we hit an accepted submission, then stop early.
    if (!block.hasNext || offset >= maxSubs || pages >= 6 || accepted.length > 0) break;
  }

  var latestByLang = {};
  accepted.forEach(function (x) {
    var key = x.lang || x.langName || '';
    if (!key) return;
    var prev = latestByLang[key];
    if (!prev || Number(x.timestamp || 0) > Number(prev.timestamp || 0)) latestByLang[key] = x;
  });

  var out = {};
  var keys = Object.keys(latestByLang);
  for (var i = 0; i < keys.length; i++) {
    var sub = latestByLang[keys[i]];
    var ext = extForLangSlug(sub.lang || sub.langName);
    if (!ext) continue;
    var det = await fetchSubmissionDetail(sub.id);
    if (!det || !det.code) continue;
    out[ext] = {
      lang: (det.lang && (det.lang.verboseName || det.lang.name)) || sub.langName || langForExt(ext),
      submissionId: String(sub.id),
      runtime: det.runtime || sub.runtime || '',
      memory: det.memory || sub.memory || '',
      code: det.code,
      timestamp: det.timestamp ? Number(det.timestamp) * 1000
        : (sub.timestamp ? Number(sub.timestamp) * 1000 : Date.now())
    };
  }
  return out;
}

async function fetchSubmissionCode(submissionId, slug) {
  try {
    if (submissionId && !String(submissionId).startsWith('catalog-')) {
      var details = await fetchSubmissionDetail(submissionId);
      if (details && details.code) {
        return details.code;
      }
    }
  } catch (e) {
    if (e && e.auth) throw e;
  }
  return null;
}

// Apply an authoritative accepted set to the live solved map. Enforces
// "only accepted submissions, one entry per problem id" and logs what it drops.
async function applyAcceptedSet(acceptedSlugs, catalog, reason) {
  var st = await getState();
  var catalog2 = catalog || (await getQuestionCatalog());
  var rec = reconcileSolved(acceptedSlugs, st.solved || {}, catalog2);
  await api.storage.local.set({ solved: rec.solved });

  if (rec.duplicates.length) {
    await appendLog('WARN', 'Solved reconcile (' + reason + '): merged ' + rec.duplicates.length + ' duplicate problem-id entr(ies), e.g. ' +
      rec.duplicates.slice(0, 5).map(function (d) { return d.dropped + ' -> ' + d.kept + ' (#' + d.id + ')'; }).join('; '));
  }
  if (rec.revoked.length) {
    await appendLog('WARN', 'Solved reconcile (' + reason + '): removed ' + rec.revoked.length + ' entries without an accepted submission: ' +
      rec.revoked.slice(0, 20).map(function (r) { return r.slug + (r.id != null ? ' (#' + r.id + ')' : ''); }).join(', ') +
      (rec.revoked.length > 20 ? '…' : ''));
    try { await api.storage.local.set({ lastRevoked: { reason: reason, revoked: rec.revoked, timestamp: Date.now() } }); } catch (e) {}
  }
  return { count: Object.keys(rec.solved).length, duplicates: rec.duplicates, revoked: rec.revoked };
}

function catalogAcceptedMap(catalog) {
  var accepted = {};
  if (catalog && catalog._allSolvedSlugs) {
    catalog._allSolvedSlugs.forEach(function (slug) {
      var cat = catalog[slug];
      if (cat) {
        accepted[slug] = { id: cat.id, slug: slug, title: cat.title, difficulty: cat.difficulty, tags: [], constraints: [], langs: {} };
      }
    });
  }
  return accepted;
}

async function syncCatalog() {
  try {
    var catalog = await getQuestionCatalog(true);
    var cached = (await api.storage.local.get({ submissionsAccepted: {} })).submissionsAccepted || {};
    var accepted = catalogAcceptedMap(catalog);
    Object.keys(cached).forEach(function (slug) {
      if (!accepted[slug]) accepted[slug] = cached[slug];
      else accepted[slug].langs = Object.assign({}, accepted[slug].langs, cached[slug].langs);
    });
    var res = await applyAcceptedSet(accepted, catalog, 'catalog');

    var st = await getState();
    if (st.settings && st.settings.token) {
      try { await scanRepoInventory(); } catch (e) {}
    }
    return { ok: true, count: res.count };
  } catch (e) {
    console.warn('[LeetSync syncCatalog]', e);
    return { ok: false, error: e.message };
  }
}

var submissionsFetchPromise = null;
var SUBMISSIONS_CACHE_TTL = 10 * 60 * 1000;
var submissionsProgress = { running: false, fetched: 0, total: 0, phase: 'idle' };

async function setSubmissionsProgress(patch) {
  submissionsProgress = Object.assign({}, submissionsProgress, patch);
  try { await api.storage.local.set({ catalogProgress: submissionsProgress }); } catch (e) {}
  try {
    if (api.runtime && api.runtime.sendMessage) {
      api.runtime.sendMessage({ type: 'catalogProgress', status: submissionsProgress }).catch(function () {});
    }
  } catch (e) {}
}

// Single-flight: concurrent triggers share one in-flight fetch and its result.
async function fetchLeetCodeSubmissions(onProgress, force) {
  if (submissionsFetchPromise) {
    await appendLog('DEBUG', 'LeetCode submissions fetch already running - joining the in-flight request.');
    return submissionsFetchPromise;
  }
  submissionsFetchPromise = (async function () {
    try {
      return await _fetchLeetCodeSubmissions(onProgress, force === true);
    } finally {
      submissionsFetchPromise = null;
      await setSubmissionsProgress({ running: false, phase: 'idle' });
    }
  })();
  return submissionsFetchPromise;
}

async function _fetchLeetCodeSubmissions(onProgress, force) {
  var cacheData = await api.storage.local.get({ submissionsCache: null });
  var cache = cacheData.submissionsCache || null;
  if (!force && cache && cache.acceptedBySlug && (Date.now() - (cache.fetchedAt || 0)) < SUBMISSIONS_CACHE_TTL) {
    await appendLog('DEBUG', 'Using cached LeetCode submissions (fetched ' + Math.round((Date.now() - cache.fetchedAt) / 1000) + 's ago, fresh for 10min).');
    return (await getState()).solved;
  }

  await appendLog('INFO', 'Fetching LeetCode account submissions...');
  var catalog = await getQuestionCatalog();
  var st = await getState();

  // Authoritative accepted set: catalog 'ac' + previously fetched submissions.
  var accepted = catalogAcceptedMap(catalog);
  var priorAccepted = (cache && cache.acceptedBySlug) ? cache.acceptedBySlug : {};
  Object.keys(priorAccepted).forEach(function (slug) {
    if (!accepted[slug]) accepted[slug] = priorAccepted[slug];
    else accepted[slug].langs = Object.assign({}, accepted[slug].langs, priorAccepted[slug].langs || {});
  });

  var seenIds = new Set((cache && cache.seenIds) || []);
  var incremental = !!cache;
  var totalTarget = (catalog._allSolvedSlugs || []).length || Object.keys(st.solved || {}).length;

  var EXT = {
    cpp: 'cpp', c: 'c', java: 'java', python: 'py', python3: 'py', csharp: 'cs',
    javascript: 'js', typescript: 'ts', php: 'php', swift: 'swift', kotlin: 'kt',
    dart: 'dart', golang: 'go', ruby: 'rb', scala: 'scala', rust: 'rs',
    racket: 'rkt', erlang: 'erl', elixir: 'ex', mysql: 'sql', mssql: 'sql',
    oraclesql: 'sql', postgresql: 'sql', bash: 'sh', pythondata: 'py'
  };

  var offset = 0;
  var limit = 50;
  var hasNext = true;
  var maxPages = 150;
  var page = 0;
  var newAccepted = 0;
  var reachedKnown = false;

  await setSubmissionsProgress({ running: true, phase: 'fetching', fetched: 0, total: totalTarget });

  try {
    while (hasNext && page < maxPages && !reachedKnown) {
      page++;
      var res = await fetch('https://leetcode.com/api/submissions/?offset=' + offset + '&limit=' + limit, { credentials: 'include' });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error('Not logged into LeetCode. Please open leetcode.com in another tab and sign in.');
        }
        throw new Error('LeetCode API returned HTTP ' + res.status);
      }
      var data = await res.json();
      var list = data.submissions_dump || [];
      if (!list.length) break;

      for (var i = 0; i < list.length; i++) {
        var sub = list[i];
        // Incremental mode: stop as soon as we re-encounter a submission we have
        // already processed in a previous run.
        if (incremental && sub.id != null && seenIds.has(String(sub.id))) { reachedKnown = true; break; }
        if (sub.id != null) seenIds.add(String(sub.id));

        if (sub.status_display === 'Accepted') {
          var slug = sub.title_slug;
          var cat = catalog[slug] || {};
          var ext = EXT[sub.lang] || (sub.lang || '').toLowerCase();
          var realTitle = (cat.title && !String(cat.title).startsWith('Submission #')) ? cat.title : (sub.title || ('Problem ' + (cat.id || sub.id)));
          if (!accepted[slug]) {
            accepted[slug] = { id: cat.id || sub.id, slug: slug, title: realTitle, difficulty: cat.difficulty || 'Easy', tags: [], constraints: [], langs: {} };
            newAccepted++;
          } else if (!accepted[slug].langs[ext]) {
            newAccepted++;
          }
          if (cat.id) accepted[slug].id = cat.id;
          if (cat.difficulty) accepted[slug].difficulty = cat.difficulty;
          accepted[slug].title = realTitle;
          accepted[slug].langs[ext] = {
            lang: sub.lang,
            submissionId: String(sub.id),
            runtime: sub.runtime || '',
            memory: sub.memory || '',
            code: sub.code || '',
            timestamp: sub.timestamp ? Number(sub.timestamp) * 1000 : Date.now()
          };
        }
      }

      hasNext = Boolean(data.has_next);
      offset += limit;
      if (onProgress) onProgress({ fetched: newAccepted, total: totalTarget });
      await setSubmissionsProgress({ running: true, phase: 'fetching', fetched: newAccepted, total: totalTarget });
      if (hasNext && !reachedKnown) await sleep(150);
    }
  } catch (e) {
    await setSubmissionsProgress({ running: false, phase: 'error', error: e.message });
    throw e;
  }

  // Persist the authoritative accepted map + incremental cursor.
  var seenArr = Array.from(seenIds);
  if (seenArr.length > 4000) seenArr = seenArr.slice(seenArr.length - 4000);
  var cacheOut = {
    acceptedBySlug: accepted,
    seenIds: seenArr,
    fetchedAt: Date.now()
  };

  var rec = await applyAcceptedSet(accepted, catalog, incremental ? 'incremental' : 'full');

  await api.storage.local.set({ submissionsCache: cacheOut, submissionsAccepted: accepted });

  var count = rec.count;
  await appendLog('INFO', 'Loaded ' + count + ' accepted problem(s) from LeetCode account' +
    (incremental ? ' (incremental: +' + newAccepted + ' new submission(s)).' : ' (full fetch).'));
  return (await getState()).solved;
}

// ---------- Tag backfill (post-scan, cached, resumable, non-blocking) ----------

async function fetchProblemTags(slug) {
  if (!slug) return null;
  try {
    var res = await fetch('https://leetcode.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        query: 'query questionData($titleSlug: String!) { question(titleSlug: $titleSlug) { topicTags { name } } }',
        variables: { titleSlug: slug }
      })
    });
    if (!res.ok) return null;
    var data = await res.json();
    var q = data && data.data && data.data.question;
    if (q && q.topicTags && q.topicTags.length) {
      return q.topicTags.map(function (t) { return t.name; });
    }
  } catch (e) {}
  return null;
}

var tagsFilling = false;
var pendingTopicSlugs = [];
async function fillMissingTags(repoProblems, settings, forceCommit) {
  if (tagsFilling) return { ok: false, skipped: 'already running' };
  tagsFilling = true;
  try {
    var cacheData = await api.storage.local.get({ tagCache: {} });
    var tagCache = cacheData.tagCache || {};
    var slugs = Object.keys(repoProblems || {}).filter(function (slug) {
      var p = repoProblems[slug];
      return p && slug && !slug.startsWith('_') &&
        !(p.tags && p.tags.length) && !tagCache[slug];
    });

    var changed = [];
    var filled = 0;
    for (var i = 0; i < slugs.length; i++) {
      var slug = slugs[i];
      var tags = await fetchProblemTags(slug);
      if (tags) {
        tagCache[slug] = tags;
        if (repoProblems[slug]) repoProblems[slug].tags = tags;
        changed.push(slug);
        filled++;
      }
      await api.storage.local.set({ tagCache: tagCache });
      if (i < slugs.length - 1) await sleep(300);
    }

    // Authoritative problem set for README regeneration: persisted repo index
    // overlaid with the in-memory repo problems and the freshly fetched tags.
    var existing = null;
    try { existing = (await api.storage.local.get({ repoIndex: null })).repoIndex; } catch (e) {}
    var full = Object.assign({}, (existing && existing.problems) || {}, repoProblems || {});
    changed.forEach(function (slug) {
      if (!tagCache[slug]) return;
      if (existing && existing.problems && existing.problems[slug]) existing.problems[slug].tags = tagCache[slug];
      if (full[slug]) full[slug].tags = tagCache[slug];
    });
    if (filled > 0 && existing && existing.problems) {
      try { await api.storage.local.set({ repoIndex: existing }); } catch (e) {}
    }

    var pending = pendingTopicSlugs.concat(changed);
    pendingTopicSlugs = [];
    if (settings && pending.length && (!importRunning || forceCommit)) {
      await commitTopicsUpdate(settings, full, pending);
    } else if (pending.length) {
      pendingTopicSlugs = pending;
    }
    return { ok: true, filled: filled, changed: changed.length };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    tagsFilling = false;
  }
}

var scanPromise = null;
var SCAN_COALESCE_MS = 5000;
var scanCache = {
  result: null,
  at: 0,
  forceAll: false,
  mark: function (result, forceAll) { this.result = result; this.at = Date.now(); this.forceAll = !!forceAll; },
  usable: function (forceAll, now) {
    if (!this.result) return false;
    if ((now - this.at) > SCAN_COALESCE_MS) return false;
    // A forced request needs a forced (superset) result; a non-forced request
    // can reuse anything fresh. forceFresh callers bypass this entirely.
    if (forceAll && !this.forceAll) return false;
    return true;
  }
};
async function scanRepoInventory(customSettings, forceAll, forceFresh) {
  if (scanPromise) return scanPromise;
  // Coalesce the burst of scans fired around import start into ONE scan.
  if (!forceFresh && scanCache.usable(forceAll, Date.now())) {
    await appendLog('DEBUG', 'Reusing repo scan from ' + Math.round((Date.now() - scanCache.at) / 1000) + 's ago (coalesced).');
    return scanCache.result;
  }
  scanPromise = (async function () {
    try {
      var r = await scanRepoInventoryInner(customSettings, forceAll);
      if (r && r.ok) scanCache.mark(r, forceAll);
      return r;
    } catch (e) {
      await appendLog('ERROR', 'Repo scan failed: ' + (e && e.message ? e.message : e));
      return { ok: false, error: (e && e.status) ? authHint(e) : (e && e.message ? e.message : String(e)) };
    } finally {
      scanPromise = null;
    }
  })();
  return scanPromise;
}

async function scanRepoInventoryInner(customSettings, forceAll) {
  var tStart = Date.now();
  var tReadmeMs = 0;
  var tTreeMs = 0;
  var st = await getState();
  var s = Object.assign({}, DEFAULTS, st.settings || {}, customSettings || {});
  var solvedMap = Object.assign({}, st.solved || {});
  var catalog = await getQuestionCatalog();

  // Merge catalog solved status ('ac') items so all solved problems are included
  if (catalog) {
    Object.keys(catalog).forEach(function (slug) {
      if (slug.startsWith('_')) return;
      var item = catalog[slug];
      if (item && item.status === 'ac' && !solvedMap[slug]) {
        solvedMap[slug] = {
          id: item.id,
          slug: slug,
          title: item.title,
          difficulty: item.difficulty,
          tags: [],
          langs: {}
        };
      }
    });
  }

  await appendLog('INFO', 'Scanning repository for ' + s.owner + '/' + s.repo + ' (' + s.branch + ')...');

  var entries = [];
  var readmeProblems = 0;
  var scanMode = 'tree';
  var fastReady = false;
  var idx = buildKnownIndex(solvedMap, catalog);

  // 1. FAST PATH: single GET /contents/README.md - parse the index table for instant counts
  var tReadme0 = Date.now();
  try {
    var readmeData = await gh(s, '/contents/README.md');
    if (readmeData && readmeData.content) {
      var rawText = atob(readmeData.content.replace(/\s/g, ''));
      var readmeParsed = parseReadmeContent(rawText, idx.knownIds, idx.knownSlugs);
      readmeProblems = readmeParsed.recognizedIds.size;
      if (readmeProblems > 0) {
        fastReady = true;
        scanMode = 'readme';
        await appendLog('INFO', 'README fast-path: ' + readmeProblems + ' problem(s) found in index (single fetch).');
      }
    }
  } catch (e) {
    if (e && (e.status === 404 || e.status === 409)) scanMode = 'new-repo';
  }
  tReadmeMs = Date.now() - tReadme0;
  await appendLog('INFO', 'Scan timing: README index ' + (scanMode === 'new-repo' ? 'absent' : 'checked') + ' in ' + tReadmeMs + 'ms.');

  // 2. ONE recursive tree call for language/file detection (also the full fallback)
  var tTree0 = Date.now();
  var treeOk = false;
  if (scanMode !== 'new-repo') {
    try {
      var treeData = await gh(s, '/git/trees/' + encodeURIComponent(s.branch) + '?recursive=1');
      entries = (treeData && treeData.tree) || [];
      treeOk = true;
    } catch (err) {
      if (err.status === 409) {
        scanMode = 'new-repo';
      } else if (err.status === 404) {
        var fallbackBranch = (s.branch === 'main') ? 'master' : 'main';
        try {
          var treeData2 = await gh(s, '/git/trees/' + encodeURIComponent(fallbackBranch) + '?recursive=1');
          s.branch = fallbackBranch;
          entries = (treeData2 && treeData2.tree) || [];
          treeOk = true;
        } catch (e2) {
          if (e2 && (e2.status === 404 || e2.status === 409)) scanMode = 'new-repo';
          else throw e2;
        }
      } else {
        throw err;
      }
    }
  }
  if (scanMode !== 'new-repo') scanMode = fastReady ? 'readme' : 'tree';
  tTreeMs = Date.now() - tTree0;
  await appendLog('INFO', 'Scan timing: tree walk in ' + tTreeMs + 'ms (' + entries.length + ' entries).');

  // Repo-driven problem set: languages/files come from the real tree.
  var tDiff0 = Date.now();
  var built = buildSolvedFromRepo(entries, s, solvedMap, catalog);
  var repoProblems = built.repoProblems;

  var repoNormSlugs = new Set();
  var repoIds = new Set();
  Object.keys(repoProblems).forEach(function (k) {
    repoNormSlugs.add(String(k).toLowerCase().trim());
    var p = repoProblems[k];
    if (p && p.id != null) repoIds.add(Number(p.id));
  });

  var allSlugs = Object.keys(solvedMap);
  var inRepoSlugs = [];
  var missingItems = [];

  allSlugs.forEach(function (slug) {
    var entry = solvedMap[slug];
    var normSlug = String(slug).toLowerCase().trim();
    var normTitleSlug = (entry.title || slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var numId = Number(entry.id || 0);

    var inRepo = repoNormSlugs.has(normSlug) || repoNormSlugs.has(normTitleSlug) || (numId && repoIds.has(numId));
    if (inRepo) {
      inRepoSlugs.push(slug);
      if (!forceAll) return;
    }

    var langs = Object.keys(entry.langs || {});
    if (langs.length === 0) {
      // No local code (e.g. catalog-only solved problem): queue a problem-level
      // item so executeImport can fetch the real accepted submissions. Never a placeholder.
      missingItems.push({
        id: entry.id,
        slug: entry.slug,
        title: entry.title,
        difficulty: entry.difficulty,
        tags: entry.tags || [],
        constraints: entry.constraints || [],
        code: '',
        langName: '',
        ext: '',
        runtime: '',
        memory: '',
        submissionId: '',
        timestamp: null,
        inRepo: inRepo,
        needsFetch: true
      });
      return;
    }
    langs.forEach(function (ext) {
      var l = entry.langs[ext];
      missingItems.push({
        id: entry.id,
        slug: entry.slug,
        title: entry.title,
        difficulty: entry.difficulty,
        tags: entry.tags || [],
        constraints: entry.constraints || [],
        code: l.code || '',
        langName: l.lang || langForExt(ext),
        ext: ext,
        runtime: l.runtime || 'N/A',
        memory: l.memory || 'N/A',
        submissionId: l.submissionId || '',
        timestamp: l.timestamp || Date.now(),
        inRepo: inRepo
      });
    });
  });

  var repoOnlyCount = Object.keys(repoProblems).filter(function (k) { return !solvedMap[k]; }).length;
  var tDiffMs = Date.now() - tDiff0;
  var missingProblemCount = allSlugs.length - inRepoSlugs.length;
  var missingSlugsSet = {};
  missingItems.forEach(function (it) { missingSlugsSet[it.slug] = true; });
  var missingUniqueProblems = Object.keys(missingSlugsSet).length;
  await appendLog('INFO', 'Scan timing: diff in ' + tDiffMs + 'ms - ' + inRepoSlugs.length + ' in repo, ' + missingProblemCount + ' missing problems (' + missingItems.length + ' language items, ' + missingUniqueProblems + ' unique), ' + repoOnlyCount + ' repo-only.');
  await appendLog('INFO', 'Scan timing: total ' + (Date.now() - tStart) + 'ms (README ' + tReadmeMs + 'ms, tree ' + tTreeMs + 'ms, diff ' + tDiffMs + 'ms, mode: ' + scanMode + ').');

  var res = {
    ok: true,
    totalSolved: allSlugs.length,
    inRepoCount: inRepoSlugs.length,
    missingCount: Math.max(0, allSlugs.length - inRepoSlugs.length),
    missingItems: missingItems,
    repoProblems: repoProblems,
    unrecognizedCount: repoOnlyCount,
    totalFiles: entries.length,
    forced: !!forceAll,
    scanMode: scanMode,
    readmeProblems: readmeProblems
  };

  try {
    if (!forceAll) {
      await api.storage.local.set({
        lastScanResults: {
          totalSolved: res.totalSolved,
          inRepoCount: res.inRepoCount,
          missingCount: res.missingCount,
          readmeProblems: res.readmeProblems,
          scanMode: res.scanMode,
          timestamp: Date.now()
        },
        repoIndex: { problems: repoProblems, timestamp: Date.now() }
      });
      fillMissingTags(repoProblems, s).catch(function () {});
    }
  } catch (e) {}

  return res;
}

async function fetchUserRepos(customSettings) {
  var st = await getState();
  var s = Object.assign({}, DEFAULTS, st.settings || {}, customSettings || {});
  if (!s.token) throw new Error('GitHub token missing. Authorize GitHub first.');

  var allRepos = [];
  var page = 1;
  var maxPages = 5;

  while (page <= maxPages) {
    var res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated&page=' + page, {
      cache: 'no-store',
      headers: {
        'Authorization': 'Bearer ' + s.token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'LeetSync'
      }
    });

    if (!res.ok) throw new Error('GitHub API HTTP ' + res.status);
    var list = await res.json();
    if (!Array.isArray(list) || !list.length) break;

    list.forEach(function (r) {
      allRepos.push({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch || 'main',
        updated_at: r.updated_at
      });
    });

    if (list.length < 100) break;
    page++;
  }

  return { ok: true, repos: allRepos };
}

async function createRepoOnGithub(repoName, customSettings, isPrivate) {
  var st = await getState();
  var s = Object.assign({}, DEFAULTS, st.settings || {}, customSettings || {});
  if (!s.token) throw new Error('GitHub token missing. Authorize GitHub first.');
  var name = (repoName || 'leetcode-solutions').trim();
  await appendLog('INFO', 'Creating GitHub repository: ' + name + (isPrivate ? ' (private)' : ' (public)') + '...');

  var res = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Authorization': 'Bearer ' + s.token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'LeetSync'
    },
    body: JSON.stringify({
      name: name,
      description: 'Automated repository for accepted LeetCode solutions (LeetSync)',
      private: isPrivate === true,
      auto_init: true
    })
  });

  if (!res.ok) {
    var errText = await res.text();
    await appendLog('ERROR', 'Failed to create repository "' + name + '": ' + errText.slice(0, 150));
    throw new Error('Failed to create repo: ' + errText.slice(0, 150));
  }

  var data = await res.json();
  st.settings.repo = data.name;
  st.settings.branch = data.default_branch || 'main';
  if (data.owner && data.owner.login) st.settings.owner = data.owner.login;
  await api.storage.local.set({ settings: st.settings });
  await appendLog('INFO', 'Repository created: ' + data.full_name);

  return { ok: true, name: data.name, owner: st.settings.owner, branch: st.settings.branch };
}

// Fetch real accepted code from LeetCode for any queued problem that has no
// local code (one cached entry per slug). Problem-level items are expanded into
// one item per language. Never fabricates placeholder code.
async function hydrateImportItems(items, s) {
  var outcomes = {};
  var targets = {};

  items.forEach(function (it) {
    var realCode = it.code && it.code.trim() && it.code.indexOf('# Solution for ') !== 0;
    if (!outcomes[it.slug]) {
      outcomes[it.slug] = { id: it.id, title: it.title, status: realCode ? 'coded' : 'pending', langs: [], error: null, httpStatus: null, kind: null };
    }
    if (!realCode && !targets[it.slug]) targets[it.slug] = it;
  });

  var slugs = Object.keys(targets);
  if (!slugs.length) {
    Object.keys(outcomes).forEach(function (k) {
      if (outcomes[k].status === 'pending') outcomes[k].status = 'coded';
    });
    return { items: items, outcomes: outcomes, fatal: false };
  }

  var cacheData = await api.storage.local.get({ submissionCache: {} });
  var cache = cacheData.submissionCache || {};
  var fetched = {};
  var fatal = false;

  for (var i = 0; i < slugs.length; i++) {
    var slug = slugs[i];
    var it = targets[slug];
    var oc = outcomes[slug];

    if (importCancelled) { if (oc.status === 'pending') oc.status = 'skipped'; continue; }

    var langs = (cache[slug] && cache[slug].langs) ? cache[slug].langs : null;
    var fromCache = !!(langs && Object.keys(langs).length);

    if (!fromCache) {
      try {
        langs = await fetchAcceptedForProblem(slug);
      } catch (e) {
        if (e && (e.auth || e.session)) {
          oc.status = e.auth ? 'auth' : 'session';
          oc.error = e.message;
          oc.httpStatus = e.httpStatus || null;
          oc.kind = e.kind || (e.auth ? 'auth' : 'session');
          fatal = true;
          await appendLog('ERROR', e.message);
          break;
        }
        oc.status = 'fetch-failed';
        oc.error = e.message;
        oc.httpStatus = e.httpStatus || null;
        oc.kind = e.kind || 'network';
        await appendLog('WARN', 'LeetCode fetch failed for ' + (it.id || '') + '. ' + (it.title || slug) + ': ' + e.message);
        continue;
      }
      if (langs && Object.keys(langs).length) {
        cache[slug] = { langs: langs, fetchedAt: Date.now() };
      } else {
        langs = {};
      }
    }

    var keys = langs ? Object.keys(langs) : [];
    if (keys.length) {
      fetched[slug] = langs;
      oc.status = fromCache ? 'cached' : 'fetched';
      oc.langs = keys.slice();
      if (!fromCache) {
        await appendLog('INFO', 'Fetched ' + keys.length + ' language(s) for ' + (it.id || '') + '. ' + (it.title || slug));
      }
    } else {
      oc.status = 'no-accepted';
      await appendLog('WARN', 'No accepted submission found for ' + (it.id || '') + '. ' + (it.title || slug));
    }
  }

  Object.keys(outcomes).forEach(function (k) {
    if (outcomes[k].status === 'pending') outcomes[k].status = 'skipped';
  });

  try { await api.storage.local.set({ submissionCache: cache }); } catch (e) {}

  var result = [];
  var seen = {};
  items.forEach(function (it) {
    var realCode = it.code && it.code.trim() && it.code.indexOf('# Solution for ') !== 0;
    var key;
    if (realCode) {
      if (it.ext) {
        key = it.slug + '/' + it.ext;
        if (seen[key]) return;
        seen[key] = true;
      }
      result.push(it);
      return;
    }
    var langs = fetched[it.slug];
    var wroteAny = false;
    if (langs && Object.keys(langs).length) {
      Object.keys(langs).forEach(function (ext) {
        key = it.slug + '/' + ext;
        if (seen[key]) return;
        seen[key] = true;
        var l = langs[ext];
        result.push({
          id: it.id, slug: it.slug, title: it.title, difficulty: it.difficulty,
          tags: it.tags, constraints: it.constraints,
          code: l.code, langName: l.lang, ext: ext,
          runtime: l.runtime, memory: l.memory,
          submissionId: l.submissionId, timestamp: l.timestamp,
          inRepo: it.inRepo
        });
        wroteAny = true;
      });
    }
    if (!wroteAny && it.ext) {
      result.push(it);
    }
  });
  return { items: result, outcomes: outcomes, fatal: fatal };
}

function summarizeOutcomes(outcomes) {
  var counts = { coded: 0, fetched: 0, cached: 0, noAccepted: 0, fetchFailed: 0, auth: 0, session: 0, skipped: 0 };
  var reasons = { fetched: [], noAccepted: [], fetchFailed: [], auth: [], session: [], skipped: [] };
  Object.keys(outcomes || {}).forEach(function (slug) {
    var o = outcomes[slug] || {};
    var st = o.status;
    if (st === 'coded') { counts.coded++; }
    else if (st === 'fetched' || st === 'cached') {
      counts.fetched++;
      if (st === 'cached') counts.cached++;
      reasons.fetched.push({ slug: slug, id: o.id, title: o.title, langs: o.langs || [] });
    } else if (st === 'no-accepted') {
      counts.noAccepted++;
      reasons.noAccepted.push({ slug: slug, id: o.id, title: o.title });
    } else if (st === 'fetch-failed') {
      counts.fetchFailed++;
      reasons.fetchFailed.push({ slug: slug, id: o.id, title: o.title, error: o.error || '', httpStatus: o.httpStatus || null, kind: o.kind || 'other' });
    } else if (st === 'auth') {
      counts.auth++;
      reasons.auth.push({ slug: slug, id: o.id, title: o.title, error: o.error || '', httpStatus: o.httpStatus || null });
    } else if (st === 'session') {
      counts.session++;
      reasons.session.push({ slug: slug, id: o.id, title: o.title, error: o.error || '' });
    } else if (st === 'skipped') {
      counts.skipped++;
      reasons.skipped.push({ slug: slug, id: o.id, title: o.title });
    }
  });
  return { counts: counts, reasons: reasons };
}

// Decide whether an import truly finished (0 missing after a verified re-scan)
// or merely ended with a residue, plus the human-readable reason breakdown.
// Pure function so it can be unit-tested without GitHub/LeetCode.
function importCompletionState(summary, commitFailed, stillMissing, ctx) {
  summary = summary || { counts: {} };
  var counts = summary.counts || {};
  commitFailed = commitFailed || 0;
  ctx = ctx || {};
  var missing = (stillMissing == null) ? null : stillMissing;

  if (ctx.aborted) {
    return { finished: false, state: 'aborted', message: 'Import ABORTED after ' + (ctx.processed || 0) + '/' + (ctx.total || 0) + ' problem(s): ' + ((ctx.aborted && ctx.aborted.error) || 'unknown error') };
  }
  if (ctx.cancelled) {
    return { finished: false, state: 'cancelled', message: 'Import stopped (cancelled) after ' + (ctx.processed || 0) + '/' + (ctx.total || 0) + ' problem(s) - not all batches were processed.' };
  }
  if (missing === 0) {
    return {
      finished: true,
      state: 'finished',
      message: 'Import finished: ' + (ctx.committed || 0) + ' committed, 0 missing (verified by re-scan' + (ctx.inRepoNow != null ? ', ' + ctx.inRepoNow + ' in repo' : '') + ').'
    };
  }

  var reasonBits = [];
  if (counts.noAccepted) reasonBits.push(counts.noAccepted + ' no accepted submission');
  if (counts.fetchFailed) reasonBits.push(counts.fetchFailed + ' fetch-failed');
  if (counts.auth) reasonBits.push(counts.auth + ' auth (401/403)');
  if (counts.session) reasonBits.push(counts.session + ' expired session');
  if (counts.skipped) reasonBits.push(counts.skipped + ' skipped');
  if (commitFailed) reasonBits.push(commitFailed + ' commit failures');
  if (ctx.notQueued) reasonBits.push(ctx.notQueued + ' not queued');
  if (ctx.extraReasons && ctx.extraReasons.length) {
    ctx.extraReasons.forEach(function (r) { if (r) reasonBits.push(r); });
  }
  if (!reasonBits.length) reasonBits.push('not in the queued list / no local code');

  return {
    finished: false,
    state: 'ended',
    missing: missing,
    reasons: reasonBits,
    message: 'Import ended: ' + (ctx.committed || 0) + ' committed, ' + (missing == null ? 'some' : missing) + ' still missing (reasons: ' + reasonBits.join(', ') + ').'
  };
}

async function persistImportOutcomes(s, scan, runInfo) {
  var summary = Object.assign({
    committed: 0,
    totalProblems: 0,
    failed: 0,
    noAcceptedCount: 0,
    counts: {},
    reasons: {},
    batches: [],
    aborted: null,
    totalSolved: (scan && scan.totalSolved != null) ? scan.totalSolved : null,
    inRepoCount: (scan && scan.inRepoCount != null) ? scan.inRepoCount : null,
    missingCount: (scan && scan.missingCount != null) ? scan.missingCount : null,
    timestamp: Date.now()
  }, runInfo || {});
  summary.noAcceptedCount = (summary.counts && summary.counts.noAccepted) || 0;
  // Bound the slugs stored so storage stays small.
  if (summary.reasons) {
    ['fetched', 'noAccepted', 'fetchFailed', 'auth', 'session', 'skipped'].forEach(function (k) {
      if (Array.isArray(summary.reasons[k])) summary.reasons[k] = summary.reasons[k].slice(0, 400);
    });
  }
  try { await api.storage.local.set({ lastImport: summary, importOutcomes: summary }); } catch (e) {}
  return summary;
}

// Commit ONLY README.md using the Git Trees API (no base64 needed). No-op when
// the tree is unchanged. Used to regenerate the root README from the real repo.
async function commitRootReadme(s, repoProblems, ctx) {
  if (s.maintainRootReadme === false) return { committed: false, skipped: true };
  try {
    var headSha = (ctx && ctx.headSha) || null;
    var baseTree = (ctx && ctx.headSha) ? ctx.baseTree : '';
    if (!headSha) {
      var h = await ghHead(s);
      headSha = h.headSha;
      baseTree = h.baseTree;
    }
    var readme = rootReadme(repoProblems, s);
    var entries = [{ path: 'README.md', mode: '100644', type: 'blob', content: readme }];
    var treeBody = { tree: entries };
    if (baseTree) treeBody.base_tree = baseTree;
    var tree = await gh(s, '/git/trees', { method: 'POST', body: JSON.stringify(treeBody) });
    if (baseTree && tree.sha === baseTree) return { committed: false, changed: false };
    var commit = await gh(s, '/git/commits', {
      method: 'POST', body: JSON.stringify({ message: 'Regenerate root README (LeetSync)', tree: tree.sha, parents: [headSha] })
    });
    try {
      await updateRef(s, commit.sha);
    } catch (e422) {
      if (e422 && e422.status === 422) {
        var h2 = await ghHead(s);
        var treeBody2 = { tree: entries };
        if (h2.baseTree) treeBody2.base_tree = h2.baseTree;
        var tree2 = await gh(s, '/git/trees', { method: 'POST', body: JSON.stringify(treeBody2) });
        if (h2.baseTree && tree2.sha === h2.baseTree) return { committed: false, changed: false };
        commit = await gh(s, '/git/commits', {
          method: 'POST', body: JSON.stringify({ message: 'Regenerate root README (LeetSync)', tree: tree2.sha, parents: [h2.headSha] })
        });
        await updateRef(s, commit.sha);
      } else {
        throw e422;
      }
    }
    await verifyHead(s, commit.sha);
    if (ctx) { ctx.headSha = commit.sha; ctx.baseTree = tree.sha; }
    return { committed: true, sha: commit.sha };
  } catch (e) {
    await appendLog('WARN', 'Root README regeneration failed: ' + e.message);
    return { committed: false, error: e.message };
  }
}

// Re-scan the repo FRESH (no-store, bypassing the coalescing cache) to verify
// completion, then regenerate the root README from the problems that actually
// exist on disk. When the last import batch already wrote an up-to-date README,
// the standalone README commit is skipped (folded into the batch).
async function postImportVerifyAndReadme(s, opts) {
  opts = opts || {};
  var fresh = null;
  try {
    fresh = await scanRepoInventory(s, false, true);
  } catch (e) {
    await appendLog('WARN', 'Post-import re-scan failed: ' + e.message);
  }
  if (!opts.skipReadme) {
    try {
      var repoProblems = (fresh && fresh.repoProblems) || (await loadRepoIndex()) || {};
      await commitRootReadme(s, repoProblems, opts.ctx);
    } catch (e) {}
  }
  return fresh;
}

async function executeImport(options) {
  if (importRunning) return { ok: false, message: 'Import already running' };
  importRunning = true;
  importCancelled = false;
  options = options || {};
  var forceOverwrite = options.forceOverwrite === true;

  try {
    var st = await getState();
    var s = Object.assign({}, st.settings, options);
    var scan = await scanRepoInventory(s, forceOverwrite);
    var itemsToImport = scan.missingItems || [];

    if (scan.scanMode === 'new-repo') {
      var initRes = await ensureRepoInitialized(s);
      if (initRes.created) {
        await appendLog('INFO', 'Brand-new repository detected - initialized with root README on "' + s.branch + '". Resuming import with Git Trees API.');
      }
    }

    if (forceOverwrite) {
      var protectedCount = 0;
      itemsToImport = itemsToImport.filter(function (it) {
        var realCode = it.code && it.code.trim() && it.code.indexOf('# Solution for ') !== 0;
        var fetchableId = it.submissionId && String(it.submissionId).length > 0 && !String(it.submissionId).startsWith('catalog-');
        if (it.inRepo && !realCode && !fetchableId) {
          protectedCount++;
          return false;
        }
        return true;
      });
      if (protectedCount > 0) {
        await appendLog('WARN', 'Force import: kept existing repo files for ' + protectedCount + ' problem(s) with no real code in local history.');
      }
      await appendLog('INFO', 'Force overwrite enabled: queueing ' + itemsToImport.length + ' problem(s) for full re-import (including ' + scan.inRepoCount + ' already in repo).');
    } else if (options.skipExisting === false) {
      itemsToImport = [];
      Object.keys(st.solved || {}).forEach(function (slug) {
        var entry = st.solved[slug];
        var langs = Object.keys(entry.langs || {});
        langs.forEach(function (ext) {
          var l = entry.langs[ext];
          itemsToImport.push({
            id: entry.id,
            slug: entry.slug,
            title: entry.title,
            difficulty: entry.difficulty,
            tags: entry.tags || [],
            constraints: entry.constraints || [],
            code: l.code || '',
            langName: l.lang,
            ext: ext,
            runtime: l.runtime,
            memory: l.memory,
            submissionId: l.submissionId,
            timestamp: l.timestamp
          });
        });
      });
    }

    if (!itemsToImport.length) {
      if (forceOverwrite) {
        await appendLog('WARN', 'Force import: nothing to write - all ' + scan.totalSolved + ' problem(s) are protected or already current.');
        return { ok: true, imported: 0, message: 'Nothing to overwrite - all files already current.' };
      }
      await appendLog('INFO', 'All ' + scan.totalSolved + ' problems are already in your repository. Zero duplicates created!');
      return { ok: true, imported: 0, message: 'All problems already in repository.' };
    }

    // Group the queued items by problem (slug), preserving first-seen order.
    var problemOrder = [];
    var itemsBySlug = {};
    itemsToImport.forEach(function (it) {
      if (!itemsBySlug[it.slug]) { itemsBySlug[it.slug] = []; problemOrder.push(it.slug); }
      itemsBySlug[it.slug].push(it);
    });

    // "Retry missing" mode: only the requested slugs, and force-refetch them.
    if (options.retrySlugs && options.retrySlugs.length) {
      var want = {};
      options.retrySlugs.forEach(function (sl) { want[sl] = true; });
      problemOrder = problemOrder.filter(function (sl) { return want[sl]; });
      try {
        var cd = await api.storage.local.get({ submissionCache: {} });
        var cc = cd.submissionCache || {};
        problemOrder.forEach(function (sl) { delete cc[sl]; });
        await api.storage.local.set({ submissionCache: cc });
      } catch (e) {}
      await appendLog('INFO', 'Retry requested for ' + problemOrder.length + ' problem(s) (fetch-failed / auth): ' + problemOrder.slice(0, 20).join(', ') + (problemOrder.length > 20 ? '…' : ''));
      if (!problemOrder.length) {
        await appendLog('WARN', 'Retry: none of the requested problems were found in the current scan.');
        return { ok: true, imported: 0, message: 'Nothing to retry.' };
      }
    }

    var totalProblems = problemOrder.length;
    var batchSize = s.batchSize || 20;
    var totalBatches = Math.ceil(totalProblems / batchSize);
    var processedProblems = 0;
    var committedCount = 0;
    var commitFailedCount = 0;
    var commitsList = [];
    var outcomesAll = {};
    var batchesReport = [];
    var abortedInfo = null;
    var cancelledImport = false;

    currentImportStatus = {
      running: true,
      imported: 0,
      total: totalProblems,
      pct: 0,
      skipped: 0,
      failed: 0,
      currentProblem: '',
      currentBatch: 0,
      totalBatches: totalBatches,
      forceOverwrite: forceOverwrite,
      retry: !!(options.retrySlugs && options.retrySlugs.length),
      commits: []
    };
    await api.storage.local.set({ importStatus: currentImportStatus });

    await appendLog('INFO', '🚀 Starting import of ' + totalProblems + ' problem(s) in ' + totalBatches + ' batch(es)...');

    var importState = { settings: s, solved: st.solved, queue: st.queue, repoProblems: Object.assign({}, scan.repoProblems || {}) };

    // In-memory head chaining for this import: batch N+1 builds on the commit
    // sha (and tree) batch N just created. We never re-read the ref mid-import,
    // so a stale/cached ref can no longer clobber earlier batches.
    var commitCtx = {};
    var pendingHyd = null;
    var lastCommittedReadme = false;

    for (var b = 0; b < totalBatches; b++) {
      if (importCancelled) {
        cancelledImport = true;
        await appendLog('WARN', 'Import was paused or cancelled by user.');
        break;
      }

      var batchSlugs = problemOrder.slice(b * batchSize, (b + 1) * batchSize);
      var batchItems = [];
      batchSlugs.forEach(function (sl) { batchItems = batchItems.concat(itemsBySlug[sl] || []); });

      currentImportStatus.currentBatch = b + 1;
      await api.storage.local.set({ importStatus: currentImportStatus });
      await appendLog('INFO', '📦 Batch ' + (b + 1) + '/' + totalBatches + ' starting (' + batchSlugs.length + ' problems)...');

      // Smooth progress ticks while the batch is processed.
      for (var idx = 0; idx < batchSlugs.length; idx++) {
        if (importCancelled) break;
        var currentItem = itemsBySlug[batchSlugs[idx]][0] || { id: '', title: batchSlugs[idx] };
        currentImportStatus.currentProblem = currentItem.id + '. ' + currentItem.title;
        currentImportStatus.pct = Math.round(((processedProblems + idx) / totalProblems) * 100);
        await api.storage.local.set({ importStatus: currentImportStatus });
        if (api.runtime && api.runtime.sendMessage) {
          try { api.runtime.sendMessage({ type: 'importTick', status: currentImportStatus }).catch(function () {}); } catch (e) {}
        }
        await sleep(20);
      }

      // 1) Resolve real code for this batch. The LeetCode fetch for this batch
      //    was already started one iteration ago (one batch ahead), so the repo
      //    head is not held open while we wait 5-10s for LeetCode.
      var hyd = (b === 0) ? await hydrateImportItems(batchItems, s) : await pendingHyd;
      pendingHyd = null;
      batchSlugs.forEach(function (sl) { if (hyd.outcomes[sl]) outcomesAll[sl] = hyd.outcomes[sl]; });

      // Kick off the NEXT batch's code fetch now so it overlaps with this
      // batch's GitHub commit (LeetCode and GitHub are different hosts).
      if (b + 1 < totalBatches) {
        var nextSlugs = problemOrder.slice((b + 1) * batchSize, (b + 2) * batchSize);
        var nextItems = [];
        nextSlugs.forEach(function (sl) { nextItems = nextItems.concat(itemsBySlug[sl] || []); });
        pendingHyd = hydrateImportItems(nextItems, s);
      }

      var bc = { fetched: 0, noAccepted: 0, auth: 0, session: 0, skipped: 0, failed: 0, h429: 0, h403: 0, other: 0 };
      batchSlugs.forEach(function (sl) {
        var o = hyd.outcomes[sl];
        if (!o) return;
        if (o.status === 'coded' || o.status === 'fetched' || o.status === 'cached') bc.fetched++;
        else if (o.status === 'no-accepted') bc.noAccepted++;
        else if (o.status === 'skipped') bc.skipped++;
        else {
          bc.failed++;
          if (o.httpStatus === 429) bc.h429++;
          else if (o.httpStatus === 401 || o.httpStatus === 403) bc.h403++;
          else bc.other++;
          if (o.status === 'auth') bc.auth++;
          if (o.status === 'session') bc.session++;
        }
      });

      // 2) Commit the writable items of this batch (with GitHub rate-limit retry).
      var success = (hyd.items.length === 0);
      var attempts = 0;
      var maxAttempts = 3;
      var lastErr = null;
      var written = 0;
      var batchNoChanges = false;
      var commitSha = 'commit';

      while (attempts < maxAttempts && !success && !importCancelled) {
        attempts++;
        try {
          var commitRes = await commitBatch(importState, hyd.items, commitCtx);
          var timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          written = (commitRes && commitRes.written) || 0;
          var skipped = (commitRes && commitRes.skipped) || 0;
          batchNoChanges = !!(commitRes && commitRes.committed === false);
          commitSha = (commitRes && commitRes.sha) ? commitRes.sha.slice(0, 7) : 'commit';

          hyd.items.forEach(function (it) { applyItem(importState.solved, it); });
          committedCount += written;
          if (written === 0) {
            currentImportStatus.skipped = (currentImportStatus.skipped || 0) + skipped;
            commitsList.unshift({ text: 'Batch ' + (b + 1) + ': ' + skipped + ' skipped (no code), 0 committed', time: timeStr });
          } else if (batchNoChanges) {
            commitsList.unshift({ text: 'Batch ' + (b + 1) + ' already identical (no commit needed)', time: timeStr });
          } else {
            commitsList.unshift({ text: 'Batch ' + (b + 1) + ' committed (' + written + ' problems, sha: ' + commitSha + ')', time: timeStr });
          }
          currentImportStatus.commits = commitsList;
          await api.storage.local.set({ solved: importState.solved, importStatus: currentImportStatus, lastSync: Date.now() });
          // If this batch actually committed, its tree already includes an
          // up-to-date root README, so the final standalone README commit can be
          // folded into it (fewer commits).
          lastCommittedReadme = !batchNoChanges && written > 0 && s.maintainRootReadme !== false;
          success = true;
        } catch (err) {
          lastErr = err;
          await appendLog('WARN', 'Batch ' + (b + 1) + ' commit attempt ' + attempts + ' failed: ' + err.message);
          if (err instanceof RateLimitError) {
            var waitSec = Math.ceil((err.waitMs || 60000) / 1000);
            await appendLog('WARN', 'GitHub rate limit hit. Waiting ' + waitSec + 's before retrying batch ' + (b + 1) + '...');
            await sleep(err.waitMs || 60000);
          } else if (attempts < maxAttempts) {
            await sleep(1500);
          }
        }
      }

      if (!success && !importCancelled) {
        commitFailedCount += hyd.items.length;
        currentImportStatus.failed = (currentImportStatus.failed || 0) + hyd.items.length;
        await appendLog('ERROR', 'Batch ' + (b + 1) + ' commit failed after ' + maxAttempts + ' attempts: ' + ((lastErr && lastErr.message) || 'Unknown error') + '. Continuing.');
      }

      processedProblems += batchSlugs.length;
      currentImportStatus.imported = processedProblems;
      currentImportStatus.pct = Math.round((processedProblems / totalProblems) * 100);
      await api.storage.local.set({ importStatus: currentImportStatus });

      // One line per batch reporting the REAL reason per problem.
      var batchLine = 'Batch ' + (b + 1) + '/' + totalBatches + ': ' + batchSlugs.length + ' problems - ' +
        bc.fetched + ' fetched, ' + bc.noAccepted + ' no accepted, ' + bc.failed + ' failed (' +
        '429: ' + bc.h429 + ', 403: ' + bc.h403 + ', other: ' + bc.other + ')' +
        (success ? '' : ' - COMMIT FAILED');
      var batchLevel = !success ? 'ERROR' : ((bc.failed || bc.noAccepted || bc.skipped) ? 'WARN' : 'INFO');
      await appendLog(batchLevel, batchLine);
      batchesReport.push({
        n: b + 1, total: totalBatches, problems: batchSlugs.length,
        fetched: bc.fetched, noAccepted: bc.noAccepted, failed: bc.failed,
        h429: bc.h429, h403: bc.h403, other: bc.other,
        committed: written
      });

      if (hyd.fatal) {
        var fatalSlug = null, fatalStatus = null, fatalError = null;
        batchSlugs.some(function (sl) {
          var o = hyd.outcomes[sl];
          if (o && (o.status === 'auth' || o.status === 'session')) { fatalSlug = sl; fatalStatus = o.status; fatalError = o.error; return true; }
          return false;
        });
        abortedInfo = { status: fatalStatus || 'auth', slug: fatalSlug, error: fatalError || 'LeetCode session/auth failed.' };
        await appendLog('ERROR', 'Import stopped before finishing: ' + abortedInfo.error);
        break;
      }

      if (b + 1 < totalBatches) await sleep(600);
    }

    var summary = summarizeOutcomes(outcomesAll);
    var failedTotal = summary.counts.fetchFailed + summary.counts.auth + summary.counts.session + commitFailedCount;
    currentImportStatus.running = false;
    currentImportStatus.pct = (abortedInfo || cancelledImport) ? currentImportStatus.pct : 100;
    currentImportStatus.imported = processedProblems;
    currentImportStatus.aborted = (abortedInfo || cancelledImport) ? true : false;
    await api.storage.local.set({ importStatus: currentImportStatus });

    // Re-scan the repo FRESH (no-store) to VERIFY completion. If the last batch
    // already wrote an up-to-date root README, it is folded into that batch and
    // no separate README commit is made.
    var postScan = await postImportVerifyAndReadme(s, { skipReadme: lastCommittedReadme, ctx: commitCtx });
    var stillMissing = (postScan && postScan.missingCount != null) ? postScan.missingCount : Math.max(0, totalProblems - processedProblems);
    var inRepoNow = (postScan && postScan.inRepoCount != null) ? postScan.inRepoCount : null;
    currentImportStatus.stillMissing = stillMissing;
    await api.storage.local.set({ importStatus: currentImportStatus });

    // Real per-problem reasons for anything the fresh scan still shows missing.
    var stillMissingSlugs = [];
    if (postScan && postScan.missingItems) {
      var seenMissing = {};
      postScan.missingItems.forEach(function (it) {
        if (it && it.slug && !seenMissing[it.slug]) { seenMissing[it.slug] = true; stillMissingSlugs.push(it.slug); }
      });
    }
    var notQueuedCount = stillMissingSlugs.filter(function (sl) { return !outcomesAll[sl]; }).length;

    var completion = importCompletionState(summary, commitFailedCount, stillMissing, {
      aborted: abortedInfo, cancelled: cancelledImport, committed: committedCount,
      processed: processedProblems, total: totalProblems, inRepoNow: inRepoNow,
      notQueued: notQueuedCount
    });
    if (completion.state === 'aborted') await appendLog('ERROR', completion.message);
    else if (completion.state === 'cancelled') await appendLog('WARN', completion.message);
    else if (completion.finished) await appendLog('INFO', completion.message);
    else await appendLog('WARN', completion.message);
    if (stillMissing > 0) {
      await appendLog('WARN', 'Still missing (' + stillMissing + '): ' + stillMissingSlugs.slice(0, 25).map(function (sl) {
        var o = outcomesAll[sl];
        var why = o ? o.status : 'not-queued';
        return sl + '[' + why + ']';
      }).join(', ') + (stillMissingSlugs.length > 25 ? '…' : ''));
    }
    await persistImportOutcomes(s, scan, {
      committed: committedCount,
      commitFailed: commitFailedCount,
      totalProblems: totalProblems,
      processed: processedProblems,
      failed: failedTotal,
      stillMissing: stillMissing,
      inRepoCount: inRepoNow,
      counts: summary.counts,
      reasons: summary.reasons,
      batches: batchesReport,
      cancelled: cancelledImport,
      aborted: abortedInfo
    });
    try { await fillMissingTags(importState.repoProblems, s, true); } catch (e) {}

    return {
      ok: !abortedInfo && !cancelledImport && stillMissing === 0,
      imported: committedCount,
      committed: committedCount,
      noAccepted: summary.counts.noAccepted,
      failed: failedTotal,
      stillMissing: stillMissing,
      counts: summary.counts,
      aborted: abortedInfo,
      cancelled: cancelledImport,
      commits: commitsList
    };
  } finally {
    importRunning = false;
  }
}

async function completeOAuth(token, extra) {
  extra = extra || {};
  await appendLog('INFO', 'OAuth: token received, fetching GitHub profile...');
  const userRes = await fetch('https://api.github.com/user', {
    cache: 'no-store',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'LeetSync'
    }
  });
  const userData = userRes.ok ? await userRes.json() : null;
  const owner = (userData && userData.login) || '';

  const st = await getState();
  st.settings.token = token;
  if (owner) st.settings.owner = owner;
  if (extra.refreshToken) st.settings.refreshToken = extra.refreshToken;
  if (extra.expiresAt) st.settings.tokenExpiresAt = extra.expiresAt;

  try {
    const repoRes = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
      cache: 'no-store',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'LeetSync' }
    });
    if (repoRes.ok) {
      const userRepos = await repoRes.json();
      const matchingRepo = userRepos.find(r => {
        const n = (r.name || '').toLowerCase();
        return n === 'leetcode' || n === 'leetcode-solutions' || n === 'leet-work' || n === 'leethub';
      });
      if (matchingRepo) {
        st.settings.repo = matchingRepo.name;
        st.settings.branch = matchingRepo.default_branch || 'main';
      } else if (!st.settings.repo) {
        st.settings.repo = 'leetcode-solutions';
      }
    }
  } catch (repoErr) {}

  await api.storage.local.set({ settings: st.settings, lastError: null, oauthState: '' });
  await appendLog('INFO', 'Connected to GitHub account: @' + owner + ' (Repo: ' + st.settings.repo + ')');
  await api.storage.session.remove('oauthLock');
  return { ok: true, user: owner };
}

if (api) {
  api.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    try {
      if (msg.type === 'submission') { await enqueue(msg.payload); sendResponse({ok:true}); return true; }
      if (msg.type === 'checkLeetCode') { sendResponse(await checkLeetCodeSession()); return true; }
      if (msg.type === 'syncCatalog') { sendResponse(await syncCatalog()); return true; }
      if (msg.type === 'syncNow') {
        try { await fetchLeetCodeSubmissions(); const scan = await scanRepoInventory(); if (scan && scan.missingItems && scan.missingItems.length > 0) { await appendLog("INFO","Found "+scan.missingItems.length+" unsynced problem(s). Enqueuing..."); for (let i=0;i<scan.missingItems.length;i++) await enqueue(scan.missingItems[i]); } } catch (e) { console.warn("[LeetSync syncNow]",e); }
        processQueue(); sendResponse({started:true}); return true;
      }
      if (msg.type === 'getState') { sendResponse(await getState()); return true; }
      if (msg.type === 'getLogs') { const d=await api.storage.local.get({logs:[]}); sendResponse(d.logs||[]); return true; }
      if (msg.type === 'clearLogs') { await api.storage.local.set({logs:[]}); sendResponse({ok:true}); return true; }
      if (msg.type === 'fetchLeetCode') { try{ sendResponse(await fetchLeetCodeSubmissions(null,msg.force===true)); }catch(e){ sendResponse({error:e.message}); } return true; }
      if (msg.type === 'getCatalogProgress') { const d=await api.storage.local.get({catalogProgress:submissionsProgress}); sendResponse(d.catalogProgress||submissionsProgress); return true; }
      if (msg.type === 'diagnoseSolved') { try{ sendResponse(await diagnoseSolved()); }catch(e){ sendResponse({error:e.message}); } return true; }
      if (msg.type === 'scanRepo') { try{ sendResponse(await scanRepoInventory(msg.settings,msg.forceAll)); }catch(e){ sendResponse({ok:false,error:e.status?authHint(e):e.message}); } return true; }
      if (msg.type === 'startImport') { try{ sendResponse(await executeImport(msg.options)); }catch(e){ sendResponse({ok:false,error:e.message}); } return true; }
      if (msg.type === 'getImportStatus') { if (currentImportStatus&&Object.keys(currentImportStatus).length>0){ sendResponse(currentImportStatus); return true; } const res=await api.storage.local.get("importStatus"); sendResponse(res.importStatus||currentImportStatus||{}); return true; }
      if (msg.type === 'stopImport') { importCancelled=true; sendResponse({stopped:true}); return true; }
      if (msg.type === 'retryFailedImport') { const res=await api.storage.local.get({importOutcomes:null}); const outcomes=res.importOutcomes||{}; const reasons=(outcomes&&outcomes.reasons)||{}; const slugs=[]; ["fetchFailed","auth","session"].forEach(k=>{(reasons[k]||[]).forEach(r=>{ if(r&&r.slug&&slugs.indexOf(r.slug)===-1) slugs.push(r.slug); }); }); if(!slugs.length){ sendResponse({ok:false,error:"Nothing to retry - no fetch-failed or auth problems recorded.",retrySlugs:[]}); return true; } const retryOptions=Object.assign({},msg.options||{},{retrySlugs:slugs}); try{ sendResponse(await executeImport(retryOptions)); }catch(e){ sendResponse({ok:false,error:e.message}); } return true; }
      if (msg.type === 'getUserRepos') { try{ sendResponse(await fetchUserRepos(msg.settings)); }catch(e){ sendResponse({ok:false,error:e.message,repos:[]}); } return true; }
      if (msg.type === 'createRepo') { try{ sendResponse(await createRepoOnGithub(msg.name||msg.repoName,msg.settings,msg.private)); }catch(e){ sendResponse({ok:false,error:e.message}); } return true; }
      if (msg.type === 'checkRepo') { try{ sendResponse(await checkRepo(msg.settings)); }catch(e){ sendResponse({ok:false,error:e.status?authHint(e):e.message}); } return true; }
      if (msg.type === 'testConnection') { try{ sendResponse(await testConnection(msg.settings)); }catch(e){ sendResponse({ok:false,error:e.status?authHint(e):e.message}); } return true; }
      if (msg.type === 'startGithubOAuth') { sendResponse(await (async function(){ const lock=await getOAuthLock(); if(lock&&Date.now()-lock<30000){ return {ok:false,error:"Login already in progress"}; } await api.storage.session.set({oauthLock:Date.now()}); try{ const nonce=crypto.randomUUID(); const redirectUrl=getOAuthRedirectUri(); const state=encodeState(nonce,redirectUrl); await api.storage.local.set({oauthState:state}); await appendLog("INFO","OAuth: extension redirect target = "+redirectUrl); if(api.identity&&api.identity.launchWebAuthFlow){ try{ const authUrl="https://github.com/login/oauth/authorize?client_id="+GITHUB_CLIENT_ID+"&scope=repo&redirect_uri="+encodeURIComponent(redirectUrl)+"&state="+encodeURIComponent(state); await appendLog("INFO","OAuth: launching GitHub authorization popup..."); const authResultUrl=await api.identity.launchWebAuthFlow({url:authUrl,interactive:true}); const paramStr=(authResultUrl.split("#")[1]||authResultUrl.split("?")[1])||""; const params=new URLSearchParams(paramStr); const code=params.get("code"); const returnedState=params.get("state"); const error=params.get("error"); const errorDesc=params.get("error_description"); if(error){ throw new Error("GitHub authorization failed: "+error+(errorDesc?" - "+decodeURIComponent(errorDesc):"")); } const storedState=(await api.storage.local.get({oauthState:""})).oauthState; if(!returnedState||returnedState!==storedState){ throw new Error("OAuth state mismatch (CSRF check failed)"); } try{ const returnedData=JSON.parse(atob(returnedState)); if(returnedData.n!==nonce) throw new Error("Nonce mismatch"); }catch(parseErr){ if(parseErr.message==="Nonce mismatch") throw parseErr; } if(!code){ throw new Error("No authorization code in OAuth response"); } await appendLog("INFO","OAuth: code received, exchanging via Worker /token..."); const tokenRes=await fetch(OAUTH_WORKER_URL+"/token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:code,state:state})}); let tokenData=null; try{ tokenData=await tokenRes.json(); }catch(e){} if(!tokenRes.ok||!tokenData||!tokenData.access_token){ const why=(tokenData&&(tokenData.error_description||tokenData.error))||("HTTP "+tokenRes.status); throw new Error("Worker token exchange failed: "+(why||"unknown error")); } const extra={}; if(tokenData.refresh_token) extra.refreshToken=tokenData.refresh_token; if(tokenData.expires_in) extra.expiresAt=Date.now()+parseInt(tokenData.expires_in,10)*1000; return await completeOAuth(tokenData.access_token,extra); }catch(flowErr){ if(flowErr&&flowErr.message&&flowErr.message.indexOf("user cancel")!==-1){ await appendLog("INFO","OAuth cancelled by user."); await api.storage.session.remove("oauthLock"); return {ok:false,error:"cancelled",cancelled:true}; } throw flowErr; } } throw new Error("identity.launchWebAuthFlow is not available in this browser"); }catch(err){ await appendLog("ERROR","OAuth error: "+err.message); await api.storage.session.remove("oauthLock"); return {ok:false,error:err.message}; } })()); return true; }
      if (msg.type === 'disconnectGithub') { try{ var st=await getState(); st.settings.token=""; st.settings.owner=""; await api.storage.local.set({settings:st.settings,lastError:null}); await appendLog("INFO","Disconnected GitHub account."); sendResponse({ok:true}); }catch(e){ sendResponse({ok:false,error:e.message}); } return true; }
      if (msg.type === 'openOptions') { if(api.runtime&&api.runtime.openOptionsPage){ try{ await api.runtime.openOptionsPage(); }catch(e){} sendResponse({ok:true}); return true; } if(api.tabs&&api.tabs.create){ api.tabs.create({url:api.runtime.getURL("options.html")}); sendResponse({ok:true}); return true; } sendResponse({ok:false}); return true; }
      sendResponse({ok:false,error:"unknown message type"}); return true;
    } catch (e) { sendResponse({ok:false,error:e.message}); return true; }
  });

  async function setupAlarms() {
    if (!api || !api.alarms) return;
    try {
      const st = await getState();
      const s = st.settings;
      if (s.periodicSync) {
        api.alarms.create('leetsync-periodic', { periodInMinutes: Math.max(1, Number(s.syncInterval) || 15) });
      } else {
        api.alarms.clear('leetsync-periodic');
      }
    } catch (e) {}
  }

  if (api.alarms) {
    api.alarms.onAlarm.addListener(function (alarm) {
      if (alarm.name === 'leetsync-periodic') {
        processQueue();
      }
    });
  }

  api.runtime.onStartup.addListener(function () {
    appendLog('INFO', 'Browser started - resuming queue and catalog sync.');
    processQueue();
    setupAlarms();
    syncCatalog();
  });
  appendLog('INFO', 'LeetSync background started.');
  setupAlarms();
  processQueue(); // resume anything left in the queue (checkpoint recovery)
  syncCatalog(); // auto-sync question catalog from LeetCode on startup

  // Listen for storage changes from other contexts (popup/options)
  api.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && changes.settings) {
      // Settings changed, could notify content script if needed
    }
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    commitBatch: commitBatch,
    problemReadme: problemReadme,
    rootReadme: rootReadme,
    applyItem: applyItem,
    gh: gh,
    RateLimitError: RateLimitError,
    buildSolvedFromRepo: buildSolvedFromRepo,
    langForExt: langForExt,
    isCodeFileExt: isCodeFileExt,
    matchProblemByName: matchProblemByName,
    fetchProblemTags: fetchProblemTags,
    fillMissingTags: fillMissingTags,
    fetchAcceptedForProblem: fetchAcceptedForProblem,
    fetchSubmissionDetail: fetchSubmissionDetail,
    hydrateImportItems: hydrateImportItems,
    commitTopicsUpdate: commitTopicsUpdate,
    extForLangSlug: extForLangSlug,
    isAcceptedSubmission: isAcceptedSubmission,
    summarizeOutcomes: summarizeOutcomes,
    reconcileSolved: reconcileSolved,
    importCompletionState: importCompletionState,
    _setLeetPaceMs: function (ms) { LEET_PACE_MS = ms; }
  };
} else {
  // Debug hook for the extension service-worker console:
  //   diagnoseSolved().then(console.log)
  try { self.diagnoseSolved = diagnoseSolved; } catch (e) {}
}
