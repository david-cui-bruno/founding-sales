import CallieAppleCore
import Foundation

public final class MacOSDependencyContainer: @unchecked Sendable {
    public let handler: any BridgeCommandHandling
    let stagingRoot: URL

    public convenience init() throws {
        let stagingRoot = FileManager.default.temporaryDirectory
            .appending(path: "callie-apple-bridge-notes-staging", directoryHint: .isDirectory)
        let messagesDatabase = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Messages/chat.db")
        try self.init(stagingRoot: stagingRoot, messagesDatabase: messagesDatabase)
    }

    init(stagingRoot: URL, messagesDatabase: URL) throws {
        guard stagingRoot.isFileURL,
              (try? FileManager.default.destinationOfSymbolicLink(atPath: stagingRoot.path)) == nil else {
            throw PathContainmentError.invalidRoot
        }
        if !FileManager.default.fileExists(atPath: stagingRoot.path) {
            try FileManager.default.createDirectory(
                at: stagingRoot,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
        }

        let executor = SystemAppleEventExecutor()
        let registry = NotesArtifactRegistry()
        let locator = NotesRecordingLocator(executor: executor, registry: registry)
        let exporter = try NotesAttachmentExporter(executor: executor, registry: registry, stagingRoot: stagingRoot)
        try exporter.cleanAbandonedArtifacts()
        let messagesClient = MessagesScriptClient(executor: executor)
        let messagesStore = MessagesReadStore(database: messagesDatabase)
        self.stagingRoot = try PathContainment.canonicalRoot(stagingRoot)
        handler = FeasibilityBridgeCommandHandler(
            notesScanner: locator,
            notesExporter: exporter,
            messageSender: messagesClient,
            messageActivityScanner: messagesStore,
            shutdown: { try? exporter.cleanAbandonedArtifacts() }
        )
    }
}
