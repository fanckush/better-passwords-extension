import AppKit
import Combine
import CompanionCore
import SwiftUI

struct SetupView: View {
    @State private var model = SetupModel()
    @State private var links = LinkRequests.shared
    @State private var confirmingRemoval = false
    @State private var moveError: String?
    private let installed = AppLocation.isInstalled
    private let timer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if !installed {
                move
            } else if model.ready || model.wasSetUp {
                dashboard
            } else {
                steps
            }
        }
        .padding(24)
        .frame(width: 480)
        .onAppear {
            // outside Applications, nothing is set up: it would point at a copy that won't stay
            guard installed else { return }
            model.reRegisterIfRebuilt()
            model.reconnectIfMoved()
            model.connectNewBrowsers()
        }
        .onChange(of: links.latest, initial: true) { _, request in
            guard installed, let request else { return }
            model.handle(request)
        }
        .onReceive(timer) { _ in model.refresh() }
        .confirmationDialog("Remove Better Passwords' setup?", isPresented: $confirmingRemoval) {
            Button("Remove Setup", role: .destructive) { model.removeAll() }
        } message: {
            Text(
                "Every browser is disconnected and the background agent stops. Accessibility stays allowed "
                    + "until you remove it in System Settings.")
        }
    }

    /// Before anything else: the app has to be in Applications, where browsers and macOS find it.
    private var move: some View {
        VStack(spacing: 14) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 72, height: 72)
            Text("Move to Applications").font(.title2.bold())
            Text(
                "Better Passwords runs from your Applications folder, where your browsers and macOS start it. "
                    + "It opens again from there."
            )
            .multilineTextAlignment(.center)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            if let moveError {
                Text(moveError).foregroundStyle(.red).font(.callout)
            }
            HStack {
                Button("Quit") { NSApp.terminate(nil) }
                Spacer()
                Button("Move to Applications") {
                    Task {
                        do {
                            try await AppLocation.moveToApplications()
                            NSApp.terminate(nil)
                        } catch {
                            moveError = error.localizedDescription
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
            }
            .padding(.top, 10)
        }
        .frame(maxWidth: .infinity)
    }

    /// Once set up: what's connected and what's on, each with a way to change it. It says plainly
    /// that the app works without this window.
    private var dashboard: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Better Passwords").font(.title2.bold())
                    Label(
                        model.needsAttention
                            ? "Needs your attention" : "Works in the background. You can close this window.",
                        systemImage: "circle.fill"
                    )
                    .labelStyle(StatusLabelStyle(color: model.needsAttention ? .orange : .green))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }
            }

            bannerView

            Section(title: "Browsers") {
                if model.browserRows.isEmpty {
                    Text(
                        LocalizedStringKey(
                            "No supported browser found. Using another one? [Ask for it](\(browserRequest)).")
                    )
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 10)
                }
                ForEach(Array(model.browserRows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider() }
                    BrowserRowView(row: row, connect: { model.connect(row.browser) }) {
                        model.disconnect(row.browser)
                    }
                    .padding(.vertical, 8)
                }
            } footer: {
                Text(LocalizedStringKey("Missing a browser? [Ask for it](\(browserRequest))."))
            }

            Section(title: "Features") {
                FeatureRow(
                    title: "Runs in the background", detail: agentDetail, on: model.agentEnabled,
                    actionTitle: "Turn On"
                ) { model.enableAgent() }
                Divider()
                FeatureRow(
                    title: "Enters the pairing code after Touch ID",
                    detail: "Needs Accessibility, used only to read the code in Apple's own pairing window.",
                    on: model.accessibilityTrusted, actionTitle: "Allow…"
                ) { model.requestAccessibility() }
                Divider()
                FeatureRow(
                    title: "Suggests your email addresses",
                    detail: "On sign-up forms, the emails on your contact card, like Safari. Optional.",
                    on: model.contactsAllowed, actionTitle: "Allow…"
                ) { model.requestContacts() }
            }

            if let error = model.lastError {
                Text(error).foregroundStyle(.red).font(.callout)
            }

            HStack {
                Button("Remove Setup…", role: .destructive) { confirmingRemoval = true }
                    .help("Disconnects every browser and stops the background agent.")
                Spacer()
                Button("Done") { NSApp.keyWindow?.close() }
                    .keyboardShortcut(.defaultAction)
            }
            Divider()
            UpdatesFooter(availableUpdate: model.availableUpdate)
        }
    }

    /// What opening the app from a browser's extension did.
    @ViewBuilder private var bannerView: some View {
        if let banner = model.banner {
            let content = bannerContent(banner)
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: content.symbol)
                    .foregroundStyle(content.color)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 4) {
                    Text(content.title).font(.headline)
                    Text(content.detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if case .unknown = banner {
                        HStack {
                            Button("Check for Updates") { Updater.shared.checkForUpdates() }
                            if let url = URL(string: browserRequest) { Link("Ask for It", destination: url) }
                        }
                        .padding(.top, 4)
                    }
                }
                Spacer(minLength: 0)
                Button {
                    model.dismissBanner()
                } label: {
                    Image(systemName: "xmark").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Dismiss")
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 8).fill(content.color.opacity(0.12)))
        }
    }

    private func bannerContent(_ banner: SetupModel.Banner) -> (
        symbol: String, color: Color, title: String, detail: String
    ) {
        switch banner {
        case .connected(let name):
            (
                "checkmark.circle.fill", .green, "\(name) is connected",
                "Go back to \(name). Better Passwords notices by itself."
            )
        case .allConnected:
            (
                "checkmark.circle.fill", .green, "Your browsers are connected",
                "Go back to your browser. Better Passwords notices by itself."
            )
        case .blocked(let name):
            (
                "exclamationmark.triangle.fill", .orange, "\(name) is connected, but macOS blocks it",
                "macOS only lets Apple's password helper run in browsers Apple has approved. "
                    + "\(name) starts working once Apple approves it."
            )
        case .unknown(let name):
            (
                "questionmark.circle.fill", .orange, "Better Passwords doesn't know \(name) yet",
                "A newer version of the app may. If not, ask for it to be added."
            )
        }
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Better Passwords").font(.title2.bold())
                Text("Unlock the browser extension with Touch ID instead of typing the code from your Mac.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            bannerView

            Step(
                number: 1,
                title: "Connect your browsers",
                detail: browsersDetail,
                done: model.browsersConnected,
                actionTitle: model.installedBrowsers.isEmpty ? nil : "Connect"
            ) { model.connectBrowsers() }
            Step(
                number: 2,
                title: "Run in the background",
                detail: agentDetail,
                done: model.agentEnabled,
                actionTitle: "Turn On"
            ) { model.enableAgent() }
            Step(
                number: 3,
                title: "Allow reading the pairing code",
                detail: "macOS calls this Accessibility. Better Passwords uses it only to read the code in "
                    + "Apple's own pairing window, and only after you confirm with Touch ID.",
                done: model.accessibilityTrusted,
                actionTitle: "Allow…"
            ) { model.requestAccessibility() }

            Step(
                number: 4,
                title: "Suggest your email addresses (optional)",
                detail: "On sign-up forms, the extension offers the emails on your contact card, like Safari.",
                done: model.contactsAllowed,
                actionTitle: "Allow…"
            ) { model.requestContacts() }

            if let error = model.lastError {
                Text(error).foregroundStyle(.red).font(.callout)
            }

            Divider()
            HStack {
                Button("Remove Setup…", role: .destructive) { confirmingRemoval = true }
                    .help("Disconnects the browsers and stops the background agent.")
                Spacer()
            }
            Divider()
            UpdatesFooter(availableUpdate: model.availableUpdate)
        }
    }

    private let browserRequest =
        "https://github.com/fanckush/better-passwords-extension/issues/new?template=browser.yml"

    /// Markdown: Step renders the link.
    private var browsersDetail: String {
        if model.installedBrowsers.isEmpty {
            return "No supported browser found. Using another one? [Ask for it](\(browserRequest))."
        }
        let names = model.installedBrowsers.map(\.name).formatted(.list(type: .and))
        return "Lets the extension in \(names) reach Apple's password helper and this app. "
            + "Missing a browser? [Ask for it](\(browserRequest))."
    }

    private var agentDetail: String {
        switch model.agentStatus {
        case .requiresApproval: "Allow Better Passwords in System Settings → General → Login Items."
        default: "Starts by itself when the extension needs it, so this window doesn't need to stay open."
        }
    }
}

