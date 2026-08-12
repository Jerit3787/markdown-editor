// Clones rather than mutates the live rendered SVG — this is called on
// the element still sitting in the editor's preview pane. An SVG
// embedded in an HTML page doesn't need an explicit xmlns to render, but
// a standalone .svg file (or a copy-pasted fragment) does to be valid on
// its own.
export function svgOuterHtmlForExport(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute("xmlns")) {
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  return clone.outerHTML;
}

export function pngBlobFromSvg(svg: SVGSVGElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const width = svg.width.baseVal.value || svg.viewBox.baseVal.width || 800;
    const height = svg.height.baseVal.value || svg.viewBox.baseVal.height || 600;
    const svgBlob = new Blob([svgOuterHtmlForExport(svg)], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas 2D context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (blob) resolve(blob);
        else reject(new Error("Canvas toBlob failed"));
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load SVG as image"));
    };
    img.src = url;
  });
}
