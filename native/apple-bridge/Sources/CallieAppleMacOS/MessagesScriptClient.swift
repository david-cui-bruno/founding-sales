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
              test.handle.value.count <= 256,
              !test.body.isEmpty,
              test.body.count <= 4_000 else {
            throw MessagesSendError.invalidRequest
        }
        do {
            _ = try executor.execute(.messagesSend(handle: test.handle.value, body: test.body))
        } catch {
            throw MessagesSendError.sendFailed
        }
        return MessageSendReceipt(commandID: test.commandID)
    }
}
