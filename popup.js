var $ = function (id) { return document.getElementById(id); };

const api = globalThis.browser ?? globalThis.chrome ?? {
  runtime: { sendMessage: () => Promise.resolve({}), openOptionsPage: () => {} },
  storage: { local: { get: (d) => Promise.resolve(d), set: () => Promise.resolve() } }
};

// Listen for real-time storage and runtime broadcasts
if (api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      render();
      if (changes.importStatus && changes.importStatus.newValue) {
        updateRunningUI(changes.importStatus.newValue);
      }
    }
  });
}

function appendLiveConsoleLog(l) {
  var liveConsole = $('import-live-log');
  if (!liveConsole) return;
  var color = (l.level === 'ERR' || l.level === 'ERROR') ? 'var(--hard)' :
              (l.level === 'WARN' ? 'var(--med)' : 'var(--text-muted)');
  var div = document.createElement('div');
  div.style.color = color;
  div.style.marginBottom = '2px';
  div.innerHTML = '<span style="opacity: 0.6; font-size: 9px;">[' + escapeHtml(l.timeStr || '') + ']</span> ' + escapeHtml(l.message);
  liveConsole.appendChild(div);
  while (liveConsole.childNodes.length > 30) {
    liveConsole.removeChild(liveConsole.firstChild);
  }
  liveConsole.scrollTop = liveConsole.scrollHeight;
}

if (api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'importTick' && msg.status) {
      updateRunningUI(msg.status);
    } else if (msg.type === 'logAdded' && msg.log) {
      appendLiveConsoleLog(msg.log);
    }
  });
}

// Escapes HTML for safe injection
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Relative time formatting helper
function timeAgo(dateOrTs) {
  if (!dateOrTs) return 'just now';
  var ts = typeof dateOrTs === 'number' ? dateOrTs : new Date(dateOrTs).getTime();
  if (isNaN(ts)) return 'just now';
  var diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 45) return 'just now';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ago';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'h ago';
  if (diffSec < 172800) return 'yesterday';
  return Math.floor(diffSec / 86400) + 'd ago';
}

// -------------------------------------------------------------
// Screen Switcher
// -------------------------------------------------------------
window.showScreen = function (screenId) {
  var screens = document.querySelectorAll('.screen');
  screens.forEach(function (s) { s.classList.remove('active'); });
  var target = $(screenId);
  if (target) target.classList.add('active');

  if (screenId === 'screen-import-ready') {
    loadImportScan();
  } else if (screenId === 'screen-import-running') {
    checkOrPollImport();
  } else if (screenId === 'screen-logs') {
    loadLogs();
  }
};

// Open full options page
window.openOptionsFullTab = function () {
  var url = api.runtime.getURL('options.html');

  // 1. Tell background script to open options tab (most reliable in unpacked Gecko)
  if (api.runtime && api.runtime.sendMessage) {
    api.runtime.sendMessage({ type: 'openOptions' }).catch(function () {});
  }

  // 2. Direct browser tabs API
  if (api.tabs && api.tabs.create) {
    try { api.tabs.create({ url: url }).catch(function () {}); } catch (e) { api.tabs.create({ url: url }); }
  }

  // 3. Fallback runtime openOptionsPage
  if (api.runtime && api.runtime.openOptionsPage) {
    try { api.runtime.openOptionsPage(); } catch (e) {}
  }

  // 4. Window open fallback
  try { window.open(url, '_blank'); } catch (e) {}

  // Close popup after tab launch has initiated
  setTimeout(function () {
    window.close();
  }, 250);
};

// -------------------------------------------------------------
// Themes & Accents
// -------------------------------------------------------------
window.applyTheme = function (theme) {
  var themeClass = (theme === 'midnight-bento' || !theme) ? 'theme-midnight-bento' : 'theme-' + theme;
  document.body.className = themeClass;

  var boxes = document.querySelectorAll('.theme-box');
  boxes.forEach(function (b) {
    b.classList.remove('selected');
    var chk = b.querySelector('.theme-check');
    if (chk) chk.style.display = 'none';
  });

  var activeBox = $('tb-' + theme);
  if (activeBox) {
    activeBox.classList.add('selected');
    var chk = activeBox.querySelector('.theme-check');
    if (chk) chk.style.display = 'inline';
  }

  if (api && api.storage && api.storage.local) {
    api.storage.local.set({ userTheme: theme });
  }
};

window.applyAccent = function (color) {
  if (!color) return;
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-glow', color + '40');

  var swatches = document.querySelectorAll('.swatch');
  swatches.forEach(function (sw) {
    var c = sw.getAttribute('data-color') || '';
    if (c === color) {
      sw.classList.add('active');
    } else {
      sw.classList.remove('active');
    }
  });

  if (api && api.storage && api.storage.local) {
    api.storage.local.set({ userAccent: color });
  }
};

// -------------------------------------------------------------
// Screen 2: Import Scan & Preparation
// -------------------------------------------------------------
var cachedScan = null;
var scanInFlight = false;

function showRetryButton(show) {
  var btn = $('btn-retry-scan');
  if (btn) btn.style.display = show ? 'inline-block' : 'none';
}

