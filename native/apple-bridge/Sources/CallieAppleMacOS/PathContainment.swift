import Foundation

public enum PathContainmentError: Error, Sendable, Equatable {
    case invalidRoot
    case escapeAttempt
}

public enum PathContainment {
    public static func canonicalRoot(_ root: URL) throws -> URL {
        guard root.isFileURL,
              (try? FileManager.default.destinationOfSymbolicLink(atPath: root.path)) == nil else {
            throw PathContainmentError.invalidRoot
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw PathContainmentError.invalidRoot
        }
        return root.resolvingSymlinksInPath().standardizedFileURL
    }

    public static func resolve(relativeName: String, under root: URL) throws -> URL {
        guard !relativeName.isEmpty,
              relativeName != ".",
              relativeName != "..",
              !relativeName.contains("/"),
              !relativeName.contains("\0") else {
            throw PathContainmentError.escapeAttempt
        }

        let canonical = try canonicalRoot(root)
        let candidate = canonical.appending(path: relativeName).standardizedFileURL
        guard candidate.deletingLastPathComponent() == canonical else {
            throw PathContainmentError.escapeAttempt
        }

        if (try? FileManager.default.destinationOfSymbolicLink(atPath: candidate.path)) != nil {
            throw PathContainmentError.escapeAttempt
        }
        if FileManager.default.fileExists(atPath: candidate.path) {
            let resolved = candidate.resolvingSymlinksInPath().standardizedFileURL
            guard resolved.deletingLastPathComponent() == canonical else {
                throw PathContainmentError.escapeAttempt
            }
        }
        return candidate
    }
}
