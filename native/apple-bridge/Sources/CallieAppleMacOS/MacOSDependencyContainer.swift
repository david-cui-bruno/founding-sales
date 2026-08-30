import CallieAppleCore
import Foundation

public final class MacOSDependencyContainer: @unchecked Sendable {
    public let handler: any BridgeCommandHandling
    let stagingRoot: URL
    let feasibilityController: any AppleFeasibilityControlling

    public convenience init(stagingRoot: URL) throws {
        let messagesDatabase = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Messages/chat.db")
        try self.init(
            stagingRoot: stagingRoot,
            messagesDatabase: messagesDatabase,
            feasibilityController: Self.makeProductionFeasibilityController()
        )
    }

    convenience init(stagingRoot: URL, messagesDatabase: URL) throws {
        try self.init(
            stagingRoot: stagingRoot,
            messagesDatabase: messagesDatabase,
            feasibilityController: Self.makeProductionFeasibilityController()
        )
    }

    init(
        stagingRoot: URL,
        messagesDatabase: URL,
        feasibilityController: any AppleFeasibilityControlling
    ) throws {
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
        self.feasibilityController = feasibilityController
        handler = FeasibilityBridgeCommandHandler(
            notesScanner: locator,
            notesExporter: exporter,
            messageSender: messagesClient,
            messageActivityScanner: messagesStore,
            feasibilityController: feasibilityController,
            shutdown: {
                do {
                    try exporter.cleanAbandonedArtifacts()
                } catch {
                    throw BridgeShutdownError.cleanupVerificationFailed
                }
            }
        )
    }

    private static func makeProductionFeasibilityController() -> any AppleFeasibilityControlling {
        let callObserver = PhoneAccessibilityCallObserver(
            snapshotter: SystemPhoneAXAdapter(),
            scheduler: DispatchBoundedCallObservationScheduler(),
            idGenerator: UUIDCallIDGenerator(),
            registry: LockedCurrentPhoneCallRegistry(),
            identitySink: { _ in },
            capabilitySink: { _ in }
        )
        return MacOSFeasibilityController(
            contacts: SystemContactStore(),
            accessibility: SystemAccessibilityAuthorization(),
            observer: callObserver,
            callObservationAvailable: true
        )
    }
}