/// The app's version, and updates: a notice when the agent has seen a newer version.
private struct UpdatesFooter: View {
    let availableUpdate: String?
    @State private var automatically = Updater.shared.checksAutomatically

    var body: some View {
        HStack(spacing: 12) {
            if let availableUpdate, Updater.shared.isRunning {
                Label("Version \(availableUpdate) is available.", systemImage: "arrow.down.circle.fill")
                Spacer()
                Button("Update…") { Updater.shared.checkForUpdates() }
            } else {
                Text("Version \(AppInfo.version ?? "unknown")").foregroundStyle(.secondary)
                Spacer()
                if Updater.shared.isRunning {
                    Toggle("Check for updates automatically", isOn: $automatically)
                        .onChange(of: automatically) { Updater.shared.checksAutomatically = automatically }
                    Button("Check Now") { Updater.shared.checkForUpdates() }
                }
            }
        }
        .font(.callout)
    }
}

private struct Step: View {
    let number: Int
    let title: String
    let detail: String
    let done: Bool
    let actionTitle: String?
    let action: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(done ? Color.green : Color.secondary.opacity(0.2)).frame(width: 24, height: 24)
                if done {
                    Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white)
                } else {
                    Text("\(number)").font(.callout.bold())
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(LocalizedStringKey(detail))
                    .foregroundStyle(.secondary)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if !done, let actionTitle {
                Button(actionTitle, action: action)
            }
        }
    }
}

