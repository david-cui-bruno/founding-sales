import CallieAppleMacOS
import Darwin
import Foundation

/// These exact one-shot modes are selected before normal dependency construction.
enum PhoneRouteMode {
    case inspect
    case open

    init?(arguments: [String]) {
        switch arguments {
        case ["--phone-route-inspect"]: self = .inspect
        case ["--phone-route-open"]: self = .open
        default: return nil
        }
    }

    func run() {
        Task { @MainActor in
            let driver = PhoneRouteDriver.system()
            let result: PhoneRouteResult
            switch self {
            case .inspect:
                // No stdin, permissions, contacts, bridge server or opener involved.
                result = driver.inspect()
            case .open:
                do {
                    let data = try PhoneRouteInput.read { maximum, timeout in
                        var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
                        let ready = Darwin.poll(&descriptor, 1, Int32(timeout))
                        if ready == 0 { return nil }
                        guard ready > 0, descriptor.revents & Int16(POLLERR | POLLNVAL) == 0 else {
                            throw PhoneRouteError.invalidRequest
                        }
                        var bytes = [UInt8](repeating: 0, count: maximum)
                        let count = Darwin.read(STDIN_FILENO, &bytes, maximum)
                        guard count >= 0 else { throw PhoneRouteError.invalidRequest }
                        return Data(bytes.prefix(count))
                    }
                    let request = try PhoneRouteRequest.decode(data)
                    result = await driver.open(target: request.target, expectedFingerprint: request.expectedFingerprint)
                } catch {
                    result = .unavailable("invalid_request")
                }
            }
            // Exactly one sanitized reply. The parent bounds process lifetime/output.
            let encoded = (try? JSONEncoder().encode(result))
                ?? Data(#"{"version":1,"status":"unavailable","reason":"route_unavailable"}"#.utf8)
            FileHandle.standardOutput.write(encoded + Data([10]))
            exit(EXIT_SUCCESS)
        }
    }
}
