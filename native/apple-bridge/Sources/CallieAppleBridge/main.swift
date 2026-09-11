import CallieAppleMacOS
import Foundation

if let phoneMode = PhoneRouteMode(arguments: Array(CommandLine.arguments.dropFirst())) {
    phoneMode.run()
    dispatchMain()
}

do {
    let frameWriter = SynchronizedJSONLFrameWriter()
    let dependencies = try AppleBridgeBootstrap.compose(
        arguments: Array(CommandLine.arguments.dropFirst()),
        makeDependencies: {
            try MacOSDependencyContainer(stagingRoot: $0, eventEmitter: frameWriter)
        }
    )
    let server = StdioBridgeServer(handler: dependencies.handler, frameWriter: frameWriter)
    Task.detached {
        await server.run()
        _ = dependencies
        exit(EXIT_SUCCESS)
    }
    dispatchMain()
} catch {
    FileHandle.standardError.write(AppleBridgeBootstrap.initializationFailureDiagnostic)
    exit(EXIT_FAILURE)
}
