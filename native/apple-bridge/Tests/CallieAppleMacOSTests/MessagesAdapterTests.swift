import Foundation
import SQLite3
import Testing
@testable import CallieAppleCore
@testable import CallieAppleMacOS

@Suite("MessagesAdapterTests")
struct MessagesAdapterTests {
    @Test func messageSendRequiresExactManualConfirmation() throws {
        let executor = FakeAppleEventExecutor(reply: .null())
        let client = MessagesScriptClient(executor: executor)
        let test = ManualMessageTest(
            commandID: UUID(),
            handle: NormalizedHandle("synthetic@example.invalid"),
            body: "Synthetic body",
            confirmation: "yes"
        )

        #expect(throws: MessagesSendError.manualConfirmationRequired) { try client.sendTest(test) }
        #expect(executor.operations.isEmpty)
    }

    @Test func consentedMessageIsSentExactlyOnceWithFixedOperation() throws {
        let executor = FakeAppleEventExecutor(reply: .null())
        let client = MessagesScriptClient(executor: executor)
        let commandID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
        let test = ManualMessageTest(
            commandID: commandID,
            handle: NormalizedHandle("SYNTHETIC@EXAMPLE.INVALID"),
            body: "Synthetic body",
            confirmation: ManualMessageTest.requiredConfirmation
        )

        #expect(try client.sendTest(test) == MessageSendReceipt(commandID: commandID))
        #expect(executor.operations == [.messagesSend(handle: "synthetic@example.invalid", body: "Synthetic body")])
    }

    @Test func sendErrorsUseConstantDiagnosticsWithoutRecipientOrBody() throws {
        let executor = FakeAppleEventExecutor(reply: .null(), onOperation: { _ in throw AppleEventExecutionError.failed })
        let client = MessagesScriptClient(executor: executor)
        let secretHandle = "private-payload@example.invalid"
        let secretBody = "private-payload-body"
        let test = ManualMessageTest(
            commandID: UUID(),
            handle: NormalizedHandle(secretHandle),
            body: secretBody,
            confirmation: ManualMessageTest.requiredConfirmation
        )

        do {
            _ = try client.sendTest(test)
            Issue.record("Expected fixed send failure")
        } catch {
            #expect(String(describing: error) == "sendFailed")
            #expect(!String(describing: error).contains(secretHandle))
            #expect(!String(describing: error).contains(secretBody))
        }
        #expect(executor.operations.count == 1)
    }

    @Test func supportedSchemaIsReadImmutablyAndCountsNullTextIndependently() throws {
        let database = try SyntheticMessagesDatabase.fixture(named: "messages-v26")
        let original = try Data(contentsOf: database.url)
        let store = MessagesReadStore(database: database.url, now: { fixtureNow })

        let activity = try store.scanTestActivity(
            handle: NormalizedHandle("synthetic@example.invalid"),
            since: fixtureNow.addingTimeInterval(-3_600)
        )

        #expect(activity == MessageTestActivity(sentCount: 1, receivedCount: 1, latestAt: fixtureNow.addingTimeInterval(-60)))
        #expect(store.lastOpenEvidence == MessagesDatabaseOpenEvidence(
            flags: SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_FULLMUTEX,
            sqliteReportsReadOnly: true,
            immutableURI: true,
            busyTimeoutMilliseconds: 100
        ))
        #expect(try Data(contentsOf: database.url) == original)
    }

    @Test func unsupportedMessagesSchemaDegradesWithoutWriting() throws {
        let database = try SyntheticMessagesDatabase.fixture(named: "messages-unsupported")
        let original = try Data(contentsOf: database.url)
        let store = MessagesReadStore(database: database.url, now: { fixtureNow })

        #expect(throws: MessagesReadError.schemaUnsupported) {
            try store.scanTestActivity(handle: NormalizedHandle("synthetic@example.invalid"), since: fixtureNow.addingTimeInterval(-3_600))
        }
        #expect(try Data(contentsOf: database.url) == original)
    }

    @Test func activityWindowIsClampedAndResultCountIsBounded() throws {
        let database = try SyntheticMessagesDatabase.fixture(named: "messages-v26")
        let store = MessagesReadStore(database: database.url, now: { fixtureNow })
        let activity = try store.scanTestActivity(
            handle: NormalizedHandle("synthetic@example.invalid"),
            since: fixtureNow.addingTimeInterval(-60 * 60 * 24 * 365)
        )
        #expect(activity.sentCount == 1)
        #expect(activity.receivedCount == 1)
    }
}

private let fixtureNow = Date(timeIntervalSinceReferenceDate: 800_000_000)

private final class SyntheticMessagesDatabase {
    let url: URL

    private init(url: URL) { self.url = url }

    static func fixture(named name: String) throws -> SyntheticMessagesDatabase {
        guard let sqlURL = Bundle.module.url(forResource: name, withExtension: "sql", subdirectory: "Fixtures") else {
            throw CocoaError(.fileNoSuchFile)
        }
        let databaseURL = FileManager.default.temporaryDirectory.appending(path: "callie-messages-\(UUID().uuidString).sqlite")
        var database: OpaquePointer?
        guard sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE, nil) == SQLITE_OK,
              let database else { throw MessagesReadError.databaseUnavailable }
        defer { sqlite3_close(database) }
        let sql = try String(contentsOf: sqlURL, encoding: .utf8)
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw MessagesReadError.databaseUnavailable }
        return SyntheticMessagesDatabase(url: databaseURL)
    }
}
