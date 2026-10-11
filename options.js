// LeetSync Settings Page Logic
var $ = function (id) { return document.getElementById(id); };

const api = globalThis.browser ?? globalThis.chrome ?? null;

// Listen for storage changes (e.g., token set after OAuth in popup, or theme updated)
if (api && api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.settings) {
        const newSettings = changes.settings.newValue;
        updateAuthUI(newSettings.token, newSettings.owner);
        loadUserRepos();
      }
      if (changes.userTheme && changes.userTheme.newValue) {
        applyThemeInOptions(changes.userTheme.newValue);
      }
      if (changes.userAccent && changes.userAccent.newValue) {
        applyAccentInOptions(changes.userAccent.newValue);
      }
    }
  });
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
  commitTemplate: 'Add {id}. {title} ({lang})',
  generateProblemReadme: true,
  maintainRootReadme: true,
  includeTopicIndex: true,
  periodicSync: true,
  syncInterval: 15,
  realtimeSync: true,
  overwriteExisting: false
};

// Safe storage access (handles direct file:// viewing without throwing errors)
var storage = {
  get: function (defaults) {
    if (api && api.storage && api.storage.local) {
      return api.storage.local.get(defaults);
    }
    return new Promise(function (resolve) {
      try {
        var raw = localStorage.getItem('leetsync_settings');
        var obj = raw ? JSON.parse(raw) : {};
        resolve(Object.assign({}, defaults, obj));
      } catch (e) {
        resolve(defaults);
      }
    });
  },
  set: function (data) {
    if (api && api.storage && api.storage.local) {
      return api.storage.local.set(data);
    }
    return new Promise(function (resolve) {
      try {
        localStorage.setItem('leetsync_settings', JSON.stringify(data));
      } catch (e) {}
      resolve();
    });
  }
};

function readSettings() {
  return {
    token: $('token') ? $('token').value.trim() : '',
    owner: $('owner') ? $('owner').value.trim() : '',
    repo: $('repo') ? $('repo').value.trim() : '',
    branch: $('branch') ? ($('branch').value.trim() || 'main') : 'main',
    baseFolder: $('base-folder') ? $('base-folder').value.trim() : 'LeetCode',
    folderOrg: $('folder-org') ? $('folder-org').value : 'difficulty',
    customFolderTemplate: $('custom-folder-template') ? ($('custom-folder-template').value.trim() || '{difficulty}/{padded_id}-{slug}') : '{difficulty}/{padded_id}-{slug}',
    fileBaseName: $('file-base-name') ? ($('file-base-name').value.trim() || 'solution') : 'solution',
    commitTemplate: $('commit-template') ? ($('commit-template').value.trim() || 'Add {id}. {title} ({lang})') : 'Add {id}. {title} ({lang})',
    generateProblemReadme: $('gen-readme') ? $('gen-readme').checked : true,
    maintainRootReadme: $('maintain-root-readme') ? $('maintain-root-readme').checked : true,
    includeTopicIndex: $('include-topic-index') ? $('include-topic-index').checked : true,
    periodicSync: $('periodic-sync') ? $('periodic-sync').checked : true,
    syncInterval: $('sync-interval') ? (Number($('sync-interval').value) || 15) : 15,
    realtimeSync: $('realtime-sync') ? $('realtime-sync').checked : true,
    overwriteExisting: $('overwrite-existing') ? $('overwrite-existing').checked : false
  };
}

var toastTimer = null;
function showToast(msg, isOk) {
  var toast = $('toast');
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = isOk ? 'toast-alert ok' : 'toast-alert err';
  toast.style.display = 'block';
  toast.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  toastTimer = setTimeout(function () {
    toast.style.display = 'none';
  }, 7000);
}

