// Order matters: focus stops scrolling the page, the bridge installs window.kernel, then the renderer boots exactly as it
// does in Electron, then the Mac window's traffic lights and the first hint.
import './focus'
import './bridge'
import '../src/renderer/src/main.tsx'
import './chrome'
import './guide'
