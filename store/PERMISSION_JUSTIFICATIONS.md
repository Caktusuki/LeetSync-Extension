# Permission Justifications

- storage: Persist settings, solved cache, queue, import state, logs locally in browser.
- alarms: Resume long-running import after service worker idle/shutdown in Chrome; periodic sync scheduling.
- tabs: Open options page and LeetCode login in a new tab when needed.
- identity: Launch OAuth flow (launchWebAuthFlow) to obtain GitHub authorization without exposing token in URL history.
- scripting: Inject content script helpers if needed in MV3 contexts.
- cookies: Read csrftoken from https://leetcode.com to authenticate same-origin LeetCode GraphQL calls.
- host_permissions (https://leetcode.com/*, https://api.github.com/*, https://github.com/*, https://*.workers.dev/*): Read own LeetCode submissions, commit to user's GitHub repo, and exchange OAuth code with the extension's Cloudflare Worker.