// -------------------------------------------------------------
// 1. LeetCode Session Checker
// -------------------------------------------------------------
function checkLeetCodeStatus() {
  var dot = $('lc-status-dot');
  var text = $('lc-status-text');
  var sub = $('lc-status-sub');
  if (!dot || !text) return;

  dot.style.backgroundColor = '#f59e0b';
  text.textContent = 'Checking LeetCode login status...';
  text.style.color = '#f59e0b';

  if (!api || !api.runtime) {
    text.textContent = 'Active (browser extension mode)';
    dot.style.backgroundColor = '#10b981';
    text.style.color = '#10b981';
    return;
  }

  api.runtime.sendMessage({ type: 'checkLeetCode' }).then(function (res) {
    if (res && res.loggedIn) {
      dot.style.backgroundColor = '#10b981';
      text.textContent = 'Connected to LeetCode' + (res.user ? ' (@' + res.user + ')' : ' (Session Active)');
      text.style.color = '#10b981';
      if (sub) sub.textContent = 'LeetCode session is active! Submissions are automatically detected and synced.';
    } else {
      dot.style.backgroundColor = '#f59e0b';
      text.textContent = 'Not Signed In to LeetCode';
      text.style.color = '#f59e0b';
      if (sub) sub.textContent = 'Please open leetcode.com in another tab and sign in, then click "⟳ Re-check".';
    }
  }).catch(function () {
    dot.style.backgroundColor = '#94a3b8';
    text.textContent = 'Could not verify LeetCode session';
    text.style.color = '#94a3b8';
  });
}

// -------------------------------------------------------------
// 2. GitHub UI & Repositories Update with Search Filter
// -------------------------------------------------------------
var cachedUserRepos = [];

function updateActiveRepoBadge() {
  var owner = $('owner') ? $('owner').value.trim() : '';
  var repo = $('repo') ? $('repo').value.trim() : '';
  var branch = $('branch') ? $('branch').value.trim() : 'main';

  var badge = $('repo-active-badge');
  var nameEl = $('repo-active-name');
  var branchEl = $('repo-active-branch');

  if (!badge || !nameEl || !branchEl) return;

  if (repo) {
    badge.style.display = 'flex';
    nameEl.textContent = (owner ? owner + '/' : '') + repo;
    branchEl.textContent = branch || 'main';
  } else {
    badge.style.display = 'none';
  }
}

function renderFilteredRepos(query) {
  var sel = $('repo-select');
  var status = $('repo-search-status');
  var badgeCount = $('badge-repo-count');
  if (!sel) return;

  var currentRepo = $('repo') ? $('repo').value.trim().toLowerCase() : '';
  var filterText = (query || '').toLowerCase().trim();

  var filtered = cachedUserRepos.filter(function (r) {
    return !filterText || r.name.toLowerCase().includes(filterText) || r.full_name.toLowerCase().includes(filterText);
  });

  if (badgeCount) badgeCount.textContent = cachedUserRepos.length + ' Repos Loaded';

  sel.innerHTML = '';

  var defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = filterText
    ? '-- Showing ' + filtered.length + ' of ' + cachedUserRepos.length + ' repos matching "' + filterText + '" --'
    : '-- Select a GitHub repository (' + cachedUserRepos.length + ' found) --';
  sel.appendChild(defaultOpt);

  var matched = false;
  filtered.forEach(function (r) {
    var opt = document.createElement('option');
    opt.value = r.name;
    opt.textContent = (r.private ? '🔒 ' : '📖 ') + r.name + (r.default_branch ? ' (' + r.default_branch + ')' : '');
    opt.setAttribute('data-branch', r.default_branch || 'main');
    if (currentRepo && r.name.toLowerCase() === currentRepo) {
      opt.selected = true;
      matched = true;
    }
    sel.appendChild(opt);
  });

  var customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = '✏️ Custom repository name...';
  if (!matched && currentRepo) customOpt.selected = true;
  sel.appendChild(customOpt);

  if (status) {
    status.textContent = filterText
      ? 'Found ' + filtered.length + ' matching repository' + (filtered.length === 1 ? '' : 'ies')
      : 'Filter by typing above or click to select:';
  }
}

function loadUserRepos() {
  var sel = $('repo-select');
  if (!sel || !api || !api.runtime) return;

  api.runtime.sendMessage({ type: 'getUserRepos' }).then(function (res) {
    if (res && res.ok && res.repos && res.repos.length) {
      cachedUserRepos = res.repos;
      var searchVal = $('repo-search-input') ? $('repo-search-input').value : '';
      renderFilteredRepos(searchVal);
      updateActiveRepoBadge();
    } else {
      cachedUserRepos = [];
      sel.innerHTML = '<option value="">No repositories loaded (click ⟳ Repos)</option>';
    }
  }).catch(function () {});
}

