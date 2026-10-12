**Picking a mode in the composer changes that chat and nothing else.** The composer writes `mode` or `plan` on the chat and never touches Settings or the room's override. A chat that never picked a mode keeps following its room, then Settings. Clicking the row that is already checked does nothing, so a chat doesn't stop following Settings by accident. KERNEL-456.

**The first Bypass permissions pick in a chat asks through ConfirmBypass, and saving it sets only that chat's mode.** `ConfirmBypass` takes a `chatId` next to `roomId`. The one-time flag still covers every other way in. KERNEL-456.

**Permission mode is in the + menu of a chat's composer only.** New workspace and New chat with Rowan have no mode menu to open, so their + menu keeps Enter plan mode and Shift+Tab still toggles plan there. KERNEL-456.

**At 420px and narrower the mode loses its name and keeps its icon.** The agent pill goes at the same width (D-080), and the button's accessible name still says the mode. The canvas doesn't draw this width. KERNEL-456.
