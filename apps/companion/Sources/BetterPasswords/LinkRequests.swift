import AppKit
import Observation

/// betterpasswords://connect, opened from the extension's welcome by someone who has the app: it
/// connects the browser that opened it. Any web page could open the link too, so it never does more
/// than connect browsers, and it takes no parameters.
@MainActor
@Observable
final class LinkRequests {
    static let shared = LinkRequests()

    struct Request: Equatable {
        let id = UUID()
        /// The app that opened the link, when macOS says.
        let sender: NSRunningApplication?
    }

    private(set) var latest: Request?

    /// Takes the URL events itself (not SwiftUI's onOpenURL) to read who sent them. Called before
    /// launch finishes, so a link that launches the app isn't missed.
    func install() {
        NSAppleEventManager.shared().setEventHandler(
            self, andSelector: #selector(handle(_:reply:)),
            forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    @objc private func handle(_ event: NSAppleEventDescriptor, reply _: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
            let url = URL(string: text), url.scheme == "betterpasswords", url.host == "connect"
        else { return }
        let pid = event.attributeDescriptor(forKeyword: keySenderPIDAttr)?.int32Value
        latest = Request(sender: pid.flatMap { NSRunningApplication(processIdentifier: $0) })
        // A link that launches the app launches it without its window (macOS opens that only for a
        // plain launch), and so does one arriving after the window was closed: reopening the app,
        // as its Dock icon would, brings it up, and the window then handles `latest`. macOS also
        // lets an app come forward only if the one that opened it allows it, so the window is
        // brought to the front as well, which it permits.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
                window.makeKeyAndOrderFront(nil)
                window.orderFrontRegardless()
            } else {
                let reopen = NSAppleEventDescriptor(
                    eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEReopenApplication),
                    targetDescriptor: NSAppleEventDescriptor(processIdentifier: getpid()),
                    returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
                _ = try? reopen.sendEvent(options: [.noReply], timeout: 1)
            }
            NSApp.activate()
        }
    }
}