function updateAuthUI(token, owner) {
  var isConn = Boolean(token && token.length > 5);
  var connBox = $('auth-connected-box');
  var disconnBox = $('auth-disconnected-box');
  var connText = $('auth-connected-text');
  var btnToggle = $('btn-auth-toggle');

  if (isConn) {
    if (connBox) connBox.style.display = 'block';
    if (disconnBox) disconnBox.style.display = 'none';
    if (btnToggle) btnToggle.style.display = 'inline-block';
    if (connText) connText.textContent = 'Connected as @' + (owner || 'user');
    loadUserRepos();
  } else {
    if (connBox) connBox.style.display = 'none';
    if (disconnBox) disconnBox.style.display = 'block';
    if (btnToggle) btnToggle.style.display = 'none';
    var sel = $('repo-select');
    if (sel) sel.innerHTML = '<option value="">Connect GitHub above to load your repositories</option>';
  }
}

// -------------------------------------------------------------
// Theme & Visual Accent Helpers
// -------------------------------------------------------------
function applyThemeInOptions(theme) {
  document.body.className = (theme === 'midnight-bento' || !theme) ? '' : 'theme-' + theme;
  var sel = $('opt-theme-select');
  if (sel && sel.value !== theme) {
    sel.value = theme;
  }
}

function applyAccentInOptions(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-glow', color + '40');
  var swatches = document.querySelectorAll('.swatch-opt');
  swatches.forEach(function (sw) {
    var c = sw.getAttribute('data-color');
    if (c === color) {
      sw.style.borderColor = '#ffffff';
    } else {
      sw.style.borderColor = 'transparent';
    }
  });
}

function toggleCustomFolderGroup() {
  var org = $('folder-org') ? $('folder-org').value : '';
  var group = $('group-custom-folder');
  if (group) {
    group.style.display = (org === 'custom') ? 'block' : 'none';
  }
}

// -------------------------------------------------------------
// Load Settings on Start
// -------------------------------------------------------------
storage.get({ settings: DEFAULTS, hideSections: {} }).then(function (res) {
  var s = Object.assign({}, DEFAULTS, res.settings || {});
  if ($('token')) $('token').value = s.token || '';
  if ($('owner')) $('owner').value = s.owner || '';
  if ($('repo')) $('repo').value = s.repo || 'Leet-Work';
  if ($('branch')) $('branch').value = s.branch || 'main';
  if ($('base-folder')) $('base-folder').value = s.baseFolder != null ? s.baseFolder : 'LeetCode';
  if ($('folder-org')) {
    $('folder-org').value = s.folderOrg || 'difficulty';
    toggleCustomFolderGroup();
  }
  if ($('custom-folder-template')) $('custom-folder-template').value = s.customFolderTemplate || '{difficulty}/{padded_id}-{slug}';
  if ($('file-base-name')) $('file-base-name').value = s.fileBaseName || 'solution';
  if ($('commit-template')) $('commit-template').value = s.commitTemplate || 'Add {id}. {title} ({lang})';
  if ($('gen-readme')) $('gen-readme').checked = s.generateProblemReadme !== false;
  if ($('maintain-root-readme')) $('maintain-root-readme').checked = s.maintainRootReadme !== false;
  if ($('include-topic-index')) $('include-topic-index').checked = s.includeTopicIndex !== false;
  if ($('periodic-sync')) $('periodic-sync').checked = s.periodicSync !== false;
  if ($('sync-interval')) $('sync-interval').value = s.syncInterval || 15;
  if ($('realtime-sync')) $('realtime-sync').checked = s.realtimeSync !== false;
  if ($('overwrite-existing')) $('overwrite-existing').checked = Boolean(s.overwriteExisting);

  updateAuthUI(s.token, s.owner);
  checkLeetCodeStatus();
  updateActiveRepoBadge();

  if (api && api.storage && api.storage.local) {
    api.storage.local.get({ userTheme: 'midnight-bento', userAccent: '#9d72ff' }).then(function (tr) {
      if (tr.userTheme) applyThemeInOptions(tr.userTheme);
      if (tr.userAccent) applyAccentInOptions(tr.userAccent);
    });
  }

  var hidden = res.hideSections || {};
  if (hidden.migration && $('card-migration')) $('card-migration').style.display = 'none';
  if (hidden.logs && $('card-logs')) $('card-logs').style.display = 'none';

  refreshLogs();
});

// -------------------------------------------------------------
// Save Configuration
// -------------------------------------------------------------
function saveAll(silent) {
  var s = readSettings();
  var btn = $('btn-save-main');
  if (btn) btn.textContent = '⏳ Saving...';

  return storage.set({ settings: s, lastError: null }).then(function () {
    if (btn) btn.textContent = 'Save Configuration';
    if (!silent) showToast('✓ Configuration saved successfully.', true);
    updateAuthUI(s.token, s.owner);
    if (s.token && api && api.runtime) {
      api.runtime.sendMessage({ type: 'syncNow' }).catch(function () {});
    }
  }).catch(function (e) {
    if (btn) btn.textContent = 'Save Configuration';
    if (!silent) showToast('Failed to save configuration: ' + e.message, false);
  });
}

