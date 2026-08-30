import CallieAppleCore
import CryptoKit
import Darwin
import Foundation

public enum DescriptorRelativeDeleteError: Error, Sendable, Equatable { case failed }

public protocol DescriptorRelativeDeleting: Sendable {
    func unlinkFile(named name: String, in directoryFD: Int32) throws
    func isAbsent(named name: String, in directoryFD: Int32) throws -> Bool
}

public struct POSIXDescriptorDeleter: DescriptorRelativeDeleting {
    public init() {}

    public func unlinkFile(named name: String, in directoryFD: Int32) throws {
        guard unlinkat(directoryFD, name, 0) == 0 || errno == ENOENT else {
            throw DescriptorRelativeDeleteError.failed
        }
    }

    public func isAbsent(named name: String, in directoryFD: Int32) throws -> Bool {
        var status = stat()
        if fstatat(directoryFD, name, &status, AT_SYMLINK_NOFOLLOW) == 0 { return false }
        guard errno == ENOENT else { throw DescriptorRelativeDeleteError.failed }
        return true
    }
}

public final class NotesAttachmentExporter: NotesAttachmentExporting, @unchecked Sendable {
    private struct Identity: Equatable {
        let device: dev_t
        let inode: ino_t
        init(_ value: stat) { device = value.st_dev; inode = value.st_ino }
    }

    private static let leafName = "recording.export"
    private static let deletionAttempts = 3

    private let executor: any AppleEventExecuting
    private let registry: NotesArtifactRegistry
    private let stagingRoot: URL
    private let rootFD: Int32
    private let rootIdentity: Identity
    private let deleter: any DescriptorRelativeDeleting
    private let operationLock = NSLock()
    private let riskLock = NSLock()
    private var riskSignalStorage: UUID?

    public init(
        executor: any AppleEventExecuting,
        registry: NotesArtifactRegistry,
        stagingRoot: URL,
        deleter: any DescriptorRelativeDeleting = POSIXDescriptorDeleter()
    ) throws {
        let canonical = try PathContainment.canonicalRoot(stagingRoot)
        let descriptor = open(canonical.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw NotesAdapterError.cleanupFailed }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              (status.st_mode & S_IFMT) == S_IFDIR,
              fchmod(descriptor, mode_t(0o700)) == 0 else {
            close(descriptor)
            throw NotesAdapterError.cleanupFailed
        }
        self.executor = executor
        self.registry = registry
        self.stagingRoot = canonical
        rootFD = descriptor
        rootIdentity = Identity(status)
        self.deleter = deleter
    }

    deinit { close(rootFD) }

    public var retentionRiskSignal: UUID? { riskLock.withLock { riskSignalStorage } }

