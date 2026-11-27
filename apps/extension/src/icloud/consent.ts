// Hide My Email sends an email alias and site label to Apple using iCloud session cookies.
// Site information is already declared for the core native password lookup in Firefox.
export const HME_DATA_PERMISSIONS = ["personallyIdentifyingInfo", "websiteContent"];

/** The port the popup holds open while it asks for these permissions (Firefox only). */
export const HME_CONSENT_PORT = "hide-my-email-consent";

interface DataPermissions {
  contains(permissions: { data_collection: string[] }): Promise<boolean>;
  request(permissions: { data_collection: string[] }): Promise<boolean>;
}

// WXT's browser types don't yet expose Firefox's data_collection permission field.
function permissions(): DataPermissions {
  return browser.permissions as unknown as DataPermissions;
}

export function hasHideMyEmailConsent(): Promise<boolean> {
  return import.meta.env.FIREFOX
    ? permissions().contains({ data_collection: HME_DATA_PERMISSIONS })
    : Promise.resolve(true);
}

/** Call directly from a user event, before awaiting anything else. */
export function requestHideMyEmailConsent(): Promise<boolean> {
  return import.meta.env.FIREFOX
    ? permissions().request({ data_collection: HME_DATA_PERMISSIONS })
    : Promise.resolve(true);
}
