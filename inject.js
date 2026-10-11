// Runs in the PAGE context (injected by content.js). It watches LeetCode's own
// "submission check" responses and tells the content script when one is Accepted.
(function () {
  if (window.__lgsInjected) return;
  window.__lgsInjected = true;

  var CHECK_RE = /\/submissions\/detail\/(\d+)\/check\/?/;

  function handle(submissionId, json) {
    try {
      if (json && json.state === 'SUCCESS' && json.status_msg === 'Accepted') {
        window.postMessage({ source: 'lgs-accepted', submissionId: String(submissionId) }, '*');
      }
    } catch (e) { /* ignore */ }
  }

  // fetch
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      var args = arguments;
      var p = origFetch.apply(this, args);
      try {
        var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        var m = url.match(CHECK_RE);
        if (m) {
          p.then(function (res) {
            res.clone().json().then(function (j) { handle(m[1], j); }).catch(function () {});
          }).catch(function () {});
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  // XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      var m = String(url).match(CHECK_RE);
      if (m) {
        var id = m[1];
        this.addEventListener('load', function () {
          try { handle(id, JSON.parse(this.responseText)); } catch (e) { /* ignore */ }
        });
      }
    } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };
})();