    public func proveExport(id: NotesArtifactID) throws -> ExportProof {
        try operationLock.withLock {
            guard retentionRiskSignal == nil else { throw NotesAdapterError.plaintextRetentionRisk }
            guard let entry = registry.entry(for: id) else { throw NotesAdapterError.artifactNotFound }
            guard rootPathMatchesDescriptor() else { throw markRetentionRisk() }

            let directoryName = "callie-notes-export-\(UUID().uuidString.lowercased())"
            guard mkdirat(rootFD, directoryName, mode_t(0o700)) == 0 else { throw NotesAdapterError.exportFailed }
            let exportFD = openat(rootFD, directoryName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard exportFD >= 0 else {
                _ = unlinkat(rootFD, directoryName, AT_REMOVEDIR)
                throw NotesAdapterError.exportFailed
            }
            defer { close(exportFD) }
            var exportStatus = stat()
            guard fstat(exportFD, &exportStatus) == 0 else { throw markRetentionRisk() }
            let exportIdentity = Identity(exportStatus)
            let destination = stagingRoot
                .appending(path: directoryName, directoryHint: .isDirectory)
                .appending(path: Self.leafName)

            let executionFailed: Bool
            do {
                _ = try executor.execute(.notesSaveAttachment(scriptingID: entry.scriptingID, destination: destination))
                executionFailed = false
            } catch {
                executionFailed = true
            }

            guard rootPathMatchesDescriptor(),
                  directoryMatchesDescriptor(name: directoryName, directoryFD: exportFD, identity: exportIdentity) else {
                _ = try? deleteAndVerifyLeaf(in: exportFD)
                throw markRetentionRisk()
            }

            let fileFD = openat(exportFD, Self.leafName, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            if fileFD < 0 {
                let openError = errno
                let absent = (try? deleter.isAbsent(named: Self.leafName, in: exportFD)) == true
                do {
                    try deleteAndVerifyLeaf(in: exportFD)
                    try removeAndVerifyExportDirectory(named: directoryName, directoryFD: exportFD, identity: exportIdentity)
                } catch {
                    throw markRetentionRisk()
                }
                if !absent || openError == ELOOP { throw markRetentionRisk() }
                throw NotesAdapterError.exportFailed
            }

            var fileStatus = stat()
            guard fstat(fileFD, &fileStatus) == 0,
                  (fileStatus.st_mode & S_IFMT) == S_IFREG,
                  fileStatus.st_nlink == 1,
                  fileStatus.st_uid == geteuid() else {
                close(fileFD)
                _ = try? deleteAndVerifyLeaf(in: exportFD)
                throw markRetentionRisk()
            }

            let digestAndCount: (String, Int64)
            do {
                digestAndCount = try Self.hashAndCount(fileFD)
            } catch {
                close(fileFD)
                do { try deleteAndVerifyLeaf(in: exportFD) } catch { throw markRetentionRisk() }
                do {
                    try removeAndVerifyExportDirectory(named: directoryName, directoryFD: exportFD, identity: exportIdentity)
                } catch {
                    throw markRetentionRisk()
                }
                throw NotesAdapterError.exportFailed
            }
            close(fileFD)

            do { try deleteAndVerifyLeaf(in: exportFD) } catch { throw markRetentionRisk() }
            do {
                try removeAndVerifyExportDirectory(named: directoryName, directoryFD: exportFD, identity: exportIdentity)
            } catch {
                throw markRetentionRisk()
            }
            if executionFailed { throw NotesAdapterError.exportFailed }
            return ExportProof(
                artifactID: id,
                byteCount: digestAndCount.1,
                sha256: digestAndCount.0,
                plaintextRetained: false
            )
        }
    }

    public func cleanAbandonedArtifacts() throws {
        try operationLock.withLock {
            guard rootPathMatchesDescriptor() else { throw markRetentionRisk() }
            // A dup shares the directory stream offset with rootFD. Reopen "."
            // descriptor-relatively so launch cleanup cannot leave shutdown cleanup
            // parked at end-of-directory.
            let enumerationFD = openat(rootFD, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard enumerationFD >= 0, let stream = fdopendir(enumerationFD) else {
                if enumerationFD >= 0 { close(enumerationFD) }
                throw NotesAdapterError.cleanupFailed
            }
            defer { closedir(stream) }
            while let entry = readdir(stream) {
                let name = withUnsafePointer(to: &entry.pointee.d_name) {
                    $0.withMemoryRebound(to: CChar.self, capacity: Int(NAME_MAX) + 1) { String(cString: $0) }
                }
                guard name != ".", name != ".." else { continue }
                if Self.isLegacyGeneratedName(name) {
                    do { try deleteWithRetries(named: name, in: rootFD) } catch { throw markRetentionRisk() }
                } else if Self.isExportDirectoryName(name) {
                    let childFD = openat(rootFD, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    guard childFD >= 0 else {
                        do {
                            try deleteWithRetries(named: name, in: rootFD)
                        } catch {
                            throw markRetentionRisk()
                        }
                        continue
                    }
                    var childStatus = stat()
                    guard fstat(childFD, &childStatus) == 0 else {
                        close(childFD)
                        throw markRetentionRisk()
                    }
                    let childIdentity = Identity(childStatus)
                    do {
                        try deleteAndVerifyLeaf(in: childFD)
                        try removeAndVerifyExportDirectory(named: name, directoryFD: childFD, identity: childIdentity)
                    } catch {
                        close(childFD)
                        throw markRetentionRisk()
                    }
                    close(childFD)
                }
            }
        }
    }

    private func deleteAndVerifyLeaf(in directoryFD: Int32) throws {
        try deleteWithRetries(named: Self.leafName, in: directoryFD)
    }

    private func deleteWithRetries(named name: String, in directoryFD: Int32) throws {
        var lastError: (any Error)?
        for _ in 0..<Self.deletionAttempts {
            do {
                try deleter.unlinkFile(named: name, in: directoryFD)
                guard try deleter.isAbsent(named: name, in: directoryFD) else {
                    throw DescriptorRelativeDeleteError.failed
                }
                return
            } catch {
                lastError = error
            }
        }
        throw lastError ?? DescriptorRelativeDeleteError.failed
    }

    private func rootPathMatchesDescriptor() -> Bool {
        var pathStatus = stat()
        var descriptorStatus = stat()
        guard lstat(stagingRoot.path, &pathStatus) == 0,
              fstat(rootFD, &descriptorStatus) == 0,
              (pathStatus.st_mode & S_IFMT) == S_IFDIR else { return false }
        return Identity(pathStatus) == rootIdentity && Identity(descriptorStatus) == rootIdentity
    }

    private func directoryMatchesDescriptor(name: String, directoryFD: Int32, identity: Identity) -> Bool {
        var boundStatus = stat()
        var descriptorStatus = stat()
        guard fstatat(rootFD, name, &boundStatus, AT_SYMLINK_NOFOLLOW) == 0,
              fstat(directoryFD, &descriptorStatus) == 0,
              (boundStatus.st_mode & S_IFMT) == S_IFDIR else { return false }
        return Identity(boundStatus) == identity && Identity(descriptorStatus) == identity
    }

    private func removeAndVerifyExportDirectory(named name: String, directoryFD: Int32, identity: Identity) throws {
        guard rootPathMatchesDescriptor(),
              directoryMatchesDescriptor(name: name, directoryFD: directoryFD, identity: identity) else {
            throw DescriptorRelativeDeleteError.failed
        }
        guard unlinkat(rootFD, name, AT_REMOVEDIR) == 0 || errno == ENOENT else {
            throw DescriptorRelativeDeleteError.failed
        }
        var status = stat()
        if fstatat(rootFD, name, &status, AT_SYMLINK_NOFOLLOW) == 0 {
            throw DescriptorRelativeDeleteError.failed
        }
        guard errno == ENOENT else { throw DescriptorRelativeDeleteError.failed }
    }

    private func markRetentionRisk() -> NotesAdapterError {
        riskLock.withLock {
            if riskSignalStorage == nil { riskSignalStorage = UUID() }
        }
        return .plaintextRetentionRisk
    }

    private static func hashAndCount(_ descriptor: Int32) throws -> (String, Int64) {
        guard lseek(descriptor, 0, SEEK_SET) >= 0 else { throw NotesAdapterError.exportFailed }
        var hasher = SHA256()
        var byteCount: Int64 = 0
        var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
        while true {
            let count = buffer.withUnsafeMutableBytes {
                Darwin.read(descriptor, $0.baseAddress, $0.count)
            }
            if count == 0 { break }
            guard count > 0 else { throw NotesAdapterError.exportFailed }
            hasher.update(data: Data(buffer[0..<count]))
            byteCount += Int64(count)
        }
        return (hasher.finalize().map { String(format: "%02x", $0) }.joined(), byteCount)
    }

    private static func isLegacyGeneratedName(_ name: String) -> Bool {
        guard name.hasPrefix("callie-notes-"), name.hasSuffix(".export") else { return false }
        let start = name.index(name.startIndex, offsetBy: "callie-notes-".count)
        let end = name.index(name.endIndex, offsetBy: -".export".count)
        return UUID(uuidString: String(name[start..<end])) != nil
    }

    private static func isExportDirectoryName(_ name: String) -> Bool {
        guard name.hasPrefix("callie-notes-export-") else { return false }
        return UUID(uuidString: String(name.dropFirst("callie-notes-export-".count))) != nil
    }
}