function applyScanResult(res) {
  if (!res || !res.ok) return;
  var scanStatus = $('import-scan-status');
  var heroCount = $('import-hero-count');
  var heroSub1 = $('import-hero-sub1');
  var heroSub2 = $('import-hero-sub2');
  var forceOverwrite = $('import-force-overwrite') ? $('import-force-overwrite').checked : false;

  var total = res.totalSolved || 0;
  var inRepo = res.inRepoCount || 0;
  var missing = res.missingCount != null ? res.missingCount : Math.max(0, total - inRepo);

  if (scanStatus) {
    if (res.scanMode === 'readme') scanStatus.textContent = 'instant - README index (' + (res.readmeProblems || 0) + ' problems)';
    else if (res.scanMode === 'new-repo') scanStatus.textContent = 'brand new repo';
    else if (res.scanMode === 'tree') scanStatus.textContent = 'full tree scan';
    else scanStatus.textContent = 'scan complete';
  }
  if (forceOverwrite) {
    if (heroCount) heroCount.textContent = missing;
    if (heroSub1) heroSub1.textContent = 'problems (full overwrite)';
    if (heroSub2) heroSub2.textContent = inRepo + ' in repo will be rewritten · ' + Math.max(0, missing - inRepo) + ' new';
  } else {
    if (heroCount) heroCount.textContent = missing;
    if (heroSub1) heroSub1.textContent = 'accepted problems';
    if (heroSub2) heroSub2.textContent = inRepo + ' in your repo · ' + missing + ' to add';
  }

  // Difficulty breakdown
  var items = res.missingItems && res.missingItems.length ? res.missingItems : [];
  var counts = { Easy: 0, Medium: 0, Hard: 0 };
  items.forEach(function (it) {
    var d = it.difficulty || 'Easy';
    if (counts[d] != null) counts[d]++;
  });

  var sum = counts.Easy + counts.Medium + counts.Hard;
  var pEasy = sum > 0 ? Math.round((counts.Easy / sum) * 100) : 33;
  var pMed = sum > 0 ? Math.round((counts.Medium / sum) * 100) : 33;
  var pHard = sum > 0 ? (100 - pEasy - pMed) : 34;

  if ($('import-seg-easy')) $('import-seg-easy').style.width = pEasy + '%';
  if ($('import-seg-med')) $('import-seg-med').style.width = pMed + '%';
  if ($('import-seg-hard')) $('import-seg-hard').style.width = pHard + '%';

  if ($('import-cnt-easy')) $('import-cnt-easy').textContent = counts.Easy;
  if ($('import-cnt-med')) $('import-cnt-med').textContent = counts.Medium;
  if ($('import-cnt-hard')) $('import-cnt-hard').textContent = counts.Hard;

  var batches = Math.ceil(missing / 20) || 1;
  var mins = Math.max(1, Math.round(batches * 0.6));
  if ($('import-pace-time')) $('import-pace-time').textContent = 'About ' + mins + ' min';
  if ($('import-pace-desc')) {
    $('import-pace-desc').textContent = batches + ' commit' + (batches > 1 ? 's' : '') +
      ' of 20, paced to stay under GitHub limits. Safe to close, progress is saved.';
  }
}

function renderScanError(message) {
  var scanStatus = $('import-scan-status');
  var heroSub2 = $('import-hero-sub2');
  if (scanStatus) scanStatus.textContent = 'scan error';
  if (heroSub2) heroSub2.textContent = message || 'Could not scan repository';
  showRetryButton(true);
}

function loadImportScan() {
  if (scanInFlight) return;
  var scanStatus = $('import-scan-status');
  var heroSub2 = $('import-hero-sub2');
  var forceOverwrite = $('import-force-overwrite') ? $('import-force-overwrite').checked : false;

  showRetryButton(false);
  if (cachedScan) {
    // Keep the last numbers on screen while refreshing in the background.
    applyScanResult(cachedScan);
    if (scanStatus) scanStatus.textContent = 'refreshing...';
  } else {
    if (scanStatus) scanStatus.textContent = 'scanning repo...';
    if (heroSub2) heroSub2.textContent = forceOverwrite ? 'gathering ALL solved problems...' : 'checking existing files on GitHub...';
  }

  scanInFlight = true;
  api.runtime.sendMessage({ type: 'scanRepo', forceAll: forceOverwrite }).then(function (res) {
    scanInFlight = false;
    if (!res || !res.ok) {
      renderScanError(res && res.error);
      return;
    }
    cachedScan = res;
    applyScanResult(res);
  }).catch(function (err) {
    scanInFlight = false;
    renderScanError(err && err.message);
  });
}

// -------------------------------------------------------------
// Screen 3: Import Workflow & Polling
// -------------------------------------------------------------
var importPollInterval = null;
var isPaused = false;

window.startImport = function () {
  var forceOverwrite = $('import-force-overwrite') ? $('import-force-overwrite').checked : false;
  var skipExisting = forceOverwrite ? false : ($('import-skip-existing') ? $('import-skip-existing').checked : true);
  var genReadme = $('import-gen-readme') ? $('import-gen-readme').checked : true;

  showScreen('screen-import-running');

  api.runtime.sendMessage({
    type: 'startImport',
    options: { skipExisting: skipExisting, generateProblemReadme: genReadme, forceOverwrite: forceOverwrite }
  }).catch(function (e) {
    console.warn('[LeetSync Import Error]', e);
  });

  if (importPollInterval) clearInterval(importPollInterval);
  importPollInterval = setInterval(pollImportStatus, 250);
  pollImportStatus();
};

function checkOrPollImport() {
  api.runtime.sendMessage({ type: 'getImportStatus' }).then(function (st) {
    if (st && st.running) {
      if (!importPollInterval) importPollInterval = setInterval(pollImportStatus, 250);
      updateRunningUI(st);
    } else {
      updateRunningUI(st || {});
    }
  }).catch(function () {});
}

function pollImportStatus() {
  api.runtime.sendMessage({ type: 'getImportStatus' }).then(function (st) {
    if (!st) return;
    updateRunningUI(st);
    if (!st.running && (st.pct >= 100 || st.imported === st.total || st.aborted)) {
      if (importPollInterval) {
        clearInterval(importPollInterval);
        importPollInterval = null;
      }
    }
  }).catch(function () {});
}

