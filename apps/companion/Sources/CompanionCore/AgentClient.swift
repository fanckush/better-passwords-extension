import Foundation

/// The native host's connection to the agent over XPC.
public final class XPCAgentClient: HostRelay.Agent, @unchecked Sendable {
    /// Quick questions give up soon, so a broken agent can't hold the extension's menu up.
    static let quick: Duration = .seconds(3)
    /// Touch ID waits for the user, so allow plenty of time.
    static let touchID: Duration = .seconds(90)

    public init() {}

    /// The agent must be our own app. Release builds check the team; ad-hoc development builds can
    /// only check the identifier, because the app is signed after the host.
    static func agentRequirement() -> String {
        if let team = CodeSigning.ownTeamID() {
            return CodeSigning.sameTeam(team, identifier: Identity.appBundleID)
        }
        return #"identifier "\#(Identity.appBundleID)""#
    }

    typealias Finish<T> = @Sendable (Result<T, CompanionError>) -> Void

    private func withAgent<T: Sendable>(
        timeout: Duration,
        _ body: @escaping @Sendable (CompanionAgentProtocol, @escaping Finish<T>) -> Void
    ) async -> Result<T, CompanionError> {
        let connection = NSXPCConnection(machServiceName: Identity.agentService, options: [])
        connection.remoteObjectInterface = AgentInterface.make()
        connection.setCodeSigningRequirement(Self.agentRequirement())
        connection.resume()
        defer { connection.invalidate() }

        let once = Once<Result<T, CompanionError>>()
        return await withCheckedContinuation { continuation in
            let finish: Finish<T> = { result in
                if once.claim(result) { continuation.resume(returning: result) }
            }
            let proxy = connection.remoteObjectProxyWithErrorHandler { _ in finish(.failure(.agentUnavailable)) }
            guard let agent = proxy as? CompanionAgentProtocol else { return finish(.failure(.agentUnavailable)) }
            body(agent, finish)
            Task {
                try? await Task.sleep(for: timeout)
                finish(.failure(.agentUnavailable))
            }
        }
    }

    public func status() async -> Result<Bool, CompanionError> {
        await withAgent(timeout: Self.quick) { agent, finish in
            agent.status { trusted in finish(.success(trusted)) }
        }
    }

    public func myEmails() async -> Result<[String], CompanionError> {
        await withAgent(timeout: Self.quick) { agent, finish in
            agent.myEmails { emails, error in
                if let emails {
                    finish(.success(emails))
                } else {
                    finish(.failure(error.flatMap(CompanionError.init(rawValue:)) ?? .needsContacts))
                }
            }
        }
    }

    /// An agent from before this question (still running during an update) doesn't answer it: no update then.
    public func availableUpdate() async -> String? {
        let result: Result<String?, CompanionError> = await withAgent(timeout: Self.quick) { agent, finish in
            agent.availableUpdate { version in finish(.success(version)) }
        }
        return (try? result.get()) ?? nil
    }

    /// An agent from before this question doesn't answer it: nothing is recorded then.
    public func reportHelper(blocked: Bool) async -> Bool {
        let result: Result<Bool, CompanionError> = await withAgent(timeout: Self.quick) { agent, finish in
            agent.reportHelper(blocked: blocked) { recorded in finish(.success(recorded)) }
        }
        return (try? result.get()) ?? false
    }

    public func readPairingCode() async -> Result<String, CompanionError> {
        await withAgent(timeout: Self.touchID) { agent, finish in
            agent.readPairingCode { code, error in
                if let code {
                    finish(.success(code))
                } else {
                    finish(.failure(error.flatMap(CompanionError.init(rawValue:)) ?? .noCode))
                }
            }
        }
    }
}

/// Lets exactly one of several racing callbacks win.
final class Once<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func claim(_: T) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
