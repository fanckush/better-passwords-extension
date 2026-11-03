// The extension's toolbar button: `action` in Manifest V3, `browserAction` in Firefox's Manifest V2.

export function toolbarAction(): typeof browser.action | undefined {
  return browser.action ?? (browser as unknown as { browserAction?: typeof browser.action }).browserAction;
}
