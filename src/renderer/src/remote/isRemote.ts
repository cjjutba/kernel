/**
 * True in a browser paired over Remote access, false in the app's own window (remote-web-client). The Mac refuses what only makes
 * sense there (Terminal, Finder, an editor, pickers, settings writes), so a screen hides or disables those controls when this is
 * true, instead of letting a click end in an error.
 */
export const isRemote = (): boolean => typeof window !== 'undefined' && window.kernel?.remote === true

/** The reason shown for a control that needs the Mac itself. */
export const ON_THE_MAC = 'Only available in Kernel on your Mac'
