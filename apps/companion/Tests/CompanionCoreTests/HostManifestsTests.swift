import Foundation
import Testing

@testable import CompanionCore

/// A browser's data folder under `support`, with a profile in it as a browser that has run has.
func makeBrowserFolder(_ path: String, in support: URL) throws {
    try FileManager.default.createDirectory(
        at: support.appendingPathComponent(path).appendingPathComponent("Default"), withIntermediateDirectories: true)
}

@Suite struct HostManifestsTests {
    private func temporarySupport(with browsers: [String]) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        for browser in browsers {
            try makeBrowserFolder(browser, in: root)
        }
        return root
    }

    @Test func installsOnlyForInstalledBrowsers() throws {
        let support = try temporarySupport(with: ["Google/Chrome", "Firefox"])
        defer { try? FileManager.default.removeItem(at: support) }

        let done = try HostManifests.install(hostPath: "/Applications/X.app/host", support: support)
        #expect(done.map(\.name) == ["Google Chrome", "Firefox"])
        #expect(HostManifests.connected(hostPath: "/Applications/X.app/host", support: support).count == 2)
        // a moved app means the companion manifest is stale
        #expect(HostManifests.connected(hostPath: "/elsewhere/host", support: support).isEmpty)

        let chrome = support.appendingPathComponent("Google/Chrome/NativeMessagingHosts")
        let bridge =
            try JSONSerialization.jsonObject(
                with: Data(contentsOf: chrome.appendingPathComponent("io.github.fanckush.betterpasswords.bridge.json")))
            as? [String: Any]
        #expect(bridge?["path"] as? String == Identity.helperPath)
        #expect(bridge?["allowed_origins"] as? [String] == ["chrome-extension://ocongmkplhijgajnipnhhggfcjfdilgj/"])
        #expect(!FileManager.default.fileExists(atPath: support.appendingPathComponent("Chromium").path))
    }

    @Test func firefoxForksShareMozillasManifests() throws {
        // Zen alone, no Firefox: it reads Mozilla's folder, which may not exist yet
        let support = try temporarySupport(with: ["zen"])
        defer { try? FileManager.default.removeItem(at: support) }

        let done = try HostManifests.install(hostPath: "/h", support: support)
        #expect(done.map(\.name) == ["Zen"])
        let mozilla = support.appendingPathComponent("Mozilla/NativeMessagingHosts")
        #expect(
            FileManager.default.fileExists(
                atPath: mozilla.appendingPathComponent("io.github.fanckush.betterpasswords.bridge.json").path))
        #expect(
            !FileManager.default.fileExists(atPath: support.appendingPathComponent("zen/NativeMessagingHosts").path))
        #expect(HostManifests.connected(hostPath: "/h", support: support).map(\.name) == ["Zen"])
    }

    @Test func searchUsesChromiumsFolderWithoutLookingLikeChromium() throws {
        let support = try temporarySupport(with: ["Search"])
        defer { try? FileManager.default.removeItem(at: support) }

        let done = try HostManifests.install(hostPath: "/h", support: support)
        #expect(done.map(\.name) == ["Search"])
        let chromium = support.appendingPathComponent("Chromium/NativeMessagingHosts")
        #expect(
            FileManager.default.fileExists(
                atPath: chromium.appendingPathComponent("io.github.fanckush.betterpasswords.companion.json").path))
        // the folder made for Search's manifests isn't a Chromium install
        #expect(HostManifests.installed(in: support).map(\.name) == ["Search"])
        #expect(HostManifests.connected(hostPath: "/h", support: support).map(\.name) == ["Search"])
        #expect(HostManifests.browser(bundleID: "com.officecommun.search", name: "Search")?.name == "Search")
    }

    @Test func aRealChromiumSharesItsFolderWithSearch() throws {
        let support = try temporarySupport(with: ["Search", "Chromium"])
        defer { try? FileManager.default.removeItem(at: support) }

        try HostManifests.install(hostPath: "/h", support: support)
        let search = HostManifests.browsers.first { $0.name == "Search" }!
        #expect(HostManifests.sharing(search, in: support).map(\.name) == ["Chromium", "Search"])
    }

    @Test func firefoxManifestsUseExtensionIDs() throws {
        let firefox = HostManifests.browsers.first { $0.kind == .firefox }!
        for manifest in HostManifests.manifests(for: firefox, hostPath: "/h") {
            #expect(manifest.allowedOrigins == nil)
            #expect(manifest.allowedExtensions == [Identity.firefoxExtensionID])
        }
    }

    @Test func bothChromiumHostsAllowOnlyOurExtension() {
        let chrome = HostManifests.browsers[0]
        let manifests = HostManifests.manifests(for: chrome, hostPath: "/h")
        #expect(manifests.count == 2)
        for manifest in manifests {
            #expect(manifest.allowedOrigins == ["chrome-extension://ocongmkplhijgajnipnhhggfcjfdilgj/"])
            #expect(manifest.allowedExtensions == nil)
        }
    }

    @Test func uninstallRemovesOnlyOurFiles() throws {
        let support = try temporarySupport(with: ["Google/Chrome"])
        defer { try? FileManager.default.removeItem(at: support) }
        try HostManifests.install(hostPath: "/h", support: support)
        let directory = support.appendingPathComponent("Google/Chrome/NativeMessagingHosts")
        let apple = directory.appendingPathComponent("com.apple.passwordmanager.json")
        try Data("{}".utf8).write(to: apple)

        HostManifests.uninstall(support: support)
        let left = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        #expect(left == ["com.apple.passwordmanager.json"])
    }

    @Test func tellsWhereConnectedBrowsersPoint() throws {
        let support = try temporarySupport(with: ["Google/Chrome", "Firefox"])
        defer { try? FileManager.default.removeItem(at: support) }
        #expect(HostManifests.companionHostPaths(support: support).isEmpty)
        try HostManifests.install(hostPath: "/Users/jane/Downloads/X.app/host", support: support)
        #expect(
            HostManifests.companionHostPaths(support: support) == [
                "/Users/jane/Downloads/X.app/host", "/Users/jane/Downloads/X.app/host",
            ])
    }
}

