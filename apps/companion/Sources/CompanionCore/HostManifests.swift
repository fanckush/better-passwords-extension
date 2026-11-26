import Foundation

/// The small JSON files that let a browser start a native program for an extension. The companion
/// writes two per browser: one for Apple's helper (our bridge, the same file
/// scripts/setup-mac.sh writes) and one for its own native host.
public struct HostManifest: Codable, Equatable, Sendable {
    public var name: String
    public var description: String
    public var path: String
    public var type = "stdio"
    public var allowedOrigins: [String]?
    public var allowedExtensions: [String]?

    enum CodingKeys: String, CodingKey {
        case name, description, path, type
        case allowedOrigins = "allowed_origins"
        case allowedExtensions = "allowed_extensions"
    }
}

public struct Browser: Equatable, Sendable {
    public enum Kind: Sendable { case chromium, firefox }
    public let name: String
    /// Directory under ~/Library/Application Support holding the browser's data.
    public let dataDirectory: String
    public let kind: Kind
    /// Directory under ~/Library/Application Support whose NativeMessagingHosts the browser reads:
    /// its own for most Chromium browsers, Mozilla's shared one for Firefox and its forks, another
    /// browser's for one without its own (Search, Orion).
    public let manifestDirectory: String
    /// Whether the browser reads its own folder instead when `manifestDirectory`'s
    /// NativeMessagingHosts can't be created. Brave does: it creates Chrome's at startup and, if
    /// that fails (the Google folder is locked, say, to keep Google's updater out), keeps its own.
    public let fallsBackToOwnFolder: Bool
    /// The app's bundle identifier: for its icon, and to tell which browser is asking. nil while
    /// unknown; the browser is then recognised by its name.
    public let bundleID: String?

    public init(
        name: String, dataDirectory: String, kind: Kind, bundleID: String? = nil, manifestDirectory: String? = nil,
        fallsBackToOwnFolder: Bool = false
    ) {
        self.name = name
        self.dataDirectory = dataDirectory
        self.kind = kind
        self.bundleID = bundleID
        self.manifestDirectory = manifestDirectory ?? (kind == .firefox ? "Mozilla" : dataDirectory)
        self.fallsBackToOwnFolder = fallsBackToOwnFolder
    }
}

public enum HostManifests {
    /// Keep in sync with BROWSERS in scripts/setup-mac.sh.
    public static let browsers: [Browser] = [
        Browser(name: "Google Chrome", dataDirectory: "Google/Chrome", kind: .chromium, bundleID: "com.google.Chrome"),
        Browser(
            name: "Google Chrome Beta", dataDirectory: "Google/Chrome Beta", kind: .chromium,
            bundleID: "com.google.Chrome.beta"),
        Browser(
            name: "Google Chrome Dev", dataDirectory: "Google/Chrome Dev", kind: .chromium,
            bundleID: "com.google.Chrome.dev"),
        Browser(
            name: "Google Chrome Canary", dataDirectory: "Google/Chrome Canary", kind: .chromium,
            bundleID: "com.google.Chrome.canary"),
        Browser(name: "Chromium", dataDirectory: "Chromium", kind: .chromium, bundleID: "org.chromium.Chromium"),
        // Brave reads native messaging hosts from Chrome's folder, not its own (brave-core's
        // BraveMainDelegate::PreSandboxStartup overrides DIR_USER_NATIVE_MESSAGING on Mac), unless
        // it can't create Chrome's: then the override fails and it reads its own.
        Browser(
            name: "Brave", dataDirectory: "BraveSoftware/Brave-Browser", kind: .chromium, bundleID: "com.brave.Browser",
            manifestDirectory: "Google/Chrome", fallsBackToOwnFolder: true),
        Browser(
            name: "Brave Beta", dataDirectory: "BraveSoftware/Brave-Browser-Beta", kind: .chromium,
            bundleID: "com.brave.Browser.beta", manifestDirectory: "Google/Chrome", fallsBackToOwnFolder: true),
        Browser(
            name: "Brave Origin", dataDirectory: "BraveSoftware/Brave-Origin", kind: .chromium,
            bundleID: "com.brave.Browser.origin", manifestDirectory: "Google/Chrome", fallsBackToOwnFolder: true),
        Browser(
            name: "Microsoft Edge", dataDirectory: "Microsoft Edge", kind: .chromium, bundleID: "com.microsoft.edgemac"),
        Browser(name: "Vivaldi", dataDirectory: "Vivaldi", kind: .chromium, bundleID: "com.vivaldi.Vivaldi"),
        Browser(name: "Arc", dataDirectory: "Arc/User Data", kind: .chromium, bundleID: "company.thebrowser.Browser"),
        Browser(name: "Dia", dataDirectory: "Dia/User Data", kind: .chromium, bundleID: "company.thebrowser.dia"),
        Browser(name: "Helium", dataDirectory: "net.imput.helium", kind: .chromium, bundleID: "net.imput.helium"),
        Browser(name: "Crest", dataDirectory: "Crest/Chromium", kind: .chromium),
        Browser(
            name: "Ardia", dataDirectory: "com.ardia.browser/Chromium", kind: .chromium, bundleID: "com.ardia.browser"),
        Browser(name: "Yab", dataDirectory: "Yab/Chromium", kind: .chromium, bundleID: "dev.serafim.fast"),
        Browser(name: "Stedding", dataDirectory: "Stedding", kind: .chromium, bundleID: "dev.stedding.Stedding"),
        // A WebKit browser that runs Chrome extensions. It has no NativeMessagingHosts folder of its
        // own and reads Chrome's, Chromium's, Edge's, Brave's, Arc's and Vivaldi's. Chromium's is the
        // least likely to be a browser the user has.
        Browser(
            name: "Search", dataDirectory: "Search", kind: .chromium, bundleID: "com.officecommun.search",
            manifestDirectory: "Chromium"),
        // Kagi's WebKit browser, which runs Chrome and Firefox extensions. It has no
        // NativeMessagingHosts folder of its own and reads Chrome's, Brave's, Edge's, Opera's and
        // Mozilla's. It doesn't check allowed_origins, so Chrome's manifests serve it as they are.
        Browser(
            name: "Orion", dataDirectory: "Orion", kind: .chromium, bundleID: "com.kagi.kagimacOS",
            manifestDirectory: "Google/Chrome"),
        Browser(name: "Firefox", dataDirectory: "Firefox", kind: .firefox, bundleID: "org.mozilla.firefox"),
        Browser(name: "Zen", dataDirectory: "zen", kind: .firefox, bundleID: "app.zen-browser.zen"),
    ]