struct CompanionApp: App {
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate

    var body: some Scene {
        Window("Better Passwords", id: "setup") {
            SetupView()
        }
        .windowResizability(.contentSize)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_: Notification) {
        // before launch finishes, so a link that launches the app reaches it
        MainActor.assumeIsolated { LinkRequests.shared.install() }
    }

    func applicationDidFinishLaunching(_: Notification) {
        // Info.plist marks the bundle as a background app so the agent stays out of the Dock;
        // the setup window is a normal app.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        Updater.shared.start()
        // the extension says when the agent has seen an update, and its button opens this app
        if AppInfo.availableUpdate != nil { Updater.shared.checkForUpdates() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { true }
}

/// A titled group of rows on a light card, like System Settings.
private struct Section<Content: View, Footer: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @ViewBuilder let footer: Footer

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            VStack(alignment: .leading, spacing: 0) { content }
                .padding(.horizontal, 12)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(nsColor: .controlBackgroundColor))
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5))
            footer
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }
}

extension Section where Footer == EmptyView {
    init(title: String, @ViewBuilder content: () -> Content) {
        self.init(title: title, content: content, footer: { EmptyView() })
    }
}

/// One browser: whether it's connected, and the button that changes that.
private struct BrowserRowView: View {
    let row: SetupModel.BrowserRow
    let connect: () -> Void
    let disconnect: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            BrowserIcon(bundleID: row.browser.bundleID)
                .frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.browser.name)
                status
                if row.state == .blocked {
                    Text(
                        "macOS only lets Apple's password helper run in browsers Apple has approved. "
                            + "\(row.browser.name) starts working once Apple approves it."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                if !row.sharedWith.isEmpty {
                    Text("Shares its connection with \(row.sharedWith.formatted(.list(type: .and))).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            switch row.state {
            case .connected, .blocked: Button("Disconnect", action: disconnect)
            case .notConnected, .disconnected: Button("Connect", action: connect)
            }
        }
    }

    @ViewBuilder private var status: some View {
        switch row.state {
        case .connected:
            Label("Connected", systemImage: "checkmark.circle.fill")
                .labelStyle(StatusLabelStyle(color: .green))
                .font(.caption)
                .foregroundStyle(.secondary)
        case .blocked:
            Label("Blocked by macOS", systemImage: "exclamationmark.triangle.fill")
                .labelStyle(StatusLabelStyle(color: .orange))
                .font(.caption)
                .foregroundStyle(.orange)
        case .notConnected:
            Text("Not connected").font(.caption).foregroundStyle(.secondary)
        case .disconnected:
            Text("Disconnected. It stays so until you connect it.").font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// The browser's own icon, found by its bundle identifier.
private struct BrowserIcon: View {
    let bundleID: String?

    var body: some View {
        if let bundleID, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable()
        } else {
            Image(systemName: "globe").resizable().scaledToFit().foregroundStyle(.secondary).padding(3)
        }
    }
}

/// A feature of the app: on, or off with the button that turns it on and why it's needed.
private struct FeatureRow: View {
    let title: String
    let detail: String
    let on: Bool
    let actionTitle: String
    let action: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(on ? .green : .secondary)
                .font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if !on {
                    Text(LocalizedStringKey(detail))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if !on { Button(actionTitle, action: action) }
        }
        .padding(.vertical, 8)
    }
}

/// A label whose icon alone is colored: a status dot or mark next to plain text.
private struct StatusLabelStyle: LabelStyle {
    let color: Color

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon.foregroundStyle(color).imageScale(.small)
            configuration.title
        }
    }
}
