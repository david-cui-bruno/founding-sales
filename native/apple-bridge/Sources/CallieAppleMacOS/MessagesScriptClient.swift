import CallieAppleCore
import Foundation

public typealias MessagesSendError = MessagesSendPortError

public struct MessagesScriptClient: MessageTestSending {
    private let executor: any AppleEventExecuting

    public init(executor: any AppleEventExecuting) {
        self.executor = executor
    }

    public func sendTest(_ test: ManualMessageTest) throws -> MessageSendReceipt {
        guard test.confirmation == ManualMessageTest.requiredConfirmation else {
            throw MessagesSendError.manualConfirmationRequired
        }
        guard !test.handle.value.isEmpty,
              test.handle.value.utf8.count <= 256,
              !test.body.isEmpty,
              test.body.utf8.count <= 4_000 else {
            throw MessagesSendError.invalidRequest
        }
        let resolution: NSAppleEventDescriptor
        do {
            resolution = try executor.execute(.messagesResolveParticipants(handle: test.handle.value))
        } catch {
            throw MessagesSendError.sendFailed
        }
        let values = resolution.paramDescriptor(forKeyword: Self.code("----")) ?? resolution
        guard values.numberOfItems == 1,
              let participantID = values.atIndex(1)?.stringValue,
              !participantID.isEmpty else {
            throw MessagesSendError.recipientAmbiguous
        }
        do {
            _ = try executor.execute(.messagesSend(participantID: participantID as String, body: test.body))
        } catch {
            throw MessagesSendError.sendFailed
        }
        return MessageSendReceipt(commandID: test.commandID)
    }

    private static func code(_ value: String) -> UInt32 {
        value.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
    }
}
