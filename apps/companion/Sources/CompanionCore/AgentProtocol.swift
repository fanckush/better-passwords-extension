import Foundation

/// What the agent offers over XPC. Callers never say which browser they are: the agent works it out
/// from the caller's own process, so a caller can't point it anywhere else.
@objc public protocol CompanionAgentProtocol {
    /// Replies with whether the agent may read other apps' windows (Accessibility).
    func status(reply: @escaping @Sendable (_ accessibilityTrusted: Bool) -> Void)

    /// Asks for Touch ID, then reads the pairing code Apple's helper shows for the caller's browser.
    /// Replies with the six digits, or with one of `CompanionError`'s raw values.
    func readPairingCode(reply: @escaping @Sendable (_ code: String?, _ error: String?) -> Void)

    /// The email addresses on the user's own contact card ("Me" in Contacts), for email fields.
    /// Replies with them, or with one of `CompanionError`'s raw values.
    func myEmails(reply: @escaping @Sendable (_ emails: [String]?, _ error: String?) -> Void)

    /// A newer version of the app, if the agent has seen one in the appcast. It looks once a day.
    func availableUpdate(reply: @escaping @Sendable (_ version: String?) -> Void)

    /// Records whether macOS lets Apple's helper start in the caller's browser, as its extension
    /// saw. Replies false when the caller isn't running under a known browser.
    func reportHelper(blocked: Bool, reply: @escaping @Sendable (_ recorded: Bool) -> Void)
}

public enum CompanionError: String, Error, Codable, Sendable, CaseIterable {
    /// The agent isn't allowed Accessibility yet (System Settings → Privacy & Security).
    case needsAccessibility = "needs-accessibility"
    /// The user cancelled Touch ID, or it failed.
    case cancelled
    /// No copy of Apple's helper, launched by the caller's browser, is running.
    case noHelper = "no-helper"
    /// The helper is running but shows no code (or more than one).
    case noCode = "no-code"
    /// The caller isn't our signed native host, or isn't running under a browser.
    case untrustedCaller = "untrusted-caller"
    /// The agent couldn't be reached (the app isn't installed or its login item is off).
    case agentUnavailable = "agent-unavailable"
    /// Another request is already in progress.
    case busy
    /// The app isn't allowed to read Contacts (it asks in its setup window).
    case needsContacts = "needs-contacts"

    public var message: String {
        switch self {
        case .needsAccessibility: "Open Better Passwords and allow Accessibility."
        case .cancelled: "Touch ID was cancelled."
        case .noHelper: "Apple's password helper isn't running for this browser."
        case .noCode: "No pairing code is on screen."
        case .untrustedCaller: "The request didn't come from a trusted browser connection."
        case .agentUnavailable: "The Better Passwords app isn't running. Open it to finish setup."
        case .busy: "Already reading a code."
        case .needsContacts: "Allow Contacts in Better Passwords to suggest your email addresses."
        }
    }
}

public enum AgentInterface {
    public static func make() -> NSXPCInterface {
        NSXPCInterface(with: CompanionAgentProtocol.self)
    }
}
