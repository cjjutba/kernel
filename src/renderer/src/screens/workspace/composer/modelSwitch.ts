export const SWITCH_TOAST = { title: 'Switching models mid-chat makes the next reply slower and uses more tokens.' }
export const SWITCH_TOAST_MS = 6000

const ranOn = new Map<string, string>()

export const noteOpened = (chatId: string, model: string) => { if (!ranOn.has(chatId)) ranOn.set(chatId, model) }
export const noteSent = (chatId: string, model: string) => { ranOn.set(chatId, model) }
export const lastRanOn = (chatId: string) => ranOn.get(chatId)

export const warnsOnSwitch = (started: boolean, lastRan: string | undefined, next: string) => started && lastRan !== undefined && lastRan !== next
