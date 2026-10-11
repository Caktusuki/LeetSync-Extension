# LeetSync (Firefox & Chromium)

Automatically detects accepted LeetCode submissions and commits them to your own GitHub repository. Local-first, private, no third-party servers.

## Features

- **Direct GitHub Git Database API:** Creates atomic commits (single Git tree per batch) directly from the browser background script.
- **LeetHub Migration & Repo Check:** Scans existing repositories in a single API call to index previously solved problems, preventing duplicate folders and preserving existing layouts.
- **Structured Persistent Logging:** Keeps the last 500 lines across restarts with fixed non-wrapping timestamp and level columns (`[14:20:00] [INFO]`). Personal access tokens are automatically masked.
- **Custom Icons & Visuals:** Crisp modern icons (SVG and 16px, 32px, 48px, 128px PNGs) showing Git branch graphs with LeetCode orange syntax brackets.
- **Clickable Interactive Prototype:** Try `prototype.html` directly in your browser to test themes, the mock toolbar popup, repo check, and log viewer before loading into Firefox.

## Install (in Firefox for development)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select `manifest.json` in this directory.
4. Click the LeetSync icon in the toolbar -> **Settings**.

## GitHub Setup

1. Create a GitHub repo (ensure it has an initial README so the `main` branch exists).
2. Go to **GitHub -> Settings -> Developer settings -> Fine-grained tokens** -> generate a token for your repo with **Contents: Read and write**.
3. Paste token, owner, repo, and branch into the LeetSync settings, click **Test Connection**, and click **Save**.

## Testing the Interactive Prototype

Open `prototype.html` in Firefox or any browser:
- Try switching themes (GitHub Dark, LeetCode Dark, Midnight, Clean Light).
- Click the toolbar icon to toggle the popup dropdown.
- Test the "1. Two Sum" code submission simulator to watch queueing, atomic commit creation, and live streaming logs.
- Test the "Repo Check" scanner to see how LeetHub migrations avoid folder collisions.
