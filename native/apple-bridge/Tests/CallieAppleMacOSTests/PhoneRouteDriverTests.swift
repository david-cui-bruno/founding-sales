import Foundation
import XCTest
@testable import CallieAppleMacOS

@MainActor
final class PhoneRouteDriverTests: XCTestCase {
    private let app = URL(fileURLWithPath: "/fictional/Phone.app")

    private func identity(bundle: String = "com.apple.mobilephone", code: String = "signed-code-a", version: String = "1") -> PhoneRouteIdentity {
        PhoneRouteIdentity(applicationURL: app, bundleIdentifier: bundle, codeIdentity: code, appVersion: version, osVersion: "fictional-os-26.4")
    }

    func testInspectionNeverOpensAndFingerprintBindsEveryIdentityComponent() throws {
        var current = identity()
        var opens = 0
        let driver = PhoneRouteDriver(supported: { true }, lookup: { self.app }, validate: { _ in current }, opener: { _, _ in opens += 1 })
        let first = try XCTUnwrap(driver.inspect().fingerprint)
        XCTAssertEqual(driver.inspect().fingerprint, first)
        current = identity(code: "signed-code-b")
        XCTAssertNotEqual(driver.inspect().fingerprint, first)
        current = identity(version: "2")
        XCTAssertNotEqual(driver.inspect().fingerprint, first)
        current = PhoneRouteIdentity(applicationURL: app, bundleIdentifier: "com.apple.mobilephone", codeIdentity: "signed-code-a", appVersion: "1", osVersion: "changed-os")
        XCTAssertNotEqual(driver.inspect().fingerprint, first)
        XCTAssertEqual(opens, 0)
    }

    func testUnsupportedMissingWrongIdentifierAndInvalidSignatureNeverOpen() {
        var opens = 0
        let opener: PhoneRouteDriver.Opener = { _, _ in opens += 1 }
        let unsupported = PhoneRouteDriver(supported: { false }, lookup: { XCTFail("lookup on unsupported platform"); return nil }, validate: { _ in nil }, opener: opener)
        XCTAssertEqual(unsupported.inspect().status, "unavailable")
        let missing = PhoneRouteDriver(supported: { true }, lookup: { nil }, validate: { _ in nil }, opener: opener)
        XCTAssertEqual(missing.inspect().status, "unavailable")
        for value in [nil, identity(bundle: "com.example.fake"), identity(code: "")] {
            let driver = PhoneRouteDriver(supported: { true }, lookup: { self.app }, validate: { _ in value }, opener: opener)
            XCTAssertEqual(driver.inspect().status, "unavailable")
        }
        let mismatchedPath = PhoneRouteIdentity(applicationURL: URL(fileURLWithPath: "/fictional/Other.app"), bundleIdentifier: "com.apple.mobilephone", codeIdentity: "code", appVersion: "1", osVersion: "os")
        let driver = PhoneRouteDriver(supported: { true }, lookup: { self.app }, validate: { _ in mismatchedPath }, opener: opener)
        XCTAssertEqual(driver.inspect().status, "unavailable")
        XCTAssertEqual(opens, 0)
    }