function updateRunningUI(st) {
  var pct = st.pct || 0;
  var imported = st.imported || 0;
  var total = st.total || 0;

  var arc = $('running-arc');
  if (arc) arc.setAttribute('stroke-dasharray', pct + ', 100');

  var centerTxt = $('run-count-center');
  if (centerTxt) centerTxt.textContent = imported;

  var totalTxt = $('run-count-total');
  if (totalTxt) totalTxt.textContent = 'of ' + total;

  var pctTxt = $('run-pct');
  if (pctTxt) pctTxt.textContent = pct + '%';

  var boxImported = $('stat-imported-box');
  if (boxImported) boxImported.textContent = imported;

  var boxSkipped = $('stat-skipped-box');
  if (boxSkipped) boxSkipped.textContent = st.skipped || 0;

  var boxFailed = $('stat-failed-box');
  if (boxFailed) boxFailed.textContent = st.failed || 0;

  var activeBatch = $('run-active-batch');
  if (activeBatch) {
    activeBatch.textContent = 'batch ' + (st.currentBatch || 1) + ' of ' + (st.totalBatches || 1);
  }

  var activeProb = $('run-active-problem');
  if (activeProb && st.currentProblem) {
    activeProb.textContent = st.currentProblem;
  }

  var activeBar = $('run-active-bar');
  if (activeBar) {
    var batchPct = st.totalBatches > 0 ? Math.min(100, Math.round(((st.currentBatch || 1) / st.totalBatches) * 100)) : pct;
    activeBar.style.width = batchPct + '%';
  }

  var badgeText = $('run-badge-text');
  var badgeDot = $('run-badge-dot');
  var badge = $('run-badge');

  if (st.running) {
    if (badgeText) badgeText.textContent = 'running';
    if (badgeDot) badgeDot.style.background = '#22d3ee';
    if (badge) {
      badge.style.background = 'rgba(34, 211, 238, 0.12)';
      badge.style.color = '#22d3ee';
      badge.style.borderColor = 'rgba(34, 211, 238, 0.3)';
    }

    var remaining = Math.max(0, total - imported);
    var remainingBatches = Math.ceil(remaining / 20);
    var estMins = Math.max(1, Math.round(remainingBatches * 0.5));
    if ($('run-time-left')) $('run-time-left').textContent = 'About ' + estMins + ' min left';
    if ($('run-commit-stat')) $('run-commit-stat').textContent = 'commit ' + (st.currentBatch || 1) + ' of ' + (st.totalBatches || 1);
  } else if (pct >= 100 || (total > 0 && imported >= total)) {
    if (badgeText) badgeText.textContent = 'complete';
    if (badgeDot) badgeDot.style.background = '#10b981';
    if (badge) {
      badge.style.background = 'rgba(16, 185, 129, 0.12)';
      badge.style.color = '#10b981';
      badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    }
    if ($('run-time-left')) $('run-time-left').textContent = 'Import finished!';
    if ($('run-commit-stat')) $('run-commit-stat').textContent = 'All batches committed';
  } else {
    if (badgeText) badgeText.textContent = isPaused ? 'paused' : 'stopped';
    if ($('run-time-left')) $('run-time-left').textContent = 'Import paused';
  }

  var commitsList = $('run-commits-list');
  if (commitsList && st.commits && st.commits.length) {
    commitsList.innerHTML = st.commits.slice(0, 3).map(function (c) {
      return '<div style="display: flex; justify-content: space-between; padding: 4px 6px; color: var(--text-muted);">' +
        '<span><span class="check-green">✓</span> ' + escapeHtml(c.text) + '</span>' +
        '<span style="font-family: monospace;">' + escapeHtml(c.time) + '</span>' +
      '</div>';
    }).join('');
  }

  // Update Live Console Logs inside running screen
  var liveConsole = $('import-live-log');
  if (liveConsole) {
    api.runtime.sendMessage({ type: 'getLogs' }).then(function (logs) {
      if (logs && logs.length) {
        var recentLogs = logs.slice(-15);
        liveConsole.innerHTML = recentLogs.map(function (l) {
          var color = (l.level === 'ERR' || l.level === 'ERROR') ? 'var(--hard)' :
                      (l.level === 'WARN' ? 'var(--med)' : 'var(--text-muted)');
          return '<div style="color: ' + color + '; margin-bottom: 2px;">' +
            '<span style="opacity: 0.6; font-size: 9px;">[' + escapeHtml(l.timeStr || '') + ']</span> ' +
            escapeHtml(l.message) +
          '</div>';
        }).join('');
        liveConsole.scrollTop = liveConsole.scrollHeight;
      }
    }).catch(function () {});
  }
}

var btnPause = $('btn-pause-import');
if (btnPause) {
  btnPause.addEventListener('click', function () {
    if (!isPaused) {
      api.runtime.sendMessage({ type: 'stopImport' }).then(function () {
        isPaused = true;
        btnPause.textContent = '▶ Resume';
      });
    } else {
      isPaused = false;
      btnPause.textContent = '⏸ Pause';
      window.startImport();
    }
  });
}

var btnStop = $('btn-stop-import');
if (btnStop) {
  btnStop.addEventListener('click', function () {
    api.runtime.sendMessage({ type: 'stopImport' }).then(function () {
      if (importPollInterval) clearInterval(importPollInterval);
      showScreen('screen-default');
    });
  });
}

