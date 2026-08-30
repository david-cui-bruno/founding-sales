import CallieAppleCore
import CryptoKit
import Foundation

public final class NotesAttachmentExporter: NotesAttachmentExporting, @unchecked Sendable {
    private let executor: any AppleEventExecuting
    private let registry: NotesArtifactRegistry
    private let stagingRoot: URL
    private let operationLock = NSLock()

    public init(executor: any AppleEventExecuting, registry: NotesArtifactRegistry, stagingRoot: URL) throws {
        let canonical = try PathContainment.canonicalRoot(stagingRoot)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: canonical.path)
        let permissions = try FileManager.default.attributesOfItem(atPath: canonical.path)[.posixPermissions] as? NSNumber
        guard permissions?.intValue == 0o700 else { throw NotesAdapterError.cleanupFailed }
        self.executor = executor
        self.registry = registry
        self.stagingRoot = canonical
    }

    public func proveExport(id: NotesArtifactID) throws -> ExportProof {
        try operationLock.withLock {
            guard let entry = registry.entry(for: id) else { throw NotesAdapterError.artifactNotFound }
            let name = "callie-notes-\(UUID().uuidString.lowercased()).export"
            let destination = try PathContainment.resolve(relativeName: name, under: stagingRoot)
            guard !FileManager.default.fileExists(atPath: destination.path) else {
                throw NotesAdapterError.exportFailed
            }

            defer {
                try? FileManager.default.removeItem(at: destination)
            }
            do {
                _ = try executor.execute(.notesSaveAttachment(scriptingID: entry.scriptingID, destination: destination))
            } catch {
                throw NotesAdapterError.exportFailed
            }

            guard FileManager.default.fileExists(atPath: destination.path),
                  try PathContainment.resolve(relativeName: name, under: stagingRoot) == destination else {
                throw NotesAdapterError.exportFailed
            }
            let values = try destination.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else {
                throw NotesAdapterError.exportFailed
            }

            let digest: String
            let byteCount: Int64
            do {
                (digest, byteCount) = try Self.hashAndCount(destination)
                try FileManager.default.removeItem(at: destination)
            } catch {
                throw NotesAdapterError.cleanupFailed
            }
            guard !FileManager.default.fileExists(atPath: destination.path) else {
                throw NotesAdapterError.cleanupFailed
            }
            return ExportProof(artifactID: id, byteCount: byteCount, sha256: digest, plaintextRetained: false)
        }
    }

    public func cleanAbandonedArtifacts() throws {
        try operationLock.withLock {
            let entries = try FileManager.default.contentsOfDirectory(
                at: stagingRoot,
                includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
            for entry in entries where Self.isGeneratedName(entry.lastPathComponent) {
                guard entry.deletingLastPathComponent().standardizedFileURL == stagingRoot else { continue }
                let values = try entry.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .isDirectoryKey])
                guard values.isRegularFile == true || values.isSymbolicLink == true else { continue }
                try FileManager.default.removeItem(at: entry)
            }
        }
    }

    private static func hashAndCount(_ url: URL) throws -> (String, Int64) {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        var byteCount: Int64 = 0
        while let data = try handle.read(upToCount: 64 * 1_024), !data.isEmpty {
            hasher.update(data: data)
            byteCount += Int64(data.count)
        }
        return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), byteCount)
    }

    private static func isGeneratedName(_ name: String) -> Bool {
        guard name.hasPrefix("callie-notes-"), name.hasSuffix(".export") else { return false }
        let start = name.index(name.startIndex, offsetBy: "callie-notes-".count)
        let end = name.index(name.endIndex, offsetBy: -".export".count)
        return UUID(uuidString: String(name[start..<end])) != nil
    }
}