@Suite struct BrowserLinksTests {
    private func setUp(_ browsers: [String]) throws -> (URL, BrowserLinks) {
        let support = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        for browser in browsers {
            try makeBrowserFolder(browser, in: support)
        }
        let defaults = UserDefaults(suiteName: "BrowserLinksTests.\(UUID().uuidString)")!
        return (support, BrowserLinks(defaults: defaults))
    }

    private func names(_ browsers: [Browser]) -> [String] { browsers.map(\.name) }

    @Test func connectsNothingBeforeSetup() throws {
        let (support, links) = try setUp(["Google/Chrome"])
        defer { try? FileManager.default.removeItem(at: support) }
        #expect(links.connectNew(hostPath: "/h", support: support).isEmpty)
        #expect(HostManifests.connected(hostPath: "/h", support: support).isEmpty)
    }

    @Test func connectsNewBrowsersButNotDisconnectedOnes() throws {
        let (support, links) = try setUp(["Google/Chrome", "net.imput.helium"])
        defer { try? FileManager.default.removeItem(at: support) }
        let helium = HostManifests.browsers.first { $0.name == "Helium" }!
        links.autoConnect = true
        #expect(names(links.connectNew(hostPath: "/h", support: support)) == ["Google Chrome", "Helium"])
        #expect(links.connectNew(hostPath: "/h", support: support).isEmpty)

        links.disconnect(helium, support: support)
        #expect(names(HostManifests.connected(hostPath: "/h", support: support)) == ["Google Chrome"])
        // a browser installed since is connected; the disconnected one stays so
        try makeBrowserFolder("com.ardia.browser/Chromium", in: support)
        #expect(names(links.connectNew(hostPath: "/h", support: support)) == ["Ardia"])

        try links.connect(helium, hostPath: "/h", support: support)
        #expect(links.disconnected.isEmpty)
        #expect(HostManifests.isConnected(helium, hostPath: "/h", support: support))
    }