// -------------------------------------------------------------
// Screen 5: Activity Logs
// -------------------------------------------------------------
function loadLogs() {
  var list = $('log-list-container');
  var errBadge = $('log-error-pill-count');
  if (!list) return;

  renderImportSummary();

  api.runtime.sendMessage({ type: 'getLogs' }).then(function (logs) {
    if (!logs || !logs.length) {
      list.innerHTML = '<div style="padding: 18px 12px; text-align: center; color: var(--text-muted); font-size: 11px;">No activity recorded yet.</div>';
      if (errBadge) errBadge.textContent = '0';
      return;
    }

    var errCount = 0;
    var html = logs.slice(-100).reverse().map(function (l) {
      var isErr = l.level === 'ERR' || l.level === 'ERROR' || l.message.toLowerCase().indexOf('fail') !== -1 || l.message.toLowerCase().indexOf('422') !== -1;
      var isWarn = l.level === 'WARN';
      if (isErr) errCount++;

      var badgeColor = isErr ? 'var(--hard)' : (isWarn ? 'var(--med)' : 'var(--easy)');
      var badgeBg = isErr ? 'rgba(244, 63, 94, 0.15)' : (isWarn ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)');
      var badgeIcon = isErr ? '✕ ERR' : (isWarn ? '⚠️ WARN' : '✓ OK');

      var cat = 'Sync';
      var catIcon = '⚡';
      if (l.message.toLowerCase().indexOf('import') !== -1) {
        cat = 'Import';
        catIcon = '⤓';
      } else if (l.message.toLowerCase().indexOf('github') !== -1 || l.message.toLowerCase().indexOf('rate limit') !== -1) {
        cat = 'Sync';
        catIcon = '🐙';
      }

      return '<div class="log-entry" data-cat="' + cat + '" data-is-err="' + (isErr ? 'true' : 'false') + '">' +
        '<div style="display: flex; justify-content: space-between; font-size: 9.5px; color: var(--text-muted); margin-bottom: 2px;">' +
          '<span>' + escapeHtml(l.timeStr || '') + ' <span style="color: ' + badgeColor + '; font-weight: 800; padding: 1px 5px; background: ' + badgeBg + '; border-radius: 4px; font-size: 9px;">' + badgeIcon + '</span></span>' +
          '<span style="font-weight: 700; color: var(--text-dim);">' + catIcon + ' ' + cat.toUpperCase() + '</span>' +
        '</div>' +
        '<div style="color: var(--text-main); word-break: break-word; font-size: 10.5px;">' + escapeHtml(l.message) + '</div>' +
      '</div>';
    }).join('');

    list.innerHTML = html;
    if (errBadge) errBadge.textContent = errCount;
  }).catch(function () {});
}

function renderImportSummary() {
  var box = document.getElementById('log-import-summary');
  if (!box) return;
  api.runtime.sendMessage({ type: 'getState' }).then(function (st) {
    var li = st && st.lastImport;
    if (!li) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var when = li.timestamp ? new Date(li.timestamp).toLocaleString() : '';
    var counts = li.counts || {};
    var reasons = li.reasons || {};
    var head = '<div style="background: rgba(245, 158, 11, 0.10); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 10px; padding: 10px 12px;">' +
      '<div style="font-size: 10px; font-weight: 800; color: var(--med); letter-spacing: 0.4px;">IMPORT SUMMARY</div>' +
      '<div style="font-size: 10.5px; color: var(--text-main); margin-top: 4px; word-break: break-word;">' +
        '<b>' + (li.committed || 0) + '</b> committed &middot; ' +
        '<b>' + ((counts.noAccepted != null ? counts.noAccepted : (li.noAcceptedCount || 0))) + '</b> had no accepted submission on LeetCode &middot; ' +
        '<b>' + (li.failed || 0) + '</b> failed' +
        (when ? ' <span style="color: var(--text-muted);">(' + escapeHtml(when) + ')</span>' : '') +
      '</div>' +
      (li.aborted
        ? '<div style="font-size: 10px; color: #ef4444; margin-top: 4px; font-weight: 700;">Stopped early at ' + (li.processed || 0) + '/' + (li.totalProblems || 0) + ' problems: ' + escapeHtml((li.aborted && li.aborted.error) || 'LeetCode session/auth failed.') + (li.aborted && li.aborted.slug ? ' (e.g. ' + escapeHtml(li.aborted.slug) + ')' : '') + '</div>'
        : '');

    function group(key, label, itemList) {
      if (!itemList || !itemList.length) return '';
      var shown = itemList.map(function (r) {
        var slug = typeof r === 'string' ? r : r.slug;
        var extra = (typeof r === 'object' && (r.error || r.httpStatus)) ? ' — ' + escapeHtml((r.httpStatus ? ('HTTP ' + r.httpStatus + ' ') : '') + (r.error || '')) : '';
        return escapeHtml(slug) + extra;
      }).join('<br>');
      return '<details style="margin-top: 6px;">' +
        '<summary style="cursor: pointer; font-size: 10px; font-weight: 700; color: var(--med);">' +
          'See all ' + itemList.length + ' ' + label +
        '</summary>' +
        '<div style="margin-top: 5px; font-size: 10px; color: var(--text-dim); word-break: break-word; max-height: 160px; overflow: auto;">' +
          shown +
        '</div>' +
      '</details>';
    }

    var listHtml = '';
    listHtml += group('fetched', 'problems with fetched code', reasons.fetched);
    listHtml += group('noAccepted', 'problems with no accepted submission', reasons.noAccepted);
    listHtml += group('fetchFailed', 'problems that failed to fetch', reasons.fetchFailed);
    listHtml += group('auth', 'problems blocked by auth (401/403)', reasons.auth);
    listHtml += group('session', 'problems blocked by an expired session', reasons.session);
    listHtml += group('skipped', 'problems skipped (cancelled)', reasons.skipped);

    // Backward compatibility with the previous summary shape.
    if (!listHtml && li.noAccepted && li.noAccepted.length) {
      listHtml = '<details style="margin-top: 6px;">' +
        '<summary style="cursor: pointer; font-size: 10px; font-weight: 700; color: var(--med);">' +
          'See all ' + (li.noAcceptedCount || li.noAccepted.length) + ' problems with no accepted submission' +
        '</summary>' +
        '<div style="margin-top: 5px; font-size: 10px; color: var(--text-dim); word-break: break-word; max-height: 140px; overflow: auto;">' +
          li.noAccepted.map(function (slug) { return escapeHtml(slug); }).join(', ') +
        '</div>' +
      '</details>';
    }

    var retryable = (counts.fetchFailed || 0) + (counts.auth || 0) + (counts.session || 0);
    var retryBtn = retryable > 0
      ? '<button id="btn-retry-missing" type="button" style="margin-top: 8px; width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(59, 130, 246, 0.4); background: rgba(59, 130, 246, 0.12); color: #3b82f6; font-size: 11px; font-weight: 700; cursor: pointer;">Retry missing (' + retryable + ')</button>'
      : '';

    box.innerHTML = head + listHtml + retryBtn + '</div>';
    box.style.display = 'block';

    var rb = document.getElementById('btn-retry-missing');
    if (rb) rb.addEventListener('click', function () { window.retryMissing(); });
  }).catch(function () {});
}