if ($('btn-save-main')) $('btn-save-main').addEventListener('click', function () { saveAll(false); });

// -------------------------------------------------------------
// Test Connection
// -------------------------------------------------------------
function runTest() {
  var s = readSettings();
  var btn = $('btn-test-main');

  if (!s.token) {
    showToast('Please enter your GitHub Personal Access Token first.', false);
    if ($('token')) $('token').focus();
    return;
  }
  if (!s.repo) {
    showToast('Please enter your GitHub Repository Name.', false);
    if ($('repo')) $('repo').focus();
    return;
  }

  if (btn) btn.textContent = '⏳ Testing connection...';
  showToast('Connecting to GitHub API...', true);

  if (!api || !api.runtime) {
    if (btn) btn.textContent = 'Test Connection';
    showToast('✓ Token entered. (Running in preview mode)', true);
    return;
  }

  api.runtime.sendMessage({ type: 'testConnection', settings: s }).then(function (r) {
    if (btn) btn.textContent = 'Test Connection';
    if (r && r.ok) {
      if (r.detectedOwner && !s.owner) {
        s.owner = r.detectedOwner;
        if ($('owner')) $('owner').value = r.detectedOwner;
        saveAll(true);
      }
      var target = (s.owner || r.detectedOwner || 'your repo') + '/' + s.repo;
      var headMsg = r.emptyRepo ? '(New/Empty repository - will be initialized on first sync)' : '(Head SHA: ' + String(r.sha || '').slice(0, 7) + ')';
      showToast('✓ Successfully connected to ' + target + ' on branch ' + s.branch + '! ' + headMsg, true);
      updateAuthUI(s.token, s.owner || r.detectedOwner);
    } else {
      var err = (r && r.error) || 'Check token and repository name.';
      if (err.indexOf('404') !== -1) {
        err = 'Repository not found (404). Check that "' + (s.owner || 'username') + '/' + s.repo + '" exists on GitHub and that your token has access to it.';
      } else if (err.indexOf('401') !== -1) {
        err = 'GitHub rejected your token (401 Bad Credentials). Please re-generate your token on GitHub.';
      }
      showToast('Connection failed: ' + err, false);
    }
  }).catch(function (e) {
    if (btn) btn.textContent = 'Test Connection';
    showToast('Connection error: ' + e.message, false);
  });
}

if ($('btn-test-main')) $('btn-test-main').addEventListener('click', runTest);

// -------------------------------------------------------------
// Token Visibility & Auth Buttons
// -------------------------------------------------------------
if ($('btn-toggle-token-mask')) {
  $('btn-toggle-token-mask').addEventListener('click', function () {
    var input = $('token');
    var btn = $('btn-toggle-token-mask');
    if (!input || !btn) return;
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = '🙈 Hide';
    } else {
      input.type = 'password';
      btn.textContent = '👁️ Show';
    }
  });
}

if ($('btn-auth-toggle')) {
  $('btn-auth-toggle').addEventListener('click', function () {
    if (confirm('Disconnect GitHub account? Your saved token will be cleared.')) {
      if ($('token')) $('token').value = '';
      if ($('owner')) $('owner').value = '';
      if (api && api.runtime) {
        api.runtime.sendMessage({ type: 'disconnectGithub' }).catch(function () {});
      }
      saveAll(true).then(function () {
        updateAuthUI('', '');
        showToast('GitHub disconnected.', true);
      });
    }
  });
}

