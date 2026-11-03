import Foundation

/// What the user and the extension have said about each browser, beyond its manifests. Kept in the
/// app's defaults, which the agent shares (it is the same app). Browsers are keyed by name: not
/// every known browser has a known bundle identifier.
public struct BrowserLinks: @unchecked Sendable {
    let defaults: UserDefaults

    enum Key {
        static let autoConnect = "autoConnectBrowsers"
        static let disconnected = "disconnectedBrowsers"
        static let blocked = "blockedBrowsers"
        static let migrated = "browserLinksMigrated"
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Set once the user connects browsers, or opens the app from one; cleared by Remove Setup.
    /// Until it's set, nothing is connected on its own.
    public var autoConnect: Bool {
        get { defaults.bool(forKey: Key.autoConnect) }
        nonmutating set { defaults.set(newValue, forKey: Key.autoConnect) }
    }

    /// Browsers the user disconnected. They're never connected on their own again, only when the
    /// user asks (Connect, or opening the app from that browser).
    public var disconnected: Set<String> {
        get { Set(defaults.stringArray(forKey: Key.disconnected) ?? []) }
        nonmutating set { defaults.set(newValue.sorted(), forKey: Key.disconnected) }
    }

    /// Browsers whose extension reported that macOS kills Apple's helper as they start it (the
    /// helper's launch constraints let only browsers Apple approved start it).
    public var blocked: Set<String> {
        Set((defaults.dictionary(forKey: Key.blocked) ?? [:]).keys)
    }

    public func setBlocked(_ browser: String, _ isBlocked: Bool) {
        var reports = defaults.dictionary(forKey: Key.blocked) ?? [:]
        reports[browser] = isBlocked ? Date() : nil
        defaults.set(reports, forKey: Key.blocked)
    }

    /// Apps from before these settings connected browsers without saying so. Our host in a browser
    /// means the user clicked Connect (the setup script writes only the helper's manifest). Looked
    /// at once, before anything here connects a browser itself, which would look the same.
    public func migrateIfNeeded(support: URL) {
        guard !defaults.bool(forKey: Key.migrated) else { return }
        defaults.set(true, forKey: Key.migrated)
        if !HostManifests.companionHostPaths(support: support).isEmpty { autoConnect = true }
    }

    /// Connects installed browsers that aren't, except those the user disconnected, if the user
    /// set things up already. Returns the browsers it connected.
    @discardableResult
    public func connectNew(hostPath: String, support: URL) -> [Browser] {
        migrateIfNeeded(support: support)
        guard autoConnect else { return [] }
        let skipped = disconnected
        return HostManifests.installed(in: support).filter { browser in
            guard !skipped.contains(browser.name),
                !HostManifests.isConnected(browser, hostPath: hostPath, support: support)
            else { return false }
            return (try? HostManifests.install(browser, hostPath: hostPath, support: support)) != nil
        }
    }

    /// Connects one browser at the user's request, and those sharing its folder (see `sharing`).
    /// Only that: it doesn't turn on connecting the others (`autoConnect`).
    public func connect(_ browser: Browser, hostPath: String, support: URL) throws {
        migrateIfNeeded(support: support)
        let shared = HostManifests.sharing(browser, in: support).map(\.name) + [browser.name]
        disconnected.subtract(shared)
        try HostManifests.install(browser, hostPath: hostPath, support: support)
    }

    /// Disconnects one browser at the user's request, and those sharing its folder.
    public func disconnect(_ browser: Browser, support: URL) {
        let shared = HostManifests.sharing(browser, in: support).map(\.name) + [browser.name]
        disconnected.formUnion(shared)
        HostManifests.uninstall(browser, support: support)
    }

    /// Remove Setup: forgets the user's choices, so nothing reconnects on its own. What the
    /// extensions reported stays true, so it's kept.
    public func reset() {
        autoConnect = false
        disconnected = []
    }
}
