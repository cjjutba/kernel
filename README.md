# Kernel

A Mac app where Claude Code agents work as a team in a virtual office.

## Setup

1. Create the GitHub repo from this folder: `git init && git add -A && git commit -m "chore: initial import" && gh repo create kernel --private --source . --push`
2. In Linear, make sure the GitHub integration can see the new repo (Settings > Integrations > GitHub).
3. Give Claude Code access to Linear: `claude mcp add --transport http linear https://mcp.linear.app/mcp`, then run `/mcp` inside Claude Code to sign in.
4. `npm install`
5. `npm run dev`

Then start Claude Code in this folder and say: `/issue KERNEL-5`.

## Docs

`CLAUDE.md` is the entry point for agents. Humans: start with `docs/PRODUCT.md` and `docs/ROADMAP.md`.
