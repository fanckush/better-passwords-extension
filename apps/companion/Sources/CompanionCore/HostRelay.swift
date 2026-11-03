import Foundation

/// The native host's logic, separate from stdin/stdout and XPC so it can be tested.
public struct HostRelay: Sendable {
    /// Talks to the agent. Real hosts use XPC; tests use a stub.
    public protocol Agent: Sendable {
        func status() async -> Result<Bool, CompanionError>
        func readPairingCode() async -> Result<String, CompanionError>
        func myEmails() async -> Result<[String], CompanionError>
        func availableUpdate() async -> String?
        func reportHelper(blocked: Bool) async -> Bool
    }

    let agent: any Agent
    let appVersion: String?
    let openApp: @Sendable () -> Bool

    /// `appVersion` is the version of the app the host is part of. `openApp` brings the app's window
    /// up; it doesn't involve the agent.
    public init(agent: any Agent, appVersion: String? = nil, openApp: @escaping @Sendable () -> Bool = { false }) {
        self.agent = agent
        self.appVersion = appVersion
        self.openApp = openApp
    }

    public func handle(_ data: Data) async -> HostResponse {
        guard let request = try? JSONDecoder().decode(HostRequest.self, from: data) else {
            return HostResponse(ok: false, message: "unknown request")
        }
        switch request.type {
        case .hello:
            switch await agent.status() {
            case .success(let trusted):
                let update = await agent.availableUpdate()
                return HostResponse(ok: true, app: appVersion, update: update, accessibility: trusted)
            case .failure(let error):
                return .failure(error)
            }
        case .readCode:
            switch await agent.readPairingCode() {
            case .success(let code):
                return HostResponse(ok: true, code: code)
            case .failure(let error):
                return .failure(error)
            }
        case .openApp:
            return HostResponse(ok: openApp())
        case .helperStatus:
            guard let blocked = request.blocked else {
                return HostResponse(ok: false, message: "say whether it's blocked")
            }
            return HostResponse(ok: await agent.reportHelper(blocked: blocked))
        case .myEmails:
            switch await agent.myEmails() {
            case .success(let emails):
                return HostResponse(ok: true, emails: emails)
            case .failure(let error):
                return .failure(error)
            }
        }
    }

    public static func encode(_ response: HostResponse) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(response)) ?? Data(#"{"ok":false}"#.utf8)
    }
}
