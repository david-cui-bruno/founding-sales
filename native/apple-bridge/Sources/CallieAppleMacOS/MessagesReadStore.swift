import CallieAppleCore
import Foundation
import SQLite3

public typealias MessagesReadError = MessagesReadPortError

public struct MessagesDatabaseOpenEvidence: Sendable, Equatable {
    public let flags: Int32
    public let sqliteReportsReadOnly: Bool
    public let immutableURI: Bool
    public let busyTimeoutMilliseconds: Int32

    public init(flags: Int32, sqliteReportsReadOnly: Bool, immutableURI: Bool, busyTimeoutMilliseconds: Int32) {
        self.flags = flags
        self.sqliteReportsReadOnly = sqliteReportsReadOnly
        self.immutableURI = immutableURI
        self.busyTimeoutMilliseconds = busyTimeoutMilliseconds
    }
}

public final class MessagesReadStore: MessageTestActivityScanning, @unchecked Sendable {
    private static let supportedSchemaVersion: Int32 = 26
    private static let openFlags = SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_FULLMUTEX
    private static let busyTimeoutMilliseconds: Int32 = 100
    private static let maximumWindow: TimeInterval = 7 * 24 * 60 * 60
    private static let maximumRows: Int32 = 500

    private let database: URL
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private var evidenceStorage: MessagesDatabaseOpenEvidence?

    public init(database: URL, now: @escaping @Sendable () -> Date = Date.init) {
        self.database = database
        self.now = now
    }

    public var lastOpenEvidence: MessagesDatabaseOpenEvidence? {
        lock.withLock { evidenceStorage }
    }

    public func scanTestActivity(handle: NormalizedHandle, since: Date) throws -> MessageTestActivity {
        guard database.isFileURL, !handle.value.isEmpty, handle.value.count <= 256 else {
            throw MessagesReadError.databaseUnavailable
        }
        return try lock.withLock {
            var connection: OpaquePointer?
            let uri = database.absoluteString + "?mode=ro&immutable=1"
            guard sqlite3_open_v2(uri, &connection, Self.openFlags, nil) == SQLITE_OK,
                  let connection else {
                if let connection { sqlite3_close(connection) }
                throw MessagesReadError.databaseUnavailable
            }
            defer { sqlite3_close(connection) }
            guard sqlite3_busy_timeout(connection, Self.busyTimeoutMilliseconds) == SQLITE_OK else {
                throw MessagesReadError.databaseUnavailable
            }
            let readOnly = sqlite3_db_readonly(connection, "main") == 1
            evidenceStorage = .init(
                flags: Self.openFlags,
                sqliteReportsReadOnly: readOnly,
                immutableURI: uri.hasSuffix("?mode=ro&immutable=1"),
                busyTimeoutMilliseconds: Self.busyTimeoutMilliseconds
            )
            guard readOnly else { throw MessagesReadError.databaseUnavailable }
            try Self.validateSchema(connection)

            let lowerBound = max(since, now().addingTimeInterval(-Self.maximumWindow))
            return try Self.queryActivity(connection, handle: handle.value, since: lowerBound)
        }
    }

    private static func validateSchema(_ connection: OpaquePointer) throws {
        guard try scalarInt(connection, sql: "SELECT user_version FROM pragma_user_version") == supportedSchemaVersion else {
            throw MessagesReadError.schemaUnsupported
        }
        let messageColumns = try columns(connection, sql: "SELECT name FROM pragma_table_info('message')")
        let handleColumns = try columns(connection, sql: "SELECT name FROM pragma_table_info('handle')")
        guard messageColumns.isSuperset(of: ["handle_id", "date", "is_from_me", "text", "attributedBody"]),
              handleColumns.isSuperset(of: ["id"]) else {
            throw MessagesReadError.schemaUnsupported
        }
    }

    private static func queryActivity(_ connection: OpaquePointer, handle: String, since: Date) throws -> MessageTestActivity {
        let sql = """
        SELECT message.date, message.is_from_me
        FROM message
        INNER JOIN handle ON handle.ROWID = message.handle_id
        WHERE handle.id = ?1 AND message.date >= ?2
        ORDER BY message.date DESC
        LIMIT ?3
        """
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection, sql, -1, &statement, nil) == SQLITE_OK,
              let statement else { throw MessagesReadError.queryFailed }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard sqlite3_bind_text(statement, 1, handle, -1, transient) == SQLITE_OK,
              sqlite3_bind_int64(statement, 2, Int64(since.timeIntervalSinceReferenceDate * 1_000_000_000)) == SQLITE_OK,
              sqlite3_bind_int(statement, 3, maximumRows) == SQLITE_OK else {
            throw MessagesReadError.queryFailed
        }

        var sent = 0
        var received = 0
        var latestAt: Date?
        while true {
            switch sqlite3_step(statement) {
            case SQLITE_ROW:
                let rawDate = sqlite3_column_int64(statement, 0)
                let date = Date(timeIntervalSinceReferenceDate: TimeInterval(rawDate) / 1_000_000_000)
                if latestAt == nil { latestAt = date }
                if sqlite3_column_int(statement, 1) == 1 { sent += 1 } else { received += 1 }
            case SQLITE_DONE:
                return .init(sentCount: sent, receivedCount: received, latestAt: latestAt)
            default:
                throw MessagesReadError.queryFailed
            }
        }
    }

    private static func scalarInt(_ connection: OpaquePointer, sql: StaticString) throws -> Int32 {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection, sql.description, -1, &statement, nil) == SQLITE_OK,
              let statement else { throw MessagesReadError.schemaUnsupported }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw MessagesReadError.schemaUnsupported }
        return sqlite3_column_int(statement, 0)
    }

    private static func columns(_ connection: OpaquePointer, sql: StaticString) throws -> Set<String> {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection, sql.description, -1, &statement, nil) == SQLITE_OK,
              let statement else { throw MessagesReadError.schemaUnsupported }
        defer { sqlite3_finalize(statement) }
        var values: Set<String> = []
        while true {
            switch sqlite3_step(statement) {
            case SQLITE_ROW:
                guard let text = sqlite3_column_text(statement, 0) else { throw MessagesReadError.schemaUnsupported }
                values.insert(String(cString: text))
            case SQLITE_DONE:
                return values
            default:
                throw MessagesReadError.schemaUnsupported
            }
        }
    }
}
