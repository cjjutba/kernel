/** Usage data's key and host, put in at build time from KERNEL_TELEMETRY_KEY and KERNEL_TELEMETRY_HOST (KERNEL-397). */
declare const __KERNEL_TELEMETRY__: { key: string; host: string }

/** A file's text, bundled at build time. Kernel's own review prompts in `docs/lenses` load this way (KERNEL-549). */
declare module '*.md?raw' { const text: string; export default text }