    func testOpenRevalidatesFingerprintAndPassesExactApplicationAndTarget() async throws {
        var current = identity()
        var requests: [(URL, URL)] = []
        let driver = PhoneRouteDriver(supported: { true }, lookup: { self.app }, validate: { _ in current }, opener: { requests.append(($0, $1)) })
        let proof = try XCTUnwrap(driver.inspect().fingerprint)
        current = identity(code: "replacement")
        let refused = await driver.open(target: "+12025550123", expectedFingerprint: proof)
        XCTAssertEqual(refused.status, "unavailable")
        XCTAssertTrue(requests.isEmpty)
        current = identity()
        let result = await driver.open(target: "+12025550123", expectedFingerprint: proof)
        XCTAssertEqual(result.status, "available")
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.0.absoluteString, "tel:+12025550123")
        XCTAssertEqual(requests.first?.1, app)
    }

    func testMalformedTargetsNeverOpen() async throws {
        var opens = 0
        let driver = PhoneRouteDriver(supported: { true }, lookup: { self.app }, validate: { _ in self.identity() }, opener: { _, _ in opens += 1 })
        let proof = try XCTUnwrap(driver.inspect().fingerprint)
        for target in ["tel:+12025550123", "+12025550123\n", " +12025550123", "+02025550123", "+123", "+12025550123;ext=1", "+12025550123?x=1", "+１２３４５６７８９"] {
            let result = await driver.open(target: target, expectedFingerprint: proof)
            XCTAssertEqual(result.status, "unavailable", target)
        }
        XCTAssertEqual(opens, 0)
    }

    func testCancellationAndOpenerFailureProduceSanitizedUnavailable() async throws {
        let driver = PhoneRouteDriver(supported: { true }, lookup: { self.app }, validate: { _ in self.identity() }, opener: { _, _ in throw CancellationError() })
        let proof = try XCTUnwrap(driver.inspect().fingerprint)
        let result = await driver.open(target: "+12025550123", expectedFingerprint: proof)
        XCTAssertEqual(result.status, "unavailable")
        let json = String(decoding: try JSONEncoder().encode(result), as: UTF8.self)
        XCTAssertFalse(json.contains("12025550123"))
        XCTAssertFalse(json.contains("/fictional"))
    }

    func testInputTimeoutAndTruncatedFrameNeverReachAnOpener() throws {
        XCTAssertThrowsError(try PhoneRouteInput.read { maximum, timeout in
            XCTAssertLessThanOrEqual(maximum, 4097)
            XCTAssertLessThanOrEqual(timeout, 1000)
            return nil // injected timeout, no descriptor or OS access
        })
        var chunks = [Data("{\"version\":".utf8), Data()]
        let frame = try PhoneRouteInput.read { _, _ in chunks.removeFirst() }
        XCTAssertThrowsError(try PhoneRouteRequest.decode(frame))
        XCTAssertThrowsError(try PhoneRouteInput.read { _, _ in Data(repeating: 32, count: 4097) })
    }

    func testOneShotModesBranchBeforeBootstrapAndKeepNormalDependenciesOut() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let main = try String(contentsOf: root.appending(path: "Sources/CallieAppleBridge/main.swift"), encoding: .utf8)
        let mode = try String(contentsOf: root.appending(path: "Sources/CallieAppleBridge/PhoneRouteMode.swift"), encoding: .utf8)
        let branch = try XCTUnwrap(main.range(of: "PhoneRouteMode"))
        let bootstrap = try XCTUnwrap(main.range(of: "AppleBridgeBootstrap.compose"))
        XCTAssertLessThan(branch.lowerBound, bootstrap.lowerBound)
        XCTAssertFalse(mode.contains("AppleBridgeBootstrap"))
        XCTAssertFalse(mode.contains("MacOSDependencyContainer"))
        XCTAssertTrue(mode.contains("--phone-route-inspect"))
        XCTAssertTrue(mode.contains("--phone-route-open"))
    }

    func testStrictBoundedRequestRejectsTruncationUnknownFieldsAndMalformedTarget() throws {
        let valid = #"{"version":1,"target":"+12025550123","expectedFingerprint":"fixture-proof"}"#
        XCTAssertEqual(try PhoneRouteRequest.decode(Data(valid.utf8)).target, "+12025550123")
        for input in [String(valid.dropLast()), valid + valid, valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":2"), valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":true"), valid.replacingOccurrences(of: "\"version\":1", with: "\"extra\":0,\"version\":1"), valid.replacingOccurrences(of: "+12025550123", with: "tel:+12025550123"), String(repeating: " ", count: 4097)] {
            XCTAssertThrowsError(try PhoneRouteRequest.decode(Data(input.utf8)))
        }
    }
}
