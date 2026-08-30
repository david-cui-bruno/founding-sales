import Foundation

let server = StdioBridgeServer()
Task.detached {
    await server.run()
    exit(EXIT_SUCCESS)
}
dispatchMain()
