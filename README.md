# Conflict Monitor

A standalone React + Three.js dashboard mockup: a 3D WebGL globe with tracked
conflict hotspots, severity trends, and a country instability index strip.

## Running locally

```bash
npm install
npm run dev
```

Then open the printed local URL in your browser.

To produce a production build:

```bash
npm run build
```

The output goes to `dist/`.

## Deploying to GitHub Pages

This repo includes a GitHub Actions workflow
(`.github/workflows/deploy.yml`) that builds the app and publishes `dist/`
to GitHub Pages on every push to `main`.

**One-time setup after your first push:** in the GitHub repo, go to
**Settings → Pages → Source** and select **GitHub Actions** (not "Deploy
from a branch"). Without this, the workflow will run but nothing will be
published.

The site will be served at `https://<your-username>.github.io/conflict-monitor/`.
