import Foundation

/// Messages between the extension and the native host (JSON over native messaging).
public struct HostRequest: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        /// Is the companion installed and ready?
        case hello
        /// Touch ID, then the code on screen.
        case readCode = "read-code"
        /// The emails on the user's contact card.
        case myEmails = "my-emails"
        /// Brings the app's window up (from the extension's popup).
        case openApp = "open-app"
        /// Whether macOS lets Apple's helper start in the caller's browser, for the app's list.
        case helperStatus = "helper-status"
    }

    public var type: Kind
    /// On helper-status: true when macOS killed the helper before it answered.
    public var blocked: Bool?

    public init(type: Kind, blocked: Bool? = nil) {
        self.type = type
        self.blocked = blocked
    }
}

public struct HostResponse: Codable, Equatable, Sendable {
    public var ok: Bool
    /// Protocol version of the companion, so the extension can tell old installs apart.
    public var version = HostResponse.protocolVersion
    /// The app's own version, on hello.
    public var app: String?
    /// A newer version of the app that's out, on hello.
    public var update: String?
    public var code: String?
    public var accessibility: Bool?
    public var emails: [String]?
    public var error: CompanionError?
    public var message: String?

    /// 1: hello, read-code. 2: adds my-emails. 3: adds open-app. 4: hello adds app and update.
    /// 5: adds helper-status.
    public static let protocolVersion = 5

    public static func failure(_ error: CompanionError) -> HostResponse {
        HostResponse(ok: false, error: error, message: error.message)
    }
}
