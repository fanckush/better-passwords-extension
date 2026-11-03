import ApplicationServices
import CompanionCore
import Foundation
import Observation
import ServiceManagement

/// The three things the companion needs, and how far along each one is.
@MainActor
@Observable
final class SetupModel {
    private(set) var connectedBrowsers: [Browser] = []
    private(set) var installedBrowsers: [Browser] = []
    /// Browsers the user disconnected, and browsers macOS blocks (see `BrowserLinks`).
    private(set) var disconnectedBrowsers: Set<String> = []
    private(set) var blockedBrowsers: Set<String> = []
    /// What opening the app from a browser did, shown at the top of the window.
    private(set) var banner: Banner?
    /// The user has connected browsers before: the window shows what's set up, not the steps.
    private(set) var wasSetUp = false
    private(set) var agentStatus: SMAppService.Status = .notRegistered
    private(set) var accessibilityTrusted = false
    private(set) var contactsAllowed = false
    /// A newer version the agent has seen in the appcast.
    private(set) var availableUpdate: String?
    private(set) var lastError: String?

    private let agent = SMAppService.agent(plistName: Identity.agentPlistName)
    private let links = BrowserLinks()
    private let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]

    var hostPath: String {
        Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/\(Identity.hostExecutableName)").path
    }

    /// Every installed browser the user hasn't disconnected is connected. Having disconnected them
    /// all is a choice too, not a setup left to finish.
    var browsersConnected: Bool {
        let wanted = installedBrowsers.filter { !disconnectedBrowsers.contains($0.name) }
        if wanted.isEmpty { return !installedBrowsers.isEmpty }
        return wanted.allSatisfy { browser in connectedBrowsers.contains { $0.name == browser.name } }
    }

    enum Banner: Equatable {
        /// The browser that opened the link is connected now.
        case connected(String)
        /// It's connected, but its extension said macOS blocks Apple's helper there.
        case blocked(String)
        /// macOS didn't say which app opened the link, so every browser was connected.
        case allConnected
        /// An app this version doesn't know as a browser opened the link.
        case unknown(String)
    }

    enum BrowserState { case connected, blocked, notConnected, disconnected }

    struct BrowserRow: Identifiable {
        let browser: Browser
        let state: BrowserState
        /// Other installed browsers that share its connection (Firefox and its forks).
        let sharedWith: [String]
        var id: String { browser.name }
    }

    var browserRows: [BrowserRow] {
        installedBrowsers.map { browser in
            let connected = connectedBrowsers.contains { $0.name == browser.name }
            let state: BrowserState =
                connected
                ? (blockedBrowsers.contains(browser.name) ? .blocked : .connected)
                : (disconnectedBrowsers.contains(browser.name) ? .disconnected : .notConnected)
            let shared = installedBrowsers.filter {
                $0.manifestDirectory == browser.manifestDirectory && $0.name != browser.name
            }
            return BrowserRow(browser: browser, state: state, sharedWith: shared.map(\.name))
        }
    }
    var agentEnabled: Bool { agentStatus == .enabled }
    var ready: Bool { browsersConnected && agentEnabled && accessibilityTrusted }
    /// Something the user can fix: a step turned off, or a browser that isn't connected. A browser
    /// macOS blocks isn't one; nothing in the app can fix that.
    var needsAttention: Bool { !agentEnabled || !accessibilityTrusted || !browsersConnected }

    /// macOS ties a registered background agent to the exact build that registered it (for ad-hoc
    /// signed builds, by code hash), and to where that build was. After a rebuild, an update or a
    /// move, the old registration can no longer start the agent, so the app re-registers it.
    func reRegisterIfRebuilt() {
        let key = "registeredBuild"
        guard let build = registeredBuild else { return }
        // no record (an older build registered it) counts as a different build
        guard agent.status == .enabled, UserDefaults.standard.string(forKey: key) != build else {
            UserDefaults.standard.set(build, forKey: key)
            return
        }
        Task {
            // the asynchronous unregister returns once macOS has dropped the old registration;
            // registering right after the synchronous one keeps the old build's pin. A fresh handle,
            // as older compilers won't send the main actor's one to the nonisolated method
            try? await SMAppService.agent(plistName: Identity.agentPlistName).unregister()
            perform { try agent.register() }
            UserDefaults.standard.set(build, forKey: key)
        }
    }

    /// This build and where it is, as recorded when it registers the agent.
    private var registeredBuild: String? {
        CodeSigning.ownCDHash().map { "\($0) \(Bundle.main.bundleURL.path)" }
    }

    /// Browsers connected from a copy of the app somewhere else (say, Downloads) would start a host
    /// that may be gone. Connect them to this copy; leave the others as they are.
    func reconnectIfMoved() {
        let moved = HostManifests.pointingElsewhere(hostPath: hostPath, support: support)
        guard !moved.isEmpty else { return }
        perform { for browser in moved { try HostManifests.install(browser, hostPath: hostPath, support: support) } }
    }

    func refresh() {
        installedBrowsers = HostManifests.installed(in: support)
        connectedBrowsers = HostManifests.connected(hostPath: hostPath, support: support)
        disconnectedBrowsers = links.disconnected
        blockedBrowsers = links.blocked
        wasSetUp = links.autoConnect
        agentStatus = agent.status
        accessibilityTrusted = AXIsProcessTrusted()
        contactsAllowed = ContactCard.allowed
        availableUpdate = AppInfo.availableUpdate
    }

    /// The setup's Connect: every installed browser, including ones disconnected before.
    func connectBrowsers() {
        links.autoConnect = true
        links.disconnected = []
        perform { try HostManifests.install(hostPath: hostPath, support: support) }
    }

    /// Browsers installed since setup, unless the user disconnected them.
    func connectNewBrowsers() {
        links.connectNew(hostPath: hostPath, support: support)
        refresh()
    }

    func connect(_ browser: Browser) {
        perform { try links.connect(browser, hostPath: hostPath, support: support) }
    }

    func disconnect(_ browser: Browser) {
        links.disconnect(browser, support: support)
        refresh()
    }

    /// The app was opened through betterpasswords://connect, normally from a browser's extension.
    /// Any web page can open the link too, so it connects the browser that opened it and nothing
    /// more. Other browsers are connected only if the user set things up already (and didn't
    /// disconnect them); after Remove Setup, nothing else is.
    func handle(_ request: LinkRequests.Request) {
        links.migrateIfNeeded(support: support)
        let sender = request.sender
        if let sender,
            let browser = HostManifests.browser(bundleID: sender.bundleIdentifier, name: sender.localizedName)
        {
            perform { try links.connect(browser, hostPath: hostPath, support: support) }
            links.connectNew(hostPath: hostPath, support: support)
            refresh()
            banner = blockedBrowsers.contains(browser.name) ? .blocked(browser.name) : .connected(browser.name)
            return
        }
        // macOS didn't say who opened it, or it isn't a browser this version knows
        let connected = links.connectNew(hostPath: hostPath, support: support)
        refresh()
        if let name = sender?.localizedName, sender?.bundleIdentifier != Identity.appBundleID {
            banner = .unknown(name)
        } else {
            // not set up: the setup steps are on screen, starting with Connect
            banner = links.autoConnect || !connected.isEmpty ? .allConnected : nil
        }
    }

    func dismissBanner() {
        banner = nil
    }

    func enableAgent() {
        if let build = registeredBuild { UserDefaults.standard.set(build, forKey: "registeredBuild") }
        perform { try agent.register() }
        if agent.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
    }

    /// Shows macOS's own prompt, which adds the app to the Accessibility list and links to it.
    func requestAccessibility() {
        // the constant's value; reading the imported global trips Swift 6's concurrency checks
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        accessibilityTrusted = AXIsProcessTrustedWithOptions(options)
    }

    /// Optional: lets the extension suggest the emails on the user's contact card.
    func requestContacts() {
        Task {
            _ = await ContactCard.requestAccess()
            refresh()
        }
    }

    /// Undoes everything the app set up. Accessibility can only be removed in System Settings.
    func removeAll() {
        links.reset()
        HostManifests.uninstall(support: support)
        perform { try agent.unregister() }
    }

    private func perform(_ action: () throws -> Void) {
        do {
            try action()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
        refresh()
    }
}
