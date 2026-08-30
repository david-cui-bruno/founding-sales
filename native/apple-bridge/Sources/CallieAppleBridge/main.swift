import CallieAppleMacOS
import Foundation

do {
    let dependencies = try MacOSDependencyContainer()
    let server = StdioBridgeServer(handler: dependencies.handler)
    Task.detached {
        await server.run()
        _ = dependencies
        exit(EXIT_SUCCESS)
    }
    dispatchMain()
} catch {
    FileHandle.standardError.write(Data("callie-apple-bridge: initialization failed\n".utf8))
    exit(EXIT_FAILURE)
}
