import Foundation
import Testing
@testable import CallieAppleProtocol

@Test func rejectsOversizedFrameWithoutDecoding() throws {
    let codec = JSONLinesCodec(maxFrameBytes: 8)

    #expect(throws: JSONLinesCodecError.frameTooLarge) {
        try codec.decodeLine(Data(repeating: 0x61, count: 9))
    }
}
