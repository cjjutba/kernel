---
type: internal
issue: KERNEL-812
---
A killed test run no longer leaves vitest workers running, and its test slot stays taken until they are gone.
