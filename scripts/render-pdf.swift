// render-pdf.swift — rasterize every page of a PDF to PNG with macOS PDFKit (no Homebrew/poppler needed).
// Usage: swift scripts/render-pdf.swift <file.pdf> <out-dir> [width=1400]   → <out-dir>/p01.png …
// Use for PDFs the Read tool refuses (>100 MB) or image-only PDFs markitdown returns EMPTY for (R-17);
// put output in <docs>/_rendered/<name>/ and Read only the pages you need.
import PDFKit
import AppKit
let a = CommandLine.arguments
try? FileManager.default.createDirectory(atPath: a[2], withIntermediateDirectories: true)
guard let doc = PDFDocument(url: URL(fileURLWithPath: a[1])) else { print("open failed"); exit(1) }
let outDir = a[2]; let targetW: CGFloat = CGFloat(Double(a[3]) ?? 1400)
for i in 0..<doc.pageCount {
  guard let p = doc.page(at: i) else { continue }
  let r = p.bounds(for: .mediaBox); let s = targetW / r.width
  let w = Int(r.width * s), h = Int(r.height * s)
  guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let ctx = NSGraphicsContext(bitmapImageRep: rep) else { continue }
  let cg = ctx.cgContext
  cg.setFillColor(NSColor.white.cgColor); cg.fill(CGRect(x: 0, y: 0, width: w, height: h))
  cg.scaleBy(x: s, y: s); cg.translateBy(x: -r.origin.x, y: -r.origin.y)
  p.draw(with: .mediaBox, to: cg)
  let name = String(format: "%@/p%02d.png", outDir, i + 1)
  try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: name))
}
print("pages", doc.pageCount)
