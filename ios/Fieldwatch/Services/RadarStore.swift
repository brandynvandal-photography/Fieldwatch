import UIKit

/// Radar frames on disk, one PNG per timestamp per festival, so the last loop the phone saw
/// still plays with no signal. A frame never changes once it exists, so a file on disk is
/// always still right; only frames that fell out of the loop get removed.
final class RadarStore {
    private let directory: URL
    private let memory = NSCache<NSString, UIImage>()

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = base.appending(path: "Radar")
        memory.countLimit = 160
    }

    private func file(_ festivalID: String, _ frame: RadarLoop.Frame) -> URL {
        directory.appending(path: festivalID).appending(path: (frame.url as NSString).lastPathComponent)
    }

    func isSaved(_ frame: RadarLoop.Frame, festivalID: String) -> Bool {
        FileManager.default.fileExists(atPath: file(festivalID, frame).path)
    }

    /// Memory, then disk, then the backend. Nil when offline with nothing saved.
    func image(for frame: RadarLoop.Frame, in loop: RadarLoop, festivalID: String) async -> UIImage? {
        let url = file(festivalID, frame)
        let key = url.path as NSString
        if let hit = memory.object(forKey: key) { return hit }
        if let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
            memory.setObject(image, forKey: key)
            return image
        }
        guard let remote = loop.url(for: frame),
              let result = try? await URLSession.shared.data(from: remote),
              (result.1 as? HTTPURLResponse)?.statusCode == 200,
              let image = UIImage(data: result.0) else { return nil }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? result.0.write(to: url, options: .atomic)
        memory.setObject(image, forKey: key)
        return image
    }

    /// Pull down whatever the loop lists that isn't saved yet, newest first, so the present is
    /// there before the past. Called after every refresh while online.
    func prefetch(_ loop: RadarLoop, festivalID: String) async {
        for frame in loop.frames.reversed() where !isSaved(frame, festivalID: festivalID) {
            if Task.isCancelled { return }
            _ = await image(for: frame, in: loop, festivalID: festivalID)
        }
    }

    /// Keep exactly the frames the loop lists, so the cache stays at one loop per festival.
    func prune(keeping loop: RadarLoop, festivalID: String) {
        let keep = Set(loop.frames.map { ($0.url as NSString).lastPathComponent })
        let dir = directory.appending(path: festivalID)
        for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where !keep.contains(name) {
            try? FileManager.default.removeItem(at: dir.appending(path: name))
        }
    }

    func remove(festivalID: String) {
        try? FileManager.default.removeItem(at: directory.appending(path: festivalID))
    }
}
