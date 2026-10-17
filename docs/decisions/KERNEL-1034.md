# KERNEL-1034: terminal seats are off in v1, behind one engine flag

**Terminal seats are switched off in the engine, and the code stays.** Plain `claude` in the user's own terminal app is the better way to use Claude Code in a terminal, so v1 ships without seats (KERNEL-996 and its sub-issues). The renderer side is KERNEL-1035.

- The flag is `SEATS_ENABLED` in `src/main/services/seatsFlag.ts`, set to `false`. Nothing reads a setting for it.
- While it is off, Settings, Terminal's saved `connect` and `teammatesRunIn` (app and project) are ignored and act as off and Kernel. A saved `connect: true` can't turn seats back on, since the Settings rows are going away.
- A big terminal tab starts as a plain terminal: no seat token, no Kernel MCP config, no appended Lead prompt, no `claude` shell function and no `KERNEL_*` seat variables. `Seats.seated` is the one check, and `Chats.seatsUp` and `Seats.launch` both read it.
- Every hand-off runs in Kernel. `create_workspace` doesn't offer `runs_in`, so the Lead's tools never mention terminal teammates. `terminal.presets` leaves out the `lead` preset, and asking for it is refused as a preset that is gone.
- The seat MCP endpoint starts only when a seat's pty starts, so it, the transcript followers and the seat update queues never start for a plain terminal.
- A teammate seat a hand-off made before the switch (`terminal.handoff` on its chat) still starts as a seat, so a workspace running that way finishes its work. Nothing new becomes one. A Lead terminal tab from before opens as a plain terminal.
- Setting the flag to `true` restores every behavior as it was before this change, settings included. The seat tests mock the flag on, so that code stays covered.

KERNEL-1034
