import SwiftUI
import MapKit

/// The last twelve hours of NEXRAD reflectivity over the grounds, as a loop on a map. Frames
/// come from the backend's cache and stay on the phone, so the last loop plays with no signal.
struct RadarView: View {
    @Environment(AppState.self) private var app
    @State private var index = 0
    @State private var playing = true
    @State private var images: [Date: UIImage] = [:]
    @State private var loading = false

    var body: some View {
        Group {
            if let loop = app.radar, let festival = app.selectedFestival, !loop.frames.isEmpty {
                content(loop, festival)
            } else {
                ContentUnavailableView("No radar yet", systemImage: "cloud.rain",
                                       description: Text(app.isOnline
                                                         ? "The loop downloads with the festival pack. Pull to refresh on the festival screen."
                                                         : "Radar needs one download with signal. After that it plays offline."))
            }
        }
        .navigationTitle("Radar")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func content(_ loop: RadarLoop, _ festival: Festival) -> some View {
        VStack(spacing: 0) {
            RadarMap(loop: loop, festival: festival, image: currentImage(loop))
                .overlay(alignment: .topLeading) { timeBadge(loop) }
                .overlay(alignment: .bottomTrailing) { legend }
            controls(loop)
        }
        .task(id: loop.generatedAt) { await load(loop, festival) }
        .task(id: playing) { await animate() }
    }

    private func frame(at i: Int, in loop: RadarLoop) -> RadarLoop.Frame? {
        loop.frames.indices.contains(i) ? loop.frames[i] : nil
    }

    private func currentImage(_ loop: RadarLoop) -> UIImage? {
        frame(at: index, in: loop).flatMap { images[$0.time] }
    }

    /// Newest frame first, so the present shows while the past fills in.
    private func load(_ loop: RadarLoop, _ festival: Festival) async {
        if images.isEmpty || index >= loop.frames.count { index = loop.frames.count - 1 }
        loading = true
        for frame in loop.frames.reversed() where images[frame.time] == nil {
            if Task.isCancelled { break }
            if let image = await app.radarStore.image(for: frame, in: loop, festivalID: festival.id) {
                images[frame.time] = image
            }
        }
        loading = false
    }

    private func animate() async {
        guard playing else { return }
        while !Task.isCancelled {
            let count = app.radar?.frames.count ?? 0
            let atEnd = index >= count - 1
            try? await Task.sleep(for: .milliseconds(atEnd ? 1400 : 110))
            guard playing, count > 0, !Task.isCancelled else { return }
            index = atEnd ? 0 : index + 1
        }
    }

    private func timeBadge(_ loop: RadarLoop) -> some View {
        HStack(spacing: 6) {
            if loading { ProgressView().controlSize(.small) }
            if let f = frame(at: index, in: loop) {
                Text("\(f.time.formatted(date: .omitted, time: .shortened)), \(f.time.formatted(.relative(presentation: .named)))")
            } else {
                Text("Loading")
            }
        }
        .font(.subheadline.weight(.semibold).monospacedDigit())
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(.regularMaterial, in: Capsule())
        .padding(12)
    }

    private var legend: some View {
        HStack(spacing: 6) {
            LinearGradient(colors: [.green, .yellow, .orange, .red, .purple], startPoint: .leading, endPoint: .trailing)
                .frame(width: 64, height: 8)
                .clipShape(Capsule())
            Text("light to heavy").font(.caption2)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(.regularMaterial, in: Capsule())
        .padding(12)
    }

    private func controls(_ loop: RadarLoop) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 14) {
                Button { playing.toggle() } label: {
                    Image(systemName: playing ? "pause.fill" : "play.fill").font(.title3).frame(width: 34, height: 34)
                }
                .accessibilityLabel(playing ? "Pause" : "Play")
                Slider(value: Binding(get: { Double(index) }, set: { index = Int($0.rounded()); playing = false }),
                       in: 0...Double(max(loop.frames.count - 1, 0)), step: 1)
                Text(frame(at: index, in: loop)?.time.formatted(date: .omitted, time: .shortened) ?? "")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .frame(width: 78, alignment: .trailing)
            }
            Text(footer(loop)).font(.footnote).foregroundStyle(.secondary)
        }
        .padding(16)
        .background(Color(.systemGroupedBackground))
    }

    private func footer(_ loop: RadarLoop) -> String {
        let span = "Last \(loop.hours) hours, every \(loop.stepMinutes) minutes."
        guard let newest = loop.newest else { return span }
        let age = newest.time.formatted(.relative(presentation: .named))
        return app.isOnline
            ? "\(span) Newest frame \(age). \(loop.attribution)."
            : "\(span) Newest frame \(age), before signal dropped. \(loop.attribution)."
    }
}

/// MapKit with one image overlay: SwiftUI's Map has no raster overlays, so this is UIKit.
struct RadarMap: UIViewRepresentable {
    let loop: RadarLoop
    let festival: Festival
    let image: UIImage?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.mapType = .mutedStandard
        map.pointOfInterestFilter = .excludingAll
        map.isRotateEnabled = false
        map.isPitchEnabled = false
        map.showsCompass = false

        let overlay = RadarOverlay(bounds: loop.bounds)
        map.addOverlay(overlay, level: .aboveRoads)
        let square = overlay.boundingMapRect
        map.setCameraBoundary(MKMapView.CameraBoundary(mapRect: square), animated: false)
        map.setCameraZoomRange(MKMapView.CameraZoomRange(minCenterCoordinateDistance: 15_000, maxCenterCoordinateDistance: 900_000), animated: false)
        map.setVisibleMapRect(square.insetBy(dx: square.width * 0.22, dy: square.height * 0.22), animated: false)

        let pin = MKPointAnnotation()
        pin.coordinate = CLLocationCoordinate2D(latitude: festival.latitude, longitude: festival.longitude)
        pin.title = festival.name
        map.addAnnotation(pin)
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        context.coordinator.image = image
        context.coordinator.renderer?.image = image
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        var image: UIImage?
        var renderer: RadarOverlayRenderer?

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            guard let radar = overlay as? RadarOverlay else { return MKOverlayRenderer(overlay: overlay) }
            let r = RadarOverlayRenderer(overlay: radar)
            r.image = image
            renderer = r
            return r
        }
    }
}

/// The fixed square the backend rendered every frame for.
final class RadarOverlay: NSObject, MKOverlay {
    let coordinate: CLLocationCoordinate2D
    let boundingMapRect: MKMapRect

    init(bounds b: RadarLoop.Bounds) {
        let nw = MKMapPoint(CLLocationCoordinate2D(latitude: b.north, longitude: b.west))
        let se = MKMapPoint(CLLocationCoordinate2D(latitude: b.south, longitude: b.east))
        boundingMapRect = MKMapRect(x: nw.x, y: nw.y, width: se.x - nw.x, height: se.y - nw.y)
        coordinate = CLLocationCoordinate2D(latitude: (b.north + b.south) / 2, longitude: (b.east + b.west) / 2)
    }
}

/// Draws the current frame stretched over the square. The frames and MapKit are both Web
/// Mercator, so a plain stretch is the correct projection.
final class RadarOverlayRenderer: MKOverlayRenderer {
    var image: UIImage? { didSet { setNeedsDisplay() } }

    override func canDraw(_ mapRect: MKMapRect, zoomScale: MKZoomScale) -> Bool { image != nil }

    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        guard let image else { return }
        let rect = self.rect(for: overlay.boundingMapRect)
        UIGraphicsPushContext(context)
        image.draw(in: rect, blendMode: .normal, alpha: 0.75)
        UIGraphicsPopContext()
    }
}
