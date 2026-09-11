@preconcurrency import AppKit
import CryptoKit
import Foundation
import Security

public struct PhoneRouteIdentity: Sendable {
    public let applicationURL: URL
    public let bundleIdentifier: String
    public let codeIdentity: String
    public let appVersion: String
    public let osVersion: String

    public init(applicationURL: URL, bundleIdentifier: String, codeIdentity: String, appVersion: String, osVersion: String) {
        self.applicationURL = applicationURL
        self.bundleIdentifier = bundleIdentifier
        self.codeIdentity = codeIdentity
        self.appVersion = appVersion
        self.osVersion = osVersion
    }

    fileprivate var fingerprint: String {
        // An ordered JSON array makes component boundaries unambiguous.
        let components = [applicationURL.absoluteString, bundleIdentifier, codeIdentity, osVersion, appVersion]
        let data = (try? JSONEncoder().encode(components)) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

public struct PhoneRouteResult: Encodable, Sendable {
    public let version = 1
    public let status: String
    public let fingerprint: String?
    public let reason: String?

    public static func unavailable(_ reason: String = "route_unavailable") -> Self {
        Self(status: "unavailable", fingerprint: nil, reason: reason)
    }

    fileprivate static func available(_ fingerprint: String) -> Self {
        Self(status: "available", fingerprint: fingerprint, reason: nil)
    }
}

public enum PhoneRouteError: Error { case invalidRequest, inputTimeout }

public struct PhoneRouteRequest: Decodable, Sendable {
    public let version: Int
    public let target: String
    public let expectedFingerprint: String

    public static func decode(_ data: Data) throws -> Self {
        guard !data.isEmpty, data.count <= 4096,
              let raw = String(data: data, encoding: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["version", "target", "expectedFingerprint"]) else { throw PhoneRouteError.invalidRequest }
        // Reject duplicate fields (including escaped spellings), rather than accepting
        // the decoder's last value. The schema below only permits flat scalar fields.
        let keys = try NSRegularExpression(pattern: #""(?:\\.|[^"\\])*"\s*:"#)
        guard keys.numberOfMatches(in: raw, range: NSRange(raw.startIndex..., in: raw)) == 3 else { throw PhoneRouteError.invalidRequest }
        let request = try JSONDecoder().decode(Self.self, from: data)
        guard request.version == 1, canonicalTarget(request.target), validFingerprint(request.expectedFingerprint) else { throw PhoneRouteError.invalidRequest }
        return request
    }
}

private func canonicalTarget(_ target: String) -> Bool {
    let bytes = Array(target.utf8)
    return (9...16).contains(bytes.count) && bytes[0] == 43
        && (49...57).contains(bytes[1]) && bytes.dropFirst(2).allSatisfy { (48...57).contains($0) }
}

private func validFingerprint(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    return (1...256).contains(bytes.count) && bytes.allSatisfy {
        (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
    }
}

public enum PhoneRouteInput {
    /// nil means timeout, empty means EOF. A single deadline covers all chunks.
    public static func read(next: (_ maximumBytes: Int, _ timeoutMilliseconds: Int) throws -> Data?) throws -> Data {
        let start = DispatchTime.now().uptimeNanoseconds
        var frame = Data()
        while true {
            let elapsed = (DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            guard elapsed < 1000 else { throw PhoneRouteError.inputTimeout }
            let maximum = 4097 - frame.count
            guard let chunk = try next(maximum, Int(1000 - elapsed)) else { throw PhoneRouteError.inputTimeout }
            guard chunk.count <= maximum else { throw PhoneRouteError.invalidRequest }
            if chunk.isEmpty { return frame }
            frame.append(chunk)
            guard frame.count <= 4096 else { throw PhoneRouteError.invalidRequest }
        }
    }
}

@MainActor
public final class PhoneRouteDriver {
    public typealias Opener = @MainActor (URL, URL) async throws -> Void
    private let supported: () -> Bool
    private let lookup: () -> URL?
    private let validate: (URL) -> PhoneRouteIdentity?
    private let opener: Opener

    public init(supported: @escaping () -> Bool, lookup: @escaping () -> URL?, validate: @escaping (URL) -> PhoneRouteIdentity?, opener: @escaping Opener) {
        self.supported = supported
        self.lookup = lookup
        self.validate = validate
        self.opener = opener
    }

    private func route() -> PhoneRouteIdentity? {
        guard supported(), let url = lookup(), url.isFileURL,
              let identity = validate(url), identity.applicationURL == url,
              identity.bundleIdentifier == PhoneAXContract.bundleIdentifier,
              !identity.codeIdentity.isEmpty, !identity.appVersion.isEmpty, !identity.osVersion.isEmpty else { return nil }
        return identity
    }

    public func inspect() -> PhoneRouteResult {
        guard let identity = route() else { return .unavailable() }
        return .available(identity.fingerprint)
    }

    public func open(target: String, expectedFingerprint: String) async -> PhoneRouteResult {
        guard !Task.isCancelled, canonicalTarget(target), validFingerprint(expectedFingerprint),
              let identity = route(), identity.fingerprint == expectedFingerprint,
              let targetURL = URL(string: "tel:" + target) else { return .unavailable() }
        do {
            try Task.checkCancellation()
            try await opener(targetURL, identity.applicationURL)
            try Task.checkCancellation()
            return .available(identity.fingerprint)
        } catch {
            // The OS may already have received the request. The TS launcher treats
            // every open rejection as unknown, never as permission to retry.
            return .unavailable("handoff_uncertain")
        }
    }

    /// Construction and inspection never invoke the opener or request permissions.
    public static func system() -> PhoneRouteDriver {
        PhoneRouteDriver(
            supported: { if #available(macOS 26.4, *) { return true }; return false },
            lookup: {
                NSWorkspace.shared.urlForApplication(withBundleIdentifier: PhoneAXContract.bundleIdentifier)?
                    .resolvingSymlinksInPath().standardizedFileURL
            },
            validate: { applicationURL in
                var code: SecStaticCode?
                guard SecStaticCodeCreateWithPath(applicationURL as CFURL, [], &code) == errSecSuccess,
                      let code else { return nil }
                var requirement: SecRequirement?
                let rule = "anchor apple and identifier \"\(PhoneAXContract.bundleIdentifier)\""
                guard SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
                      let requirement,
                      SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures), requirement) == errSecSuccess else { return nil }
                var information: CFDictionary?
                guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
                      let metadata = information as? [String: Any],
                      let identifier = metadata[kSecCodeInfoIdentifier as String] as? String,
                      identifier == PhoneAXContract.bundleIdentifier,
                      let unique = metadata[kSecCodeInfoUnique as String] as? Data, !unique.isEmpty,
                      let bundle = Bundle(url: applicationURL), bundle.bundleIdentifier == identifier,
                      let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                      let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String else { return nil }
                return PhoneRouteIdentity(applicationURL: applicationURL, bundleIdentifier: identifier,
                    codeIdentity: unique.base64EncodedString(), appVersion: version + ":" + build,
                    osVersion: ProcessInfo.processInfo.operatingSystemVersionString)
            },
            opener: { targetURL, applicationURL in
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    NSWorkspace.shared.open([targetURL], withApplicationAt: applicationURL,
                        configuration: NSWorkspace.OpenConfiguration()) { application, error in
                            if error != nil || application == nil { continuation.resume(throwing: PhoneRouteError.invalidRequest) }
                            else { continuation.resume() }
                        }
                }
            }
        )
    }
}
