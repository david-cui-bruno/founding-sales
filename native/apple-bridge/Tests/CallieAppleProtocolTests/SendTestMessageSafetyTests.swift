import Foundation
import Testing
@testable import CallieAppleProtocol

@Test func sendTestMessageRequiresExplicitCommandIDAndExactConsent() throws {
    let valid = Data(#"{"v":1,"kind":"request","id":"11111111-1111-4111-8111-111111111111","method":"messages.sendTest","params":{"commandId":"22222222-2222-4222-8222-222222222222","recipientHandle":"synthetic@example.invalid","body":"Synthetic test","confirmation":"I CONSENT TO THIS TEST MESSAGE"}}"#.utf8)
    let request = try JSONDecoder().decode(BridgeRequest.self, from: valid)
    guard case let .sendTestMessage(parameters) = request.params else {
        Issue.record("Expected messages.sendTest parameters")
        return
    }
    #expect(parameters.commandId == UUID(uuidString: "22222222-2222-4222-8222-222222222222"))
    #expect(parameters.confirmation == "I CONSENT TO THIS TEST MESSAGE")

    for invalid in [
        #"{"v":1,"kind":"request","id":"11111111-1111-4111-8111-111111111111","method":"messages.sendTest","params":{"recipientHandle":"synthetic@example.invalid","body":"Synthetic test","confirmation":"I CONSENT TO THIS TEST MESSAGE"}}"#,
        #"{"v":1,"kind":"request","id":"11111111-1111-4111-8111-111111111111","method":"messages.sendTest","params":{"commandId":"11111111-1111-4111-8111-111111111111","recipientHandle":"synthetic@example.invalid","body":"Synthetic test","confirmation":"I CONSENT TO THIS TEST MESSAGE"}}"#,
        #"{"v":1,"kind":"request","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","method":"messages.sendTest","params":{"commandId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","recipientHandle":"synthetic@example.invalid","body":"Synthetic test","confirmation":"I CONSENT TO THIS TEST MESSAGE"}}"#,
        #"{"v":1,"kind":"request","id":"11111111-1111-4111-8111-111111111111","method":"messages.sendTest","params":{"commandId":"22222222-2222-4222-8222-222222222222","recipientHandle":"synthetic@example.invalid","body":"Synthetic test","confirmation":"yes"}}"#,
        #"{"v":1,"kind":"request","id":"11111111-1111-4111-8111-111111111111","method":"messages.sendTest","params":{"commandId":"22222222-2222-4222-8222-222222222222","recipientHandle":"synthetic@example.invalid","body":"Synthetic test","confirmation":"I CONSENT TO THIS TEST MESSAGE","script":"arbitrary source"}}"#,
    ] {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(BridgeRequest.self, from: Data(invalid.utf8))
        }
    }
}

@Test func sendTestMessageUsesUTF8ByteBounds() throws {
    let accepted = try SendTestMessageParameters(
        commandId: UUID(),
        recipientHandle: String(repeating: "é", count: 128),
        body: String(repeating: "😀", count: 1_000),
        confirmation: SendTestMessageParameters.requiredConfirmation
    )
    #expect(accepted.recipientHandle.utf8.count == 256)
    #expect(accepted.body.utf8.count == 4_000)

    #expect(throws: BridgeFrameConstructionError.invalidParameters) {
        try SendTestMessageParameters(commandId: UUID(), recipientHandle: String(repeating: "é", count: 129), body: "ok", confirmation: SendTestMessageParameters.requiredConfirmation)
    }
    #expect(throws: BridgeFrameConstructionError.invalidParameters) {
        try SendTestMessageParameters(commandId: UUID(), recipientHandle: "ok", body: String(repeating: "😀", count: 1_001), confirmation: SendTestMessageParameters.requiredConfirmation)
    }
}