// 1-Click OAuth button
if ($('btn-oauth-main')) {
  $('btn-oauth-main').addEventListener('click', function () {
    var btn = this;
    btn.innerHTML = '<span>⏳ Authorizing with GitHub...</span>';
    btn.disabled = true;
    if (api && api.runtime) {
      api.runtime.sendMessage({ type: 'startGithubOAuth' }).then(function (res) {
        btn.disabled = false;
        if (res && res.ok) {
          btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg><span>✓ Connected to GitHub</span>';
          btn.style.background = 'rgba(16, 185, 129, 0.12)';
          btn.style.borderColor = 'rgba(16, 185, 129, 0.35)';
          btn.style.color = '#10b981';
          showToast('🎉 GitHub connected successfully as @' + res.user + '!', true);
          // Re-read token from storage (set by background)
          api.storage.local.get({ settings: {} }).then(function (r) {
            updateAuthUI(r.settings.token, r.settings.owner);
            loadUserRepos();
          });
        } else if (res && res.cancelled) {
          btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg><span>⚡ Authorize with GitHub (1-Click)</span>';
        } else if (res && res.error) {
          btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg><span>⚡ Authorize with GitHub (1-Click)</span>';
          showToast('GitHub authorization failed: ' + res.error, false);
        }
      });
    }
  });
}

// Folder Org dropdown listener
if ($('folder-org')) {
  $('folder-org').addEventListener('change', toggleCustomFolderGroup);
}

// Toggle manual token view
if ($('link-toggle-manual-token')) {
  $('link-toggle-manual-token').addEventListener('click', function (e) {
    e.preventDefault();
    var box = $('manual-token-container');
    if (box) {
      var isHidden = box.style.display === 'none' || !box.style.display;
      box.style.display = isHidden ? 'block' : 'none';
      this.textContent = isHidden ? 'Hide manual Personal Access Token ▲' : 'Or enter Personal Access Token (PAT) manually ▾';
    }
  });
}

// Real-time repository search input
if ($('repo-search-input')) {
  $('repo-search-input').addEventListener('input', function () {
    renderFilteredRepos(this.value);
  });
}

// Live update active target repository badge banner
['repo', 'owner', 'branch'].forEach(function (id) {
  var el = $(id);
  if (el) {
    el.addEventListener('input', updateActiveRepoBadge);
  }
});

// Theme select dropdown listener
if ($('opt-theme-select')) {
  $('opt-theme-select').addEventListener('change', function () {
    var theme = this.value;
    applyThemeInOptions(theme);
    if (api && api.storage && api.storage.local) {
      api.storage.local.set({ userTheme: theme });
    }
  });
}

// Accent swatch click listeners
var swatchesOpt = document.querySelectorAll('.swatch-opt');
swatchesOpt.forEach(function (sw) {
  sw.addEventListener('click', function () {
    var color = this.getAttribute('data-color');
    if (color) {
      applyAccentInOptions(color);
      if (api && api.storage && api.storage.local) {
        api.storage.local.set({ userAccent: color });
      }
    }
  });
});

// Repository select dropdown changed
if ($('repo-select')) {
  $('repo-select').addEventListener('change', function () {
    var val = this.value;
    if (val && val !== '__custom__') {
      if ($('repo')) $('repo').value = val;
      var opt = this.options[this.selectedIndex];
      var branch = opt ? opt.getAttribute('data-branch') : 'main';
      if (branch && $('branch')) $('branch').value = branch;
      updateActiveRepoBadge();
      saveAll(true);
      showToast('Selected repository: ' + val, true);
    } else if (val === '__custom__') {
      if ($('repo')) $('repo').focus();
    }
  });
}

// Refresh repositories list
if ($('btn-refresh-repos')) {
  $('btn-refresh-repos').addEventListener('click', function () {
    showToast('Refreshing repositories from GitHub...', true);
    loadUserRepos();
  });
}

// Create new repository on GitHub
if ($('btn-create-default-repo')) {
  $('btn-create-default-repo').addEventListener('click', function () {
    var btn = this;
    var repoName = prompt('Enter a name for the new GitHub repository:', 'leetcode-solutions');
    if (!repoName) return;
    repoName = repoName.trim();
    btn.textContent = '⏳ Creating...';
    btn.disabled = true;

    if (!api || !api.runtime) {
      btn.textContent = "+ Create 'leetcode-solutions' Repo";
      btn.disabled = false;
      showToast('Created repository (preview mode): ' + repoName, true);
      if ($('repo')) $('repo').value = repoName;
      return;
    }

    api.runtime.sendMessage({ type: 'createRepo', name: repoName, private: true }).then(function (res) {
      btn.textContent = "+ Create 'leetcode-solutions' Repo";
      btn.disabled = false;
      if (res && res.ok) {
        showToast('✓ Successfully created repository ' + repoName + ' on GitHub!', true);
        if ($('repo')) $('repo').value = repoName;
        if (res.repo && res.repo.owner && $('owner')) $('owner').value = res.repo.owner.login;
        saveAll(true);
        loadUserRepos();
      } else {
        showToast('Failed to create repository: ' + ((res && res.error) || 'Check token permissions'), false);
      }
    }).catch(function (e) {
      btn.textContent = "+ Create 'leetcode-solutions' Repo";
      btn.disabled = false;
      showToast('Error: ' + e.message, false);
    });
  });
}

