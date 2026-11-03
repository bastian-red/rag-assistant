/**
 * The smallest real PDFs the parser can be tested on, built in code so no
 * binary fixture lives in the repo.
 *
 * Each page is either text (Helvetica, one `Tj` per line) or `null`: a grey
 * rectangle and no text operators at all, which is exactly what a scanned
 * page looks like to a text extractor. The xref offsets are computed from the
 * bytes written, so pdf.js reads the file without a repair pass.
 */
export function makePdf(pages: readonly (string | null)[]): Buffer {
  const objects: (string | null)[] = [];
  const add = (body: string | null) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pagesId = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const page of pages) {
    const ops =
      page === null
        ? '0.5 g 72 72 300 300 re f'
        : `BT /F1 12 Tf 72 720 Td 14 TL ${page
            .split('\n')
            .map((line) => `(${line.replace(/[\\()]/gu, (c) => `\\${c}`)}) Tj T*`)
            .join(' ')} ET`;
    const content = add(
      `<< /Length ${String(Buffer.byteLength(ops, 'latin1'))} >>\nstream\n${ops}\nendstream`,
    );
    kids.push(
      add(
        `<< /Type /Page /Parent ${String(pagesId)} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${String(font)} 0 R >> >> /Contents ${String(content)} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${String(pagesId)} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${String(k)} 0 R`).join(' ')}] /Count ${String(kids.length)} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${String(index + 1)} 0 obj\n${body ?? ''}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out +=
    `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalog)} 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
