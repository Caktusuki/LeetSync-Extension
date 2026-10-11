// Content script: injects the page hook, and when a submission is Accepted,
// fetches the details from LeetCode (same-origin, uses your logged-in session)
// and hands them to the background script.
(function () {
  var browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
  var s = document.createElement('script');
  s.src = browserAPI.runtime.getURL('inject.js');
  s.onload = function () { s.remove(); };
  (document.head || document.documentElement).appendChild(s);

  var EXT = {
    cpp: 'cpp', c: 'c', java: 'java', python: 'py', python3: 'py', csharp: 'cs',
    javascript: 'js', typescript: 'ts', php: 'php', swift: 'swift', kotlin: 'kt',
    dart: 'dart', golang: 'go', ruby: 'rb', scala: 'scala', rust: 'rs',
    racket: 'rkt', erlang: 'erl', elixir: 'ex', mysql: 'sql', mssql: 'sql',
    oraclesql: 'sql', postgresql: 'sql', bash: 'sh', pythondata: 'py'
  };

  var seen = new Set();

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.source !== 'lgs-accepted') return;
    var id = String(ev.data.submissionId);
    if (seen.has(id)) return;
    seen.add(id);
    collect(id)
      .then(function (payload) { return browserAPI.runtime.sendMessage({ type: 'submission', payload: payload }); })
      .catch(function (e) { console.warn('[LeetCode GitHub Sync]', e); seen.delete(id); });
  });

  function gql(query, variables) {
    var csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
    return fetch('/graphql/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrftoken': csrf },
      body: JSON.stringify({ query: query, variables: variables })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
      return j.data;
    });
  }

  function constraintsOf(html) {
    var doc = new DOMParser().parseFromString(html || '', 'text/html');
    var marker = Array.prototype.slice.call(doc.querySelectorAll('strong,b,p')).find(function (el) {
      return /^\s*constraints\s*:?\s*$/i.test(el.textContent);
    });
    if (!marker) return [];
    var el = marker.closest('p') || marker;
    var next = el.nextElementSibling;
    for (var hops = 0; next && next.tagName !== 'UL' && hops < 2; hops++) next = next.nextElementSibling;
    if (!next || next.tagName !== 'UL') return [];
    return Array.prototype.slice.call(next.querySelectorAll('li')).map(function (li) {
      return li.textContent.replace(/\s+/g, ' ').trim();
    });
  }

  async function collect(submissionId) {
    var m = location.pathname.match(/\/problems\/([^/]+)/);
    if (!m) throw new Error('Not on a problem page');
    var slug = m[1];

    var sub = (await gql(
      'query($id:Int!){submissionDetails(submissionId:$id){code runtimeDisplay memoryDisplay timestamp lang{name verboseName}}}',
      { id: Number(submissionId) }
    )).submissionDetails;
    var q = (await gql(
      'query($slug:String!){question(titleSlug:$slug){questionFrontendId title titleSlug content difficulty topicTags{name}}}',
      { slug: slug }
    )).question;
    if (!sub || !q) throw new Error('Could not load submission or problem data');

    return {
      submissionId: String(submissionId),
      slug: q.titleSlug || slug,
      id: Number(q.questionFrontendId),
      title: q.title,
      difficulty: q.difficulty,
      tags: (q.topicTags || []).map(function (t) { return t.name; }),
      constraints: constraintsOf(q.content),
      code: sub.code,
      langName: sub.lang.verboseName,
      ext: EXT[sub.lang.name] || 'txt',
      runtime: sub.runtimeDisplay || '',
      memory: sub.memoryDisplay || '',
      timestamp: sub.timestamp ? Number(sub.timestamp) * 1000 : Date.now()
    };
  }

  // Backup DOM observer: watches for "Accepted" banner on LeetCode problem page
  var lastObservedCheck = 0;
  var observer = new MutationObserver(function () {
    var now = Date.now();
    if (now - lastObservedCheck < 3000) return;
    lastObservedCheck = now;

    var acceptedEl = document.querySelector('[data-e2e-locator="submission-result"]') ||
      document.querySelector('span[data-state="success"]');

    if (!acceptedEl) {
      var candidates = document.querySelectorAll('span, div');
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (el.textContent && el.textContent.trim() === 'Accepted' &&
            (el.classList.contains('text-green') || el.classList.contains('text-success') || el.getAttribute('data-status') === 'accepted')) {
          acceptedEl = el;
          break;
        }
      }
    }

    if (acceptedEl) {
      var m = location.pathname.match(/\/problems\/([^/]+)/);
      if (!m) return;
      var slug = m[1];
      fetch('/api/submissions/' + slug + '/?offset=0&limit=1', { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.submissions_dump || !data.submissions_dump.length) return;
          var sub = data.submissions_dump[0];
          if (sub.status_display === 'Accepted') {
            var id = String(sub.id);
            if (!seen.has(id)) {
              seen.add(id);
              collect(id)
                .then(function (payload) { return browserAPI.runtime.sendMessage({ type: 'submission', payload: payload }); })
                .catch(function (e) { console.warn('[LeetSync]', e); seen.delete(id); });
            }
          }
        }).catch(function () {});
    }
  });

  if (document.body || document.documentElement) {
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }
})();
