import CallieAppleCore
import Foundation

public typealias NotesAdapterError = NotesPortError

public final class NotesArtifactRegistry: @unchecked Sendable {
    struct Entry: Sendable, Equatable {
        let scriptingID: String
        let createdAt: Date
    }

    private let lock = NSLock()
    private let capacity: Int
    private var byScriptingID: [String: NotesArtifactID] = [:]
    private var byOpaqueID: [NotesArtifactID: Entry] = [:]

    public init(capacity: Int = 5_000) {
        self.capacity = max(1, capacity)
    }

    @discardableResult
    public func register(scriptingID: String, createdAt: Date) throws -> NotesArtifactID {
        try lock.withLock {
            if let existing = byScriptingID[scriptingID] { return existing }
            guard byOpaqueID.count < capacity else { throw NotesAdapterError.capabilityUnavailable }
            let id = NotesArtifactID(UUID())
            byScriptingID[scriptingID] = id
            byOpaqueID[id] = Entry(scriptingID: scriptingID, createdAt: createdAt)
            return id
        }
    }

    func entry(for id: NotesArtifactID) -> Entry? {
        lock.withLock { byOpaqueID[id] }
    }
}

public final class NotesRecordingLocator: NotesRecordingScanning, @unchecked Sendable {
    private static let maximumArtifacts = 500
    private static let completenessCandidateLimit = 500
    private static let audioExtensions: Set<String> = ["m4a", "mp3", "wav", "caf", "aac"]

    private let executor: any AppleEventExecuting
    private let registry: NotesArtifactRegistry

    public init(executor: any AppleEventExecuting, registry: NotesArtifactRegistry) {
        self.executor = executor
        self.registry = registry
    }

    public func scan(since: Date) throws -> NotesRecordingScanResult {
        let rawReply: NSAppleEventDescriptor
        do {
            rawReply = try executor.execute(.notesScanAttachments(since: since))
        } catch {
            throw NotesAdapterError.capabilityUnavailable
        }
        let reply = rawReply.paramDescriptor(forKeyword: Self.code("----")) ?? rawReply
        var seen: Set<String> = []
        var artifacts: [NotesRecordingArtifact] = []
        let itemCount = reply.numberOfItems
        guard itemCount > 0 else { return .init(artifacts: [], truncated: false) }

        for index in 1...itemCount {
            guard let record = reply.atIndex(index),
                  let scriptingID = record.forKeyword(Self.code("ID  "))?.stringValue,
                  !scriptingID.isEmpty,
                  let name = record.forKeyword(Self.code("pnam"))?.stringValue,
                  Self.audioExtensions.contains((name as String).lowercased().split(separator: ".").last.map(String.init) ?? ""),
                  let createdAt = record.forKeyword(Self.code("ascd"))?.dateValue,
                  createdAt >= since,
                  seen.insert(scriptingID as String).inserted else { continue }
            let id = try registry.register(scriptingID: scriptingID as String, createdAt: createdAt as Date)
            if artifacts.count < Self.maximumArtifacts {
                artifacts.append(.init(id: id, createdAt: createdAt as Date))
            }
        }
        return .init(
            artifacts: artifacts.sorted { $0.createdAt < $1.createdAt },
            truncated: itemCount > Self.completenessCandidateLimit || artifacts.count == Self.maximumArtifacts
        )
    }

    private static func code(_ value: String) -> UInt32 {
        value.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
    }
}