if ($('btn-check-lc')) {
  $('btn-check-lc').addEventListener('click', checkLeetCodeStatus);
}

// -------------------------------------------------------------
// Optional Section 6: Scan Target Repository
// -------------------------------------------------------------
if ($('btn-scan-repo')) {
  $('btn-scan-repo').addEventListener('click', function () {
    var btn = $('btn-scan-repo');
    btn.textContent = '⏳ Scanning Target Repository...';
    var s = readSettings();

    if (!api || !api.runtime) {
      btn.textContent = '🔍 Scan Target Repository';
      showToast('Repository scan is available in extension mode.', false);
      return;
    }

    api.runtime.sendMessage({ type: 'checkRepo', settings: s }).then(function (res) {
      btn.textContent = '🔍 Re-scan Repository';
      if (!res || !res.ok) {
        showToast('Scan failed: ' + ((res && res.error) || 'Could not fetch repo tree'), false);
        return;
      }
      if ($('migration-results')) $('migration-results').style.display = 'block';

      var inRepo = res.inRepoCount != null ? res.inRepoCount : ((res.recognizedProblems && res.recognizedProblems.length) || 0);
      var missing = res.missingCount != null ? res.missingCount : 0;
      var unrecognized = res.unrecognizedFolders != null ? (typeof res.unrecognizedFolders === 'number' ? res.unrecognizedFolders : res.unrecognizedFolders.length) : 0;
      var totalSolved = res.totalSolved != null ? res.totalSolved : (inRepo + missing);

      if ($('stat-scanned-inrepo')) $('stat-scanned-inrepo').textContent = inRepo;
      if ($('stat-scanned-missing')) $('stat-scanned-missing').textContent = missing;
      if ($('stat-scanned-untouched')) $('stat-scanned-untouched').textContent = unrecognized;

      showToast('✓ Repository scan completed: ' + inRepo + ' in repo · ' + missing + ' missing to add (Total: ' + totalSolved + ').', true);
    }).catch(function (err) {
      btn.textContent = '🔍 Scan Target Repository';
      showToast('Scan error: ' + err.message, false);
    });
  });
}



// -------------------------------------------------------------
// Optional Section 7: Activity Logs
// -------------------------------------------------------------
function refreshLogs() {
  var container = $('logs-container');
  if (!container) return;
  if (!api || !api.runtime) {
    container.innerHTML = '<div style="padding: 12px; color: var(--text-muted); text-align: center;">No activity recorded yet.</div>';
    return;
  }
  api.runtime.sendMessage({ type: 'getLogs' }).then(function (logs) {
    if (!logs || !logs.length) {
      container.innerHTML = '<div style="padding: 12px; color: var(--text-muted); text-align: center;">No activity recorded yet.</div>';
      return;
    }
    container.innerHTML = logs.slice(-50).map(function (l) {
      var color = l.level === 'ERR' || l.level === 'ERROR' ? '#f87171' : (l.level === 'WARN' ? '#f59e0b' : '#10b981');
      return '<div class="log-line">' +
        '<span style="color: var(--text-muted);">' + (l.timeStr ? '[' + l.timeStr + ']' : '') + '</span> ' +
        '<span style="color: ' + color + '; font-weight: bold;">[' + l.level + ']</span> ' +
        '<span>' + escapeHtml(l.message) + '</span>' +
      '</div>';
    }).join('');
    container.scrollTop = container.scrollHeight;
  }).catch(function () {});
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

if ($('btn-copy-log')) {
  $('btn-copy-log').addEventListener('click', function () {
    var txt = $('logs-container').innerText;
    navigator.clipboard.writeText(txt).then(function () {
      showToast('Logs copied to clipboard.', true);
    });
  });
}

if ($('btn-clear-log')) {
  $('btn-clear-log').addEventListener('click', function () {
    if (api && api.runtime) {
      api.runtime.sendMessage({ type: 'clearLogs' }).then(function () {
        refreshLogs();
        showToast('Logs cleared.', true);
      });
    }
  });
}

// Live log updates: refresh when a new log entry is added
if (api && api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'logAdded') {
      refreshLogs();
    }
  });
}
