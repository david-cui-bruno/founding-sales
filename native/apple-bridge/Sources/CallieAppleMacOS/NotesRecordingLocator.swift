import CallieAppleCore
import Foundation

public typealias NotesAdapterError = NotesPortError

public final class NotesArtifactRegistry: @unchecked Sendable {
    struct Entry: Sendable, Equatable {
        let scriptingID: String
        let createdAt: Date
    }

    private let lock = NSLock()
    private var byScriptingID: [String: NotesArtifactID] = [:]
    private var byOpaqueID: [NotesArtifactID: Entry] = [:]

    public init() {}

    @discardableResult
    public func register(scriptingID: String, createdAt: Date) -> NotesArtifactID {
        lock.withLock {
            if let existing = byScriptingID[scriptingID] { return existing }
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
    private static let audioExtensions: Set<String> = ["m4a", "mp3", "wav", "caf", "aac"]

    private let executor: any AppleEventExecuting
    private let registry: NotesArtifactRegistry

    public init(executor: any AppleEventExecuting, registry: NotesArtifactRegistry) {
        self.executor = executor
        self.registry = registry
    }

    public func scan(since: Date) throws -> [NotesRecordingArtifact] {
        let rawReply: NSAppleEventDescriptor
        do {
            rawReply = try executor.execute(.notesScanAttachments)
        } catch {
            throw NotesAdapterError.capabilityUnavailable
        }
        let reply = rawReply.paramDescriptor(forKeyword: Self.code("----")) ?? rawReply
        var seen: Set<String> = []
        var artifacts: [NotesRecordingArtifact] = []
        let itemCount = min(reply.numberOfItems, Self.maximumArtifacts)
        guard itemCount > 0 else { return [] }

        for index in 1...itemCount {
            guard let record = reply.atIndex(index),
                  let scriptingID = record.forKeyword(Self.code("ID  "))?.stringValue,
                  !scriptingID.isEmpty,
                  let name = record.forKeyword(Self.code("pnam"))?.stringValue,
                  Self.audioExtensions.contains((name as String).lowercased().split(separator: ".").last.map(String.init) ?? ""),
                  let createdAt = record.forKeyword(Self.code("ascd"))?.dateValue,
                  createdAt >= since,
                  seen.insert(scriptingID as String).inserted else { continue }
            let id = registry.register(scriptingID: scriptingID as String, createdAt: createdAt as Date)
            artifacts.append(.init(id: id, createdAt: createdAt as Date))
        }
        return artifacts.sorted { $0.createdAt < $1.createdAt }
    }

    private static func code(_ value: String) -> UInt32 {
        value.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
    }
}
