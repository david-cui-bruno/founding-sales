import CallieAppleMacOS
import Foundation

do {
    let dependencies = try AppleBridgeBootstrap.compose(
        arguments: Array(CommandLine.arguments.dropFirst()),
        makeDependencies: { try MacOSDependencyContainer(stagingRoot: $0) }
    )
    let server = StdioBridgeServer(handler: dependencies.handler)
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
