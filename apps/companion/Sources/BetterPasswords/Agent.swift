import AppKit
import CompanionCore
import Foundation

/// The background agent: launchd starts the app with --agent when the native host first connects.
/// It holds the app's Accessibility permission, so the browser never needs it.
enum Agent {
    static func run() -> Never {
        // browsers installed since setup are connected without anyone opening the app
        if Installation.isInApplications(Bundle.main.bundleURL, home: FileManager.default.homeDirectoryForCurrentUser) {
            BrowserLinks().connectNew(
                hostPath: Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/\(Identity.hostExecutableName)")
                    .path,
                support: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0])
        }
        let delegate = ListenerDelegate()
        let listener = NSXPCListener(machServiceName: Identity.agentService)
        listener.delegate = delegate
        listener.resume()
        IdleExit.shared.touch()
        withExtendedLifetime((listener, delegate)) { dispatchMain() }
    }

    /// What the native host must satisfy. Release builds: signed by our team. Development builds
    /// (ad-hoc): the exact host binary built alongside this app, pinned by cdhash in Info.plist.
    static func clientRequirement() -> String? {
        if let team = CodeSigning.ownTeamID() {
            return CodeSigning.sameTeam(team, identifier: Identity.hostSigningID)
        }
        guard let cdhash = Bundle.main.object(forInfoDictionaryKey: Identity.hostCDHashKey) as? String else {
            return nil
        }
        return CodeSigning.pinned(identifier: Identity.hostSigningID, cdhash: cdhash)
    }
}

final class ListenerDelegate: NSObject, NSXPCListenerDelegate {
    private let requirement = Agent.clientRequirement()
    private let service = PairingCodeService()

    func listener(_: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        // fail closed: without a requirement we can't tell our host from anything else
        guard let requirement else { return false }
        connection.setCodeSigningRequirement(requirement)
        connection.exportedInterface = AgentInterface.make()
        connection.exportedObject = AgentSession(caller: connection.processIdentifier, service: service)
        connection.resume()
        IdleExit.shared.touch()
        return true
    }
}

/// One connection's view of the agent. The caller's PID comes from the XPC connection (the kernel),
/// never from the caller's own words.
final class AgentSession: NSObject, CompanionAgentProtocol, @unchecked Sendable {
    private let caller: pid_t
    private let service: PairingCodeService

    init(caller: pid_t, service: PairingCodeService) {
        self.caller = caller
        self.service = service
    }

    func status(reply: @escaping @Sendable (Bool) -> Void) {
        IdleExit.shared.touch()
        reply(AXIsProcessTrusted())
    }

    func myEmails(reply: @escaping @Sendable ([String]?, String?) -> Void) {
        IdleExit.shared.touch()
        // Any program can run our host binary, and so pass the XPC check. Only a browser can be
        // the parent of Apple's helper: anything else would read Contacts without permission.
        if case .failure(let error) = Processes.browser(behind: caller) { return reply(nil, error.rawValue) }
        switch ContactCard.myEmails() {
        case .success(let emails): reply(emails, nil)
        case .failure(let error): reply(nil, error.rawValue)
        }
    }

    func availableUpdate(reply: @escaping @Sendable (String?) -> Void) {
        IdleExit.shared.touch()
        reply(UpdateCheck.shared.available())
    }

    func reportHelper(blocked: Bool, reply: @escaping @Sendable (Bool) -> Void) {
        IdleExit.shared.touch()
        // The host's parent is the browser. Not Processes.browser(behind:): it needs a running copy
        // of Apple's helper, and in a blocked browser there is none. A program that runs our host
        // itself is its parent, which isn't a known browser, so it can't record anything.
        guard let parent = Processes.parent(of: caller), parent > 1,
            let app = NSRunningApplication(processIdentifier: parent),
            let browser = HostManifests.browser(bundleID: app.bundleIdentifier, name: app.localizedName)
        else { return reply(false) }
        BrowserLinks().setBlocked(browser.name, blocked)
        reply(true)
    }

    func readPairingCode(reply: @escaping @Sendable (String?, String?) -> Void) {
        IdleExit.shared.begin()
        let caller = caller
        let service = service
        Task {
            switch await service.read(for: caller) {
            case .success(let code): reply(code, nil)
            case .failure(let error): reply(nil, error.rawValue)
            }
            IdleExit.shared.end()
        }
    }
}

/// Reads the code for one browser at a time.
actor PairingCodeService {
    private var busy = false

    func read(for caller: pid_t) async -> Result<String, CompanionError> {
        guard !busy else { return .failure(.busy) }
        busy = true
        defer { busy = false }

        // The native host is a child of the browser, and so is the browser's copy of Apple's helper.
        let browser: pid_t
        switch Processes.browser(behind: caller) {
        case .success(let pid): browser = pid
        case .failure(let error): return .failure(error)
        }
        guard AXIsProcessTrusted() else { return .failure(.needsAccessibility) }

        let browserName = NSRunningApplication(processIdentifier: browser)?.localizedName ?? "your browser"
        guard await UserPresence.confirm(reason: "enter the pairing code in \(browserName)") else {
            return .failure(.cancelled)
        }

        // The code window can take a moment to appear after the extension asks for it. Look up the
        // helpers again each time: they must still be Apple's, and still the browser's children.
        for _ in 0..<25 {
            let texts = Processes.appleHelpers(launchedBy: browser).flatMap(WindowReader.texts(of:))
            if let code = PairingCode.find(in: texts) { return .success(code) }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return .failure(.noCode)
    }
}

/// launchd starts the agent on demand, so it quits after a quiet minute, never while a request
/// (which may be waiting for Touch ID) is in progress.
final class IdleExit: @unchecked Sendable {
    static let shared = IdleExit()
    private let queue = DispatchQueue(label: "idle-exit")
    private var generation = 0
    private var active = 0

    func touch() {
        queue.async { self.schedule() }
    }

    func begin() {
        queue.async {
            self.active += 1
            self.generation += 1
        }
    }

    func end() {
        queue.async {
            self.active -= 1
            self.schedule()
        }
    }

    private func schedule() {
        generation += 1
        let mine = generation
        queue.asyncAfter(deadline: .now() + 60) {
            if self.generation == mine && self.active == 0 { exit(0) }
        }
    }
}