window.retryMissing = function () {
  showScreen('screen-import-running');
  api.runtime.sendMessage({ type: 'retryFailedImport', options: {} }).then(function (res) {
    if (res && res.ok === false && res.error) {
      console.warn('[LeetSync Retry]', res.error);
    }
  }).catch(function (e) {
    console.warn('[LeetSync Retry Error]', e);
  });
  if (importPollInterval) clearInterval(importPollInterval);
  importPollInterval = setInterval(pollImportStatus, 250);
  pollImportStatus();
};

window.filterLogs = function (cat, btn) {
  var pills = document.querySelectorAll('.log-pill');
  pills.forEach(function (p) { p.classList.remove('active'); });
  if (btn) btn.classList.add('active');

  var entries = document.querySelectorAll('.log-entry');
  entries.forEach(function (e) {
    if (cat === 'All') {
      e.style.display = 'block';
    } else if (cat === 'Errors') {
      e.style.display = e.getAttribute('data-is-err') === 'true' ? 'block' : 'none';
    } else {
      e.style.display = e.getAttribute('data-cat') === cat ? 'block' : 'none';
    }
  });
};

var copyLogResetTimer = null;
function setCopyLogLabel(text) {
  var btn = document.getElementById('btn-copy-logs');
  if (!btn) return;
  var span = btn.querySelector('span');
  (span || btn).textContent = text;
}
window.copyLog = function () {
  var list = $('log-list-container');
  if (!list) return;
  var txt = list.innerText;
  if (copyLogResetTimer) { clearTimeout(copyLogResetTimer); copyLogResetTimer = null; }
  function finish(label) {
    setCopyLogLabel(label);
    copyLogResetTimer = setTimeout(function () {
      setCopyLogLabel('Copy log');
      copyLogResetTimer = null;
    }, 1500);
  }
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    finish('Copy failed');
    return;
  }
  navigator.clipboard.writeText(txt).then(function () {
    finish('Copied ✓');
  }).catch(function () {
    finish('Copy failed');
  });
};

window.clearLog = function () {
  api.runtime.sendMessage({ type: 'clearLogs' }).then(function () {
    loadLogs();
  });
};

// Wire up log buttons (MV3 CSP blocks inline onclick attributes)
document.querySelectorAll('.log-pill').forEach(function (pill) {
  pill.addEventListener('click', function () {
    window.filterLogs(pill.getAttribute('data-filter') || 'All', pill);
  });
});
var copyLogsBtn = document.getElementById('btn-copy-logs');
if (copyLogsBtn) copyLogsBtn.addEventListener('click', function () { window.copyLog(); });
var clearLogsBtn = document.getElementById('btn-clear-logs');
if (clearLogsBtn) clearLogsBtn.addEventListener('click', function () { window.clearLog(); });