    /// Browsers whose data directory exists under `support` (normally ~/Library/Application Support).
    public static func installed(in support: URL) -> [Browser] {
        browsers.filter { isInstalled($0, in: support) }
    }

    /// Whether `browser`'s data directory exists. One holding only a NativeMessagingHosts folder
    /// doesn't count: that was made for manifests (ours for Search or Orion, or another app's), not
    /// by the browser.
    static func isInstalled(_ browser: Browser, in support: URL) -> Bool {
        var isDirectory: ObjCBool = false
        let path = support.appendingPathComponent(browser.dataDirectory).path
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return false
        }
        let contents = Set((try? FileManager.default.contentsOfDirectory(atPath: path)) ?? [])
        return contents.subtracting([".DS_Store"]) != ["NativeMessagingHosts"]
    }

    /// The NativeMessagingHosts folder the browser reads. For one that falls back to its own
    /// folder, that's its own while the shared one doesn't exist (see `install`).
    public static func directory(for browser: Browser, in support: URL) -> URL {
        let shared = sharedDirectory(for: browser, in: support)
        guard browser.fallsBackToOwnFolder else { return shared }
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: shared.path, isDirectory: &isDirectory), isDirectory.boolValue {
            return shared
        }
        return ownDirectory(for: browser, in: support)
    }

    private static func sharedDirectory(for browser: Browser, in support: URL) -> URL {
        support.appendingPathComponent(browser.manifestDirectory).appendingPathComponent("NativeMessagingHosts")
    }

    private static func ownDirectory(for browser: Browser, in support: URL) -> URL {
        support.appendingPathComponent(browser.dataDirectory).appendingPathComponent("NativeMessagingHosts")
    }

    /// Every folder the browser may read, for removing our manifests from all of them.
    private static func directories(for browser: Browser, in support: URL) -> [URL] {
        let shared = sharedDirectory(for: browser, in: support)
        return browser.fallsBackToOwnFolder ? [shared, ownDirectory(for: browser, in: support)] : [shared]
    }

    /// The two manifests for one browser.
    public static func manifests(for browser: Browser, hostPath: String) -> [HostManifest] {
        switch browser.kind {
        case .chromium:
            return [
                HostManifest(
                    name: Identity.bridgeHost,
                    description: "Better Passwords: Apple's password helper",
                    path: Identity.helperPath,
                    allowedOrigins: [origin(Identity.extensionID)]),
                HostManifest(
                    name: Identity.companionHost,
                    description: "Better Passwords: Touch ID companion",
                    path: hostPath,
                    allowedOrigins: [origin(Identity.extensionID)]),
            ]
        case .firefox:
            return [
                HostManifest(
                    name: Identity.bridgeHost,
                    description: "Better Passwords: Apple's password helper",
                    path: Identity.helperPath,
                    allowedExtensions: [Identity.firefoxExtensionID]),
                HostManifest(
                    name: Identity.companionHost,
                    description: "Better Passwords: Touch ID companion",
                    path: hostPath,
                    allowedExtensions: [Identity.firefoxExtensionID]),
            ]
        }
    }

    private static func origin(_ id: String) -> String { "chrome-extension://\(id)/" }

    public static func encode(_ manifest: HostManifest) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(manifest)
    }

    /// Writes both manifests for every installed browser. Returns the browsers it set up.
    @discardableResult
    public static func install(hostPath: String, support: URL) throws -> [Browser] {
        let targets = installed(in: support)
        for browser in targets { try install(browser, hostPath: hostPath, support: support) }
        return targets
    }

    /// Writes both manifests for one browser (and so for the browsers `sharing` its folder).
    /// A browser that falls back to its own folder gets the manifests where it will look: the
    /// shared folder if it exists or can be created (the browser creates it too), its own if not.
    public static func install(_ browser: Browser, hostPath: String, support: URL) throws {
        var directory = sharedDirectory(for: browser, in: support)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch  where browser.fallsBackToOwnFolder {
            directory = ownDirectory(for: browser, in: support)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        for manifest in manifests(for: browser, hostPath: hostPath) {
            try encode(manifest).write(to: directory.appendingPathComponent("\(manifest.name).json"), options: .atomic)
        }
    }

    /// Removes our manifests from every browser. Leaves Apple's own manifests alone.
    public static func uninstall(support: URL) {
        for browser in browsers { uninstall(browser, support: support) }
    }

    /// Removes our manifests from one browser (and so from the browsers `sharing` its folder).
    public static func uninstall(_ browser: Browser, support: URL) {
        for directory in directories(for: browser, in: support) {
            for name in [Identity.bridgeHost, Identity.companionHost] {
                try? FileManager.default.removeItem(at: directory.appendingPathComponent("\(name).json"))
            }
        }
    }

    /// The installed browsers that read their manifests from `browser`'s folder, `browser` included:
    /// Firefox and its forks all read Mozilla's, so they connect and disconnect together.
    public static func sharing(_ browser: Browser, in support: URL) -> [Browser] {
        let directory = directory(for: browser, in: support)
        return installed(in: support).filter { self.directory(for: $0, in: support) == directory }
    }

    /// The known browser an app is: by its bundle identifier, or by its name for a browser whose
    /// identifier isn't known.
    public static func browser(bundleID: String?, name: String?) -> Browser? {
        if let bundleID, let match = browsers.first(where: { $0.bundleID == bundleID }) { return match }
        guard let name else { return nil }
        return browsers.first { $0.bundleID == nil && $0.name == name }
    }

    /// Where the companion manifests of installed browsers point. Another path than ours means the
    /// browsers were connected from a copy of the app somewhere else.
    public static func companionHostPaths(support: URL) -> [String] {
        installed(in: support).compactMap { browser in
            let file = directory(for: browser, in: support).appendingPathComponent("\(Identity.companionHost).json")
            guard let data = try? Data(contentsOf: file) else { return nil }
            return (try? JSONDecoder().decode(HostManifest.self, from: data))?.path
        }
    }

    /// Installed browsers whose companion manifest points at another copy of the app than
    /// `hostPath` (the app was moved, say from Downloads). Browsers without one aren't listed.
    public static func pointingElsewhere(hostPath: String, support: URL) -> [Browser] {
        installed(in: support).filter { browser in
            let file = directory(for: browser, in: support).appendingPathComponent("\(Identity.companionHost).json")
            guard let data = try? Data(contentsOf: file),
                let manifest = try? JSONDecoder().decode(HostManifest.self, from: data)
            else { return false }
            return manifest.path != hostPath
        }
    }

    /// Browsers that have both of our manifests, with the companion one pointing at `hostPath`.
    public static func connected(hostPath: String, support: URL) -> [Browser] {
        installed(in: support).filter { isConnected($0, hostPath: hostPath, support: support) }
    }

    /// Whether `browser` has both of our manifests, with the companion one pointing at `hostPath`.
    public static func isConnected(_ browser: Browser, hostPath: String, support: URL) -> Bool {
        let directory = directory(for: browser, in: support)
        return manifests(for: browser, hostPath: hostPath).allSatisfy { manifest in
            guard let data = try? Data(contentsOf: directory.appendingPathComponent("\(manifest.name).json")),
                let found = try? JSONDecoder().decode(HostManifest.self, from: data)
            else { return false }
            return found == manifest
        }
    }
}
