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
    /// its own for Chromium browsers, Mozilla's shared one for Firefox and its forks.
    public let manifestDirectory: String
    /// The app's bundle identifier: for its icon, and to tell which browser is asking. nil while
    /// unknown; the browser is then recognised by its name.
    public let bundleID: String?

    public init(name: String, dataDirectory: String, kind: Kind, bundleID: String? = nil) {
        self.name = name
        self.dataDirectory = dataDirectory
        self.kind = kind
        self.bundleID = bundleID
        manifestDirectory = kind == .firefox ? "Mozilla" : dataDirectory
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
        Browser(
            name: "Brave", dataDirectory: "BraveSoftware/Brave-Browser", kind: .chromium, bundleID: "com.brave.Browser"),
        Browser(
            name: "Brave Beta", dataDirectory: "BraveSoftware/Brave-Browser-Beta", kind: .chromium,
            bundleID: "com.brave.Browser.beta"),
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
        Browser(name: "Firefox", dataDirectory: "Firefox", kind: .firefox, bundleID: "org.mozilla.firefox"),
        Browser(name: "Zen", dataDirectory: "zen", kind: .firefox, bundleID: "app.zen-browser.zen"),
    ]

    /// Browsers whose data directory exists under `support` (normally ~/Library/Application Support).
    public static func installed(in support: URL) -> [Browser] {
        browsers.filter { browser in
            var isDirectory: ObjCBool = false
            let path = support.appendingPathComponent(browser.dataDirectory).path
            return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
        }
    }

    public static func directory(for browser: Browser, in support: URL) -> URL {
        support.appendingPathComponent(browser.manifestDirectory).appendingPathComponent("NativeMessagingHosts")
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
    public static func install(_ browser: Browser, hostPath: String, support: URL) throws {
        let directory = directory(for: browser, in: support)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
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
        let directory = directory(for: browser, in: support)
        for name in [Identity.bridgeHost, Identity.companionHost] {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent("\(name).json"))
        }
    }

    /// The installed browsers that read their manifests from `browser`'s folder, `browser` included:
    /// Firefox and its forks all read Mozilla's, so they connect and disconnect together.
    public static func sharing(_ browser: Browser, in support: URL) -> [Browser] {
        installed(in: support).filter { $0.manifestDirectory == browser.manifestDirectory }
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
