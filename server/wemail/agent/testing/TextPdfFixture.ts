function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function buildTextPdf(lines: string[]): Uint8Array {
  return buildTextPdfPages([lines]);
}

export function buildTextPdfPages(pages: string[][]): Uint8Array {
  if (pages.length === 0) {
    throw new Error("text-pdf-requires-at-least-one-page");
  }
  const pageObjectIds = pages.map((_, index) => 3 + index);
  const fontObjectId = 3 + pages.length;
  const contentObjectIds = pages.map(
    (_, index) => fontObjectId + 1 + index,
  );
  const commands = pages.map((lines) =>
    [
      "BT",
      "/F1 12 Tf",
      "72 720 Td",
      ...lines.flatMap((line, index) => [
        ...(index === 0 ? [] : ["0 -18 Td"]),
        `(${escapePdfText(line)}) Tj`,
      ]),
      "ET",
    ].join("\n")
  );
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ...pageObjectIds.map((_, index) =>
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...commands.map((command) =>
      `<< /Length ${Buffer.byteLength(command, "ascii")} >>\nstream\n${command}\nendstream`
    ),
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}
