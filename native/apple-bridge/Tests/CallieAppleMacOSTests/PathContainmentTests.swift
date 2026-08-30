import Foundation
import Testing
@testable import CallieAppleMacOS

@Suite("PathContainmentTests")
struct PathContainmentTests {
    @Test func artifactExportCannotEscapeStagingRoot() throws {
        let root = try temporaryDirectory()
        #expect(throws: PathContainmentError.escapeAttempt) {
            try PathContainment.resolve(relativeName: "../Messages/chat.db", under: root)
        }
        #expect(throws: PathContainmentError.escapeAttempt) {
            try PathContainment.resolve(relativeName: "/private/tmp/outside", under: root)
        }
    }

    @Test func symlinkInsideRootCannotRedirectExportOutsideRoot() throws {
        let root = try temporaryDirectory()
        let outside = try temporaryDirectory()
        let link = root.appending(path: "callie-notes-escape.export")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside.appending(path: "outside.export"))

        #expect(throws: PathContainmentError.escapeAttempt) {
            try PathContainment.resolve(relativeName: link.lastPathComponent, under: root)
        }
    }

    @Test func stagingRootItselfCannotBeASymlink() throws {
        let parent = try temporaryDirectory()
        let outside = try temporaryDirectory()
        let link = parent.appending(path: "linked-root")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)

        #expect(throws: PathContainmentError.invalidRoot) {
            try PathContainment.canonicalRoot(link)
        }
    }

    @Test func plainGeneratedNameResolvesDirectlyBelowCanonicalRoot() throws {
        let root = try temporaryDirectory()
        let resolved = try PathContainment.resolve(relativeName: "callie-notes-11111111-1111-4111-8111-111111111111.export", under: root)
        #expect(resolved.deletingLastPathComponent() == root.resolvingSymlinksInPath().standardizedFileURL)
    }
}

private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "callie-path-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    return url
}