// -------------------------------------------------------------
// Screen 1: Default Bento Dashboard Live Binding
// -------------------------------------------------------------
function render() {
  api.runtime.sendMessage({ type: 'getState' }).then(function (st) {
    if (!st) return;
    var solved = st.solved || {};
    var allKeys = Object.keys(solved);
    var totalCount = allKeys.length;

    var counts = { Easy: 0, Medium: 0, Hard: 0 };
    var problemList = [];

    allKeys.forEach(function (k) {
      var e = solved[k];
      var d = e.difficulty || 'Easy';
      if (counts[d] != null) counts[d]++;

      var latestTime = 0;
      var langNames = [];
      if (e.langs) {
        Object.keys(e.langs).forEach(function (ext) {
          var l = e.langs[ext];
          if (l.timestamp && l.timestamp > latestTime) latestTime = l.timestamp;
          if (l.lang) langNames.push(l.lang);
        });
      }

      var diffClass = 'easy';
      if (d === 'Medium') diffClass = 'med';
      if (d === 'Hard') diffClass = 'hard';

      problemList.push({
        id: e.id || 0,
        title: e.title || k,
        difficulty: d,
        diffClass: diffClass,
        langStr: langNames.length ? langNames[0] : 'Solution',
        latestTime: latestTime || (e.timestamp || 0)
      });
    });

    // Update Hero Stats (even if 0)
    if ($('solved-count')) $('solved-count').textContent = totalCount;
    if ($('easy-count')) $('easy-count').textContent = counts.Easy;
    if ($('med-count')) $('med-count').textContent = counts.Medium;
    if ($('hard-count')) $('hard-count').textContent = counts.Hard;

    // Auto-fetch catalog if totalCount is 0 to load initial solved problems
    if (totalCount === 0 && !window._isSyncingCatalog) {
      window._isSyncingCatalog = true;
      api.runtime.sendMessage({ type: 'syncCatalog' }).then(function () {
        setTimeout(function () { window._isSyncingCatalog = false; render(); }, 800);
      }).catch(function () { window._isSyncingCatalog = false; });
    }

    // Update Repo Sync Coverage Stats
    var scan = st.lastScanResults;
    var s = st.settings || {};
    var isConnected = Boolean(s.token && s.token.length > 5);

    if (isConnected && !scan) {
      if ($('stat-lc-total')) $('stat-lc-total').textContent = totalCount;
      if ($('stat-repo-total')) $('stat-repo-total').textContent = '...';
      if ($('stat-missing-total')) $('stat-missing-total').textContent = '...';
      if ($('coverage-pct-badge')) $('coverage-pct-badge').textContent = 'Scanning repo...';
      if ($('coverage-bar')) $('coverage-bar').style.width = '0%';
    } else {
      var inRepo = (scan && scan.inRepoCount != null) ? scan.inRepoCount : 0;
      var missing = (scan && scan.missingCount != null) ? scan.missingCount : Math.max(0, totalCount - inRepo);
      var pct = totalCount > 0 ? Math.min(100, Math.round((inRepo / totalCount) * 100)) : (inRepo > 0 ? 100 : 0);
      var unsyncedPct = totalCount > 0 ? (100 - pct) : 0;

      if ($('stat-lc-total')) $('stat-lc-total').textContent = totalCount;
      if ($('stat-repo-total')) $('stat-repo-total').textContent = inRepo;
      if ($('stat-missing-total')) $('stat-missing-total').textContent = missing;
      if ($('coverage-pct-badge')) {
        $('coverage-pct-badge').textContent = pct + '% Synced (' + unsyncedPct + '% Unsynced)';
      }
      if ($('coverage-bar')) $('coverage-bar').style.width = pct + '%';
    }

    // Repository scan is NOT triggered from this refresh loop. It runs once on
    // popup open (see bootstrapPopup) and after import/sync actions only.

    // Render Recent Solutions
    var recentContainer = $('recent-list');
    if (recentContainer) {
      if (totalCount === 0) {
        recentContainer.innerHTML = '<div style="padding: 14px 6px; text-align: center; color: var(--text-muted); font-size: 11px;">' +
          'No submissions synced yet.<br>' +
          '<span style="font-size: 10px; color: var(--text-dim); margin-top: 3px; display: inline-block;">Solve a problem or click "Import history".</span>' +
        '</div>';
      } else {
        problemList.sort(function (a, b) {
          return (b.latestTime || 0) - (a.latestTime || 0);
        });
        recentContainer.innerHTML = problemList.slice(0, 3).map(function (item) {
          return '<div class="recent-item">' +
            '<div>' +
              '<div class="item-name">' + escapeHtml(item.id + '. ' + item.title) + '</div>' +
              '<div class="item-meta">' + escapeHtml(item.langStr) + ' · ' + timeAgo(item.latestTime) + '</div>' +
            '</div>' +
            '<span class="badge-level ' + item.diffClass + '">' + escapeHtml(item.difficulty) + '</span>' +
          '</div>';
        }).join('');
      }
    }

    // Check GitHub connection state
    var s = st.settings || {};
    var isConnected = Boolean(s.token && s.token.length > 5);

    var unconnectedBanner = $('unconnected-banner');
    if (unconnectedBanner) {
      unconnectedBanner.style.display = isConnected ? 'none' : 'block';
    }

    if ($('gh-user')) {
      $('gh-user').textContent = isConnected ? ('@' + (s.owner || 'user')) : 'not connected';
    }
    if ($('repo-name')) {
      $('repo-name').textContent = isConnected ? (s.repo || 'leetcode-solutions') : 'not connected';
    }

    var ghDot = $('sync-gh-dot');
    if (ghDot) {
      var ghReady = isConnected && Boolean(s.owner);
      ghDot.textContent = ghReady ? '✓' : '○';
      ghDot.style.color = ghReady ? 'var(--easy)' : 'var(--text-muted)';
    }

    // Check LeetCode active session
    api.runtime.sendMessage({ type: 'checkLeetCode' }).then(function (res) {
      var lcDot = $('sync-lc-dot');
      var lcText = $('sync-lc-text');
      var lcBanner = $('lc-unlinked-banner');
      var isLoggedIn = Boolean(res && res.loggedIn);

      if (lcDot) {
        lcDot.textContent = isLoggedIn ? '✓' : '✕';
        lcDot.style.color = isLoggedIn ? 'var(--easy)' : 'var(--hard)';
      }
      if (lcText) {
        lcText.textContent = isLoggedIn ? 'LeetCode' : 'Not Linked';
        lcText.style.color = isLoggedIn ? 'var(--text-main)' : 'var(--med)';
        lcText.style.cursor = isLoggedIn ? 'default' : 'pointer';
        lcText.title = isLoggedIn ? ('LeetCode session active (@' + (res.username || '') + ')') : 'Click to sign in & sync LeetCode';
      }
      if (lcBanner) {
        lcBanner.style.display = isLoggedIn ? 'none' : 'block';
      }
    }).catch(function () {});

    // Sync status and queue
    var qLen = (st.queue || []).length;
    var queueSub = $('queue-sub');
    var badge = $('sync-status-badge');
    var headline = $('sync-headline');
    var headlineIcon = $('sync-headline-icon');

    if (!isConnected) {
      if (headline) headline.textContent = 'Setup required';
      if (headlineIcon) { headlineIcon.textContent = '⚙'; headlineIcon.style.color = 'var(--accent)'; }
      if (queueSub) queueSub.textContent = 'Connect GitHub to enable syncing';
      if (badge) {
        badge.textContent = 'setup';
        badge.style.color = 'var(--accent)';
        badge.style.background = 'rgba(157, 114, 255, 0.12)';
        badge.style.borderColor = 'rgba(157, 114, 255, 0.3)';
      }
    } else if (st.importStatus && st.importStatus.running) {
      var imp = st.importStatus;
      if (headline) headline.textContent = 'Importing...';
      if (headlineIcon) { headlineIcon.textContent = '⇅'; headlineIcon.style.color = '#22d3ee'; }
      if (queueSub) queueSub.textContent = (imp.imported || 0) + ' / ' + (imp.total || 0) + ' processed';
      if (badge) {
        badge.textContent = (imp.pct != null ? imp.pct + '%' : 'importing');
        badge.style.color = '#22d3ee';
        badge.style.background = 'rgba(34, 211, 238, 0.12)';
        badge.style.borderColor = 'rgba(34, 211, 238, 0.3)';
      }
      var dotImport = document.querySelector('.badge-synced .dot');
      if (dotImport) dotImport.classList.add('pulse-live');
    } else if (st.lastError) {
      if (headline) headline.textContent = 'Sync issue';
      if (headlineIcon) { headlineIcon.textContent = '⚠'; headlineIcon.style.color = 'var(--hard)'; }
      if (queueSub) queueSub.textContent = st.lastError.slice(0, 32) + '...';
      if (badge) {
        badge.textContent = 'error';
        badge.style.color = 'var(--hard)';
        badge.style.background = 'rgba(244, 63, 94, 0.12)';
        badge.style.borderColor = 'rgba(244, 63, 94, 0.3)';
      }
    } else if (st.isSyncing || qLen > 0) {
      if (headline) headline.textContent = 'Background sync active';
      if (headlineIcon) { headlineIcon.textContent = '⚡'; headlineIcon.style.color = '#22d3ee'; }
      if (queueSub) queueSub.textContent = (qLen > 0 ? (qLen + ' solution(s) committing') : 'Committing solutions in background');
      if (badge) {
        badge.textContent = 'background sync';
        badge.style.color = '#22d3ee';
        badge.style.background = 'rgba(34, 211, 238, 0.12)';
        badge.style.borderColor = 'rgba(34, 211, 238, 0.3)';
      }
      var dot = document.querySelector('.badge-synced .dot');
      if (dot) dot.classList.add('pulse-live');
    } else if (!st.lastScanResults) {
      if (headline) headline.textContent = 'Scanning repo...';
      if (headlineIcon) { headlineIcon.textContent = '◌'; headlineIcon.style.color = 'var(--text-muted)'; }
      if (queueSub) queueSub.textContent = 'checking repository state';
      if (badge) {
        badge.textContent = 'scanning';
        badge.style.color = 'var(--text-muted)';
        badge.style.background = 'rgba(148, 163, 184, 0.12)';
        badge.style.borderColor = 'rgba(148, 163, 184, 0.3)';
      }
    } else if (st.lastScanResults.missingCount !== 0) {
      // "All synced" is only shown once a scan finished AND nothing is missing.
      var scanRes = st.lastScanResults;
      var missing = (typeof scanRes.missingCount === 'number') ? scanRes.missingCount : -1;
      var totalSolved = scanRes.totalSolved || 0;
      var inRepo = (typeof scanRes.inRepoCount === 'number') ? scanRes.inRepoCount : Math.max(0, totalSolved - (missing < 0 ? 0 : missing));
      if (headline) headline.textContent = (missing >= 0 ? (missing + ' not in repo') : 'Repo not scanned');
      if (headlineIcon) { headlineIcon.textContent = '◑'; headlineIcon.style.color = 'var(--med)'; }
      if (queueSub) queueSub.textContent = 'press Import history to sync them';
      if (badge) {
        badge.textContent = (missing >= 0 && totalSolved > 0) ? (inRepo + '/' + totalSolved) : 'import';
        badge.style.color = 'var(--med)';
        badge.style.background = 'rgba(245, 158, 11, 0.12)';
        badge.style.borderColor = 'rgba(245, 158, 11, 0.3)';
      }
      var dotMissing = document.querySelector('.badge-synced .dot');
      if (dotMissing) dotMissing.classList.remove('pulse-live');
    } else {
      if (headline) headline.textContent = 'All synced';
      if (headlineIcon) { headlineIcon.textContent = '✓'; headlineIcon.style.color = 'var(--easy)'; }
      if (queueSub) queueSub.textContent = '0 pending · 0 failed';
      if (badge) {
        badge.textContent = 'synced';
        badge.style.color = 'var(--easy)';
        badge.style.background = 'rgba(16, 185, 129, 0.12)';
        badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
      }
      var dot = document.querySelector('.badge-synced .dot');
      if (dot) dot.classList.remove('pulse-live');
    }

    var lastSync = $('last-sync-time');
    if (lastSync) {
      lastSync.textContent = st.lastSync
        ? ('last sync ' + new Date(st.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
        : 'no sync yet';
    }
  }).catch(function (e) {
    console.warn('[LeetSync]', e);
  });
}

// -------------------------------------------------------------
// Event Listeners & Startup
// -------------------------------------------------------------
var btnSync = $('btn-sync');
if (btnSync) {
  btnSync.addEventListener('click', function () {
    btnSync.innerHTML = '<span>⏳</span><span>Syncing...</span>';
    api.runtime.sendMessage({ type: 'syncNow' }).then(function () {
      setTimeout(function () {
        btnSync.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg><span>Sync now</span>';
        render();
      }, 700);
    });
  });
}

var btnPopupOAuth = $('btn-popup-oauth');
if (btnPopupOAuth) {
  btnPopupOAuth.addEventListener('click', function () {
    btnPopupOAuth.innerHTML = '<span>⏳ Authorizing...</span>';
    btnPopupOAuth.disabled = true;
    api.runtime.sendMessage({ type: 'startGithubOAuth' }).then(function (res) {
      btnPopupOAuth.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg><span>⚡ Authorize with GitHub (1-Click)</span>';
      btnPopupOAuth.disabled = false;
      if (res && res.ok) {
        setTimeout(openOptionsFullTab, 500);
      } else if (res && res.cancelled) {
        // user closed the popup - not an error
      } else if (res && res.error) {
        console.error('GitHub login failed:', res.error);
      }
    });
  });
}

var openLeetCodeLogin = function () {
  var loginUrl = 'https://leetcode.com/accounts/login/';
  if (api.tabs && api.tabs.create) {
    try { api.tabs.create({ url: loginUrl }); } catch (e) { window.open(loginUrl, '_blank'); }
  } else {
    window.open(loginUrl, '_blank');
  }
};

var btnLcLogin = $('btn-popup-lc-login');
if (btnLcLogin) {
  btnLcLogin.addEventListener('click', openLeetCodeLogin);
}

var syncLcText = $('sync-lc-text');
if (syncLcText) {
  syncLcText.addEventListener('click', function () {
    api.runtime.sendMessage({ type: 'checkLeetCode' }).then(function (res) {
      if (res && res.loggedIn) {
        api.runtime.sendMessage({ type: 'syncNow' });
        render();
      } else {
        openLeetCodeLogin();
      }
    }).catch(openLeetCodeLogin);
  });
}

if ($('btn-start-import')) $('btn-start-import').addEventListener('click', function () { window.startImport(); });
if ($('btn-to-import')) $('btn-to-import').addEventListener('click', function () { showScreen('screen-import-ready'); });

var forceToggle = $('import-force-overwrite');
var skipToggle = $('import-skip-existing');
var retryScanBtn = $('btn-retry-scan');
if (retryScanBtn) {
  retryScanBtn.addEventListener('click', function () { loadImportScan(); });
}
if (forceToggle) {
  forceToggle.addEventListener('change', function () {
    if (skipToggle) {
      skipToggle.disabled = forceToggle.checked;
      skipToggle.checked = !forceToggle.checked;
    }
    loadImportScan();
  });
}
if ($('btn-to-themes')) $('btn-to-themes').addEventListener('click', function () { showScreen('screen-themes'); });
if ($('btn-open-settings')) $('btn-open-settings').addEventListener('click', function () { openOptionsFullTab(); });
if ($('btn-open-options-full')) $('btn-open-options-full').addEventListener('click', function () { openOptionsFullTab(); });
if ($('tab-log')) $('tab-log').addEventListener('click', function () { showScreen('screen-logs'); });
if ($('link-see-all')) $('link-see-all').addEventListener('click', function () { showScreen('screen-logs'); });
if ($('link-full-log')) $('link-full-log').addEventListener('click', function () { showScreen('screen-logs'); });
if ($('btn-cancel-import')) $('btn-cancel-import').addEventListener('click', function () { showScreen('screen-default'); });

// Screen Back Buttons
['btn-back-themes', 'btn-back-import-ready', 'btn-back-logs'].forEach(function (id) {
  var el = $(id);
  if (el) {
    el.addEventListener('click', function () {
      showScreen('screen-default');
    });
  }
});

// Theme Box Selection Listeners
var themeBoxes = document.querySelectorAll('.theme-box');
themeBoxes.forEach(function (box) {
  box.addEventListener('click', function () {
    var theme = this.getAttribute('data-theme');
    if (theme) applyTheme(theme);
  });
});

// Accent Swatch Selection Listeners
var swatches = document.querySelectorAll('.swatch');
swatches.forEach(function (sw) {
  sw.addEventListener('click', function () {
    var color = this.getAttribute('data-color');
    if (color) applyAccent(color);
  });
});

// Load Saved Theme and Accent
api.storage.local.get({ userTheme: 'midnight-bento', userAccent: '#9d72ff' }).then(function (res) {
  if (res.userTheme) applyTheme(res.userTheme);
  if (res.userAccent) applyAccent(res.userAccent);
});

render();
setInterval(render, 3000);

// One-shot bootstrap on popup open: refresh the account submissions only when
// the cache is older than 10 minutes, then run a single repo scan. Never in a
// loop - the refresh interval above only re-renders.
function bootstrapPopup() {
  api.storage.local.get({ submissionsCache: null }).then(function (d) {
    var cache = d.submissionsCache;
    var fresh = cache && cache.acceptedBySlug && (Date.now() - (cache.fetchedAt || 0)) < 10 * 60 * 1000;
    var afterFetch = function () {
      api.runtime.sendMessage({ type: 'scanRepo' }).then(function () { render(); }).catch(function () {});
    };
    if (fresh) {
      afterFetch();
    } else {
      api.runtime.sendMessage({ type: 'fetchLeetCode' }).then(afterFetch).catch(afterFetch);
    }
  }).catch(function () {});
}
bootstrapPopup();

// Live progress for the account-submissions fetch (shown on the dashboard).
api.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'catalogProgress') updateCatalogProgress(msg.status);
});
updateCatalogProgress(null);
function updateCatalogProgress(st) {
  var el = $('catalog-progress');
  if (!el) return;
  if (!st || !st.running) { el.style.display = 'none'; el.textContent = ''; return; }
  var total = st.total || 0;
  el.style.display = 'block';
  el.textContent = 'Fetching submissions... ' + (st.fetched || 0) + (total ? ' / ' + total : '');
}

// Auto-switch to running import screen if active
api.runtime.sendMessage({ type: 'getImportStatus' }).then(function (st) {
  if (st && st.running) {
    showScreen('screen-import-running');
  }
}).catch(function () {});
