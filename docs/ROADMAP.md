# Roadmap

Work is tracked in a private Linear workspace: team Kernel, project "Kernel v1". This page is the map; Linear has the status.

## 1. Bring-up
- KERNEL-5 Get Kernel running on macOS (Engine)
- KERNEL-6 First real session round trip on a side project (Engine)
- KERNEL-7 Fixture mode and screenshot harness (Platform)

## 2. Contracts
- KERNEL-8 Every IPC channel, type, store slice and route (Engine)
- KERNEL-9 Design system in code: tokens and shared components (Platform)

## 3. Build (parallel lanes)
- Workspace: KERNEL-10 layout and transcript, 11 composer, 12 tabs and big terminal, 13 checkpoints, 14 agent turn cards, 15 PR flow, 16 new workspace modal
- Team: KERNEL-17 Home and Inbox, 18 Board and tasks, 19 Team and agents, 20 Rooms, 21 Search, account menu, Ask Rowan, History
- Floor: KERNEL-22 renderer and room states, 23 briefing sequence and walking, 24 floor moments
- Platform: KERNEL-25 Settings app pages, 26 Settings project pages, 27 first run, 28 limits and confirmations, 29 light theme (last)

## 4. Integrate and ship
- KERNEL-30 Packaging, code signing, notarization, auto-update
- KERNEL-31 End-to-end journey on a real side project

## Running the sprint

1. One Claude Code session does KERNEL-5, then 6 and 7.
2. Two sessions do KERNEL-8 and KERNEL-9 in parallel; merge both.
3. Open one Conductor workspace per lane (Workspace, Team, Floor, Platform, plus Engine for KERNEL-30 prep). Each works its lane's issues in order.
4. When the lanes land, run KERNEL-31.
