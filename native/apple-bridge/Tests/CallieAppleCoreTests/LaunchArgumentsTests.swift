import Foundation
import Testing
@testable import CallieAppleBridge

@Suite("AppleBridgeLaunchArgumentsTests")
struct AppleBridgeLaunchArgumentsTests {
    @Test func acceptsTask6ExactSpellingOrderAndStandardizedAbsolutePath() throws {
        let path = "/private/tmp/callie-synthetic-staging"

        let parsed = try AppleBridgeLaunchArgumentParser.parse(["--staging-root", path])

        #expect(parsed.stagingRoot == URL(fileURLWithPath: path, isDirectory: true))
    }

    @Test func rejectsMissingDuplicateUnknownAndExtraArguments() {
        let cases: [([String], AppleBridgeLaunchArgumentError)] = [
            ([], .missingStagingRoot),
            (["--staging-root"], .missingStagingRootValue),
            (["--staging-root", "/private/tmp/one", "--staging-root", "/private/tmp/two"], .duplicateStagingRoot),
            (["--unknown", "/private/tmp/root"], .unknownArgument),
            (["--staging-root=/private/tmp/root"], .unknownArgument),
            (["positional", "--staging-root", "/private/tmp/root"], .extraPositional),
            (["--staging-root", "/private/tmp/root", "extra"], .extraPositional),
        ]

        for (arguments, expected) in cases {
            #expect(throws: expected) {
                try AppleBridgeLaunchArgumentParser.parse(arguments)
            }
        }
    }

    @Test func rejectsNonAbsoluteNonPathNonStandardAndInvalidRoots() {
        let invalidValues = [
            "",
            "relative/root",
            "~/relative/root",
            "file:///private/tmp/root",
            "https://example.invalid/root",
            "/private/tmp/../root",
            "/private/tmp//root",
            "/private/tmp/root/",
            "/",
            "/private/tmp/root\0suffix",
        ]

        for value in invalidValues {
            #expect(throws: AppleBridgeLaunchArgumentError.invalidStagingRoot) {
                try AppleBridgeLaunchArgumentParser.parse(["--staging-root", value])
            }
        }
    }

    @Test func bootstrapParsesBeforeCompositionAndPassesOnlyParsedRoot() throws {
        let path = "/private/tmp/callie-synthetic-staging"
        var receivedRoot: URL?

        let value = try AppleBridgeBootstrap.compose(arguments: ["--staging-root", path]) { stagingRoot in
            receivedRoot = stagingRoot
            return "synthetic dependencies"
        }

        #expect(value == "synthetic dependencies")
        #expect(receivedRoot == URL(fileURLWithPath: path, isDirectory: true))
    }

    @Test func invalidArgumentsFailBeforeCompositionWithConstantNoPathDiagnostic() {
        var compositionCount = 0
        let hostilePath = "/private/payload-that-must-not-leak"

        #expect(throws: AppleBridgeLaunchArgumentError.unknownArgument) {
            try AppleBridgeBootstrap.compose(arguments: ["--unknown", hostilePath]) { _ in
                compositionCount += 1
                return "must not construct"
            }
        }

        #expect(compositionCount == 0)
        #expect(AppleBridgeBootstrap.initializationFailureDiagnostic == Data("callie-apple-bridge: initialization failed\n".utf8))
        #expect(!String(decoding: AppleBridgeBootstrap.initializationFailureDiagnostic, as: UTF8.self).contains(hostilePath))
    }
}
