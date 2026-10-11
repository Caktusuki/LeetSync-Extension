# Privacy Policy - LeetSync

LeetSync is designed to be local-first and privacy-preserving.

What happens:
- All LeetSync settings and state are stored locally in your browser (storage.local, storage.session). Nothing leaves your device except the network calls you explicitly authorize.
- When you connect GitHub, your credentials/tokens are stored only in your local browser. OAuth code-for-token exchange is performed by the LeetSync OAuth Worker (Cloudflare Worker) which receives the short-lived authorization code and exchanges it server-side with GitHub. The Worker does not log, persist, or share access/refresh tokens or user data; it only facilitates the token exchange and returns tokens to your browser.
- LeetSync reads accepted submission data from leetcode.com while you are logged in (same-origin GraphQL/API calls using your session cookies). This data is used only to generate solution files locally and to commit them to the GitHub repository you own and configured.
- Commits are pushed directly from your browser to api.github.com using your GitHub token. No third-party analytics, telemetry, or remote tracking is collected by the extension.
- The extension does not send solution content, problem data, or personal information to any service other than GitHub (your repo) and leetcode.com (to read your own submissions). The Worker is not used to store or relay solutions.

Not affiliated with LeetCode. You remain in control of what goes into your GitHub repository.
