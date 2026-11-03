import Foundation
import Testing

@testable import CompanionCore

private struct StubAgent: HostRelay.Agent {
    var statusResult: Result<Bool, CompanionError> = .success(true)
    var codeResult: Result<String, CompanionError> = .success("123456")
    var emailsResult: Result<[String], CompanionError> = .success(["jane@example.com"])
    var update: String?
    var reported = Recorder()
    func status() async -> Result<Bool, CompanionError> { statusResult }
    func myEmails() async -> Result<[String], CompanionError> { emailsResult }
    func readPairingCode() async -> Result<String, CompanionError> { codeResult }
    func availableUpdate() async -> String? { update }
    func reportHelper(blocked: Bool) async -> Bool {
        reported.add(blocked ? "blocked" : "ok")
        return true
    }
}

private final class Recorder: @unchecked Sendable {
    private(set) var values: [String] = []
    func add(_ value: String) { values.append(value) }
}

private func json(_ response: HostResponse) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: HostRelay.encode(response))) as? [String: Any] ?? [:]
}

@Suite struct HostRelayTests {
    @Test func helloReportsAccessibility() async {
        let relay = HostRelay(agent: StubAgent(statusResult: .success(false)))
        let reply = json(await relay.handle(Data(#"{"type":"hello"}"#.utf8)))
        #expect(reply["ok"] as? Bool == true)
        #expect(reply["accessibility"] as? Bool == false)
        #expect(reply["version"] as? Int == HostResponse.protocolVersion)
        #expect(reply["update"] == nil)
    }

    @Test func helloReportsTheAppVersionAndAnUpdate() async {
        let relay = HostRelay(agent: StubAgent(update: "1.2.0"), appVersion: "1.1.0")
        let reply = json(await relay.handle(Data(#"{"type":"hello"}"#.utf8)))
        #expect(reply["app"] as? String == "1.1.0")
        #expect(reply["update"] as? String == "1.2.0")
    }

    @Test func relaysTheCode() async {
        let relay = HostRelay(agent: StubAgent())
        let reply = json(await relay.handle(Data(#"{"type":"read-code"}"#.utf8)))
        #expect(reply["ok"] as? Bool == true)
        #expect(reply["code"] as? String == "123456")
    }

    @Test func relaysErrorsWithMessages() async {
        let relay = HostRelay(agent: StubAgent(codeResult: .failure(.cancelled)))
        let reply = json(await relay.handle(Data(#"{"type":"read-code"}"#.utf8)))
        #expect(reply["ok"] as? Bool == false)
        #expect(reply["error"] as? String == "cancelled")
        #expect(reply["message"] as? String == CompanionError.cancelled.message)
    }

    @Test func relaysContactEmails() async {
        let reply = json(await HostRelay(agent: StubAgent()).handle(Data(#"{"type":"my-emails"}"#.utf8)))
        #expect(reply["emails"] as? [String] == ["jane@example.com"])
        let denied = HostRelay(agent: StubAgent(emailsResult: .failure(.needsContacts)))
        #expect(json(await denied.handle(Data(#"{"type":"my-emails"}"#.utf8)))["error"] as? String == "needs-contacts")
    }

    @Test func opensTheApp() async {
        let opened = Recorder()
        let relay = HostRelay(agent: StubAgent()) {
            opened.add("app")
            return true
        }
        #expect(json(await relay.handle(Data(#"{"type":"open-app"}"#.utf8)))["ok"] as? Bool == true)
        #expect(opened.values == ["app"])
    }

    @Test func relaysHelperReports() async {
        let agent = StubAgent()
        let relay = HostRelay(agent: agent)
        #expect(json(await relay.handle(Data(#"{"type":"helper-status","blocked":true}"#.utf8)))["ok"] as? Bool == true)
        _ = await relay.handle(Data(#"{"type":"helper-status","blocked":false}"#.utf8))
        #expect(agent.reported.values == ["blocked", "ok"])
    }

    @Test func rejectsHelperReportsThatDontSay() async {
        let agent = StubAgent()
        let reply = json(await HostRelay(agent: agent).handle(Data(#"{"type":"helper-status"}"#.utf8)))
        #expect(reply["ok"] as? Bool == false)
        #expect(agent.reported.values.isEmpty)
    }

    @Test func rejectsUnknownRequests() async {
        let relay = HostRelay(agent: StubAgent())
        #expect(json(await relay.handle(Data(#"{"type":"get-password"}"#.utf8)))["ok"] as? Bool == false)
        #expect(json(await relay.handle(Data("not json".utf8)))["ok"] as? Bool == false)
    }
}
