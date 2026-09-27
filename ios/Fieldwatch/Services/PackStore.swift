import Foundation

/// One JSON file per festival in Application Support. Small, atomic, and
/// readable with no network at all.
struct PackStore {
    private let directory: URL

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = base.appending(path: "Packs")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func url(for id: String) -> URL { directory.appending(path: "\(id).json") }

    func save(_ pack: FestivalPack) throws {
        try JSONEncoder.fieldwatch.encode(pack).write(to: url(for: pack.festival.id), options: .atomic)
    }

    func load(_ id: String) -> FestivalPack? {
        guard let data = try? Data(contentsOf: url(for: id)) else { return nil }
        return try? JSONDecoder.fieldwatch.decode(FestivalPack.self, from: data)
    }

    func remove(_ id: String) {
        try? FileManager.default.removeItem(at: url(for: id))
    }

    func savedIDs() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
    }

    func sizeInBytes(of id: String) -> Int {
        (try? FileManager.default.attributesOfItem(atPath: url(for: id).path)[.size] as? Int) ?? 0
    }
}