    @Test func connectingOneBrowserDoesntSetUpTheRest() throws {
        // after Remove Setup, a link from one browser (any web page can open it) connects only that one
        let (support, links) = try setUp(["Google/Chrome", "net.imput.helium"])
        defer { try? FileManager.default.removeItem(at: support) }
        let helium = HostManifests.browsers.first { $0.name == "Helium" }!
        links.reset()
        try links.connect(helium, hostPath: "/h", support: support)
        #expect(!links.autoConnect)
        #expect(links.connectNew(hostPath: "/h", support: support).isEmpty)
        #expect(names(HostManifests.connected(hostPath: "/h", support: support)) == ["Helium"])
    }

    @Test func repairsOnlyBrowsersPointingAtAMovedApp() throws {
        let (support, links) = try setUp(["Google/Chrome", "net.imput.helium"])
        defer { try? FileManager.default.removeItem(at: support) }
        let helium = HostManifests.browsers.first { $0.name == "Helium" }!
        try HostManifests.install(hostPath: "/Downloads/host", support: support)
        links.disconnect(helium, support: support)
        #expect(
            names(HostManifests.pointingElsewhere(hostPath: "/Applications/host", support: support)) == [
                "Google Chrome"
            ])
        #expect(HostManifests.pointingElsewhere(hostPath: "/Downloads/host", support: support).isEmpty)
    }

    @Test func takesBrowsersConnectedByAnOlderAppAsSetUp() throws {
        let (support, links) = try setUp(["Google/Chrome"])
        defer { try? FileManager.default.removeItem(at: support) }
        try HostManifests.install(hostPath: "/h", support: support)
        try makeBrowserFolder("net.imput.helium", in: support)
        #expect(names(links.connectNew(hostPath: "/h", support: support)) == ["Helium"])
        #expect(links.autoConnect)
    }

    @Test func looksForAnOlderSetupOnlyOnce() throws {
        // a fresh install: nothing connected yet, so nothing is set up, even after a link connects one
        let (support, links) = try setUp(["Google/Chrome", "net.imput.helium"])
        defer { try? FileManager.default.removeItem(at: support) }
        let chrome = HostManifests.browsers.first { $0.name == "Google Chrome" }!
        try links.connect(chrome, hostPath: "/h", support: support)
        #expect(links.connectNew(hostPath: "/h", support: support).isEmpty)
        #expect(!links.autoConnect)
    }

    @Test func firefoxForksConnectAndDisconnectTogether() throws {
        let (support, links) = try setUp(["Firefox", "zen"])
        defer { try? FileManager.default.removeItem(at: support) }
        let zen = HostManifests.browsers.first { $0.name == "Zen" }!
        links.autoConnect = true
        links.connectNew(hostPath: "/h", support: support)
        links.disconnect(zen, support: support)
        #expect(links.disconnected == ["Firefox", "Zen"])
        #expect(HostManifests.connected(hostPath: "/h", support: support).isEmpty)
    }

    @Test func resetStopsReconnecting() throws {
        let (support, links) = try setUp(["Google/Chrome"])
        defer { try? FileManager.default.removeItem(at: support) }
        links.autoConnect = true
        links.disconnected = ["Helium"]
        links.setBlocked("Ardia", true)
        links.reset()
        #expect(!links.autoConnect)
        #expect(links.disconnected.isEmpty)
        #expect(links.blocked == ["Ardia"])
    }

    @Test func remembersBlockedBrowsersUntilTheyWork() throws {
        let (_, links) = try setUp([])
        links.setBlocked("Ardia", true)
        #expect(links.blocked == ["Ardia"])
        links.setBlocked("Ardia", false)
        #expect(links.blocked.isEmpty)
    }

    @Test func recognisesBrowsersByBundleIDOrName() {
        #expect(HostManifests.browser(bundleID: "com.ardia.browser", name: "Ardia")?.name == "Ardia")
        #expect(HostManifests.browser(bundleID: "com.example.unknown", name: "Crest")?.name == "Crest")
        // a name alone doesn't stand in for a browser whose identifier is known
        #expect(HostManifests.browser(bundleID: "com.example.fake", name: "Google Chrome") == nil)
        #expect(HostManifests.browser(bundleID: "com.apple.Terminal", name: "Terminal") == nil)
    }
}
